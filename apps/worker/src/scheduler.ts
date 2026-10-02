import { latestClosedSession, marketDateOf, zonedParts } from "@market/calendar";
import type { JobRequest } from "./context";
import { JOBS, jobId } from "./queues";

/**
 * Calendar-driven schedule (spec §3.4: "drive schedules from the market calendar, not naive
 * cron"). `dueJobs` is pure: given the time it returns every job that should exist by then.
 * Job ids are deterministic, so the scheduler can call it on every tick and re-dispatching an
 * existing job is a no-op.
 */

export interface ScheduleConfig {
  /** Minutes after the close before EOD bars are requested (vendors publish after the close). */
  eodDelayMinutes: number;
  /** Exchange-time HH:MM for daily jobs. */
  reconcileAt: string;
  partitionsAt: string;
  macroAt: string;
  /** EDGAR sweeps run off-peak (SEC asks for bulk work outside business hours). */
  edgarAt: string;
  /** Form 4 documents the evening's filings refresh did not read (after edgarAt). */
  insidersAt: string;
  /** A look at SEC's 13F data set listing (one request), reading any new data set. */
  form13fAt: string;
  /** After the 18:30 end-of-day deadline, so the snapshot sees the full session. */
  screenerAt: string;
  /** Earnings and economic calendars, refreshed before the open. */
  calendarsAt: string;
  /** Alert evaluation, after the end-of-day deadline and the screener. */
  alertsAt: string;
  reconcileDays: number;
  edgarEnabled: boolean;
  earningsEnabled: boolean;
  releasesEnabled: boolean;
  macroSeries: readonly string[];
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  eodDelayMinutes: 30,
  reconcileAt: "02:00",
  partitionsAt: "03:00",
  macroAt: "18:00",
  edgarAt: "21:00",
  insidersAt: "22:30",
  form13fAt: "23:00",
  screenerAt: "18:45",
  calendarsAt: "06:30",
  alertsAt: "18:50",
  reconcileDays: 5,
  edgarEnabled: false,
  earningsEnabled: false,
  releasesEnabled: false,
  macroSeries: [],
};

function minutesOfDay(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export function dueJobs(now: Date, cfg: ScheduleConfig = DEFAULT_SCHEDULE): JobRequest[] {
  const jobs: JobRequest[] = [];
  const et = zonedParts(now);
  const etMinutes = et.hour * 60 + et.minute;
  const today = marketDateOf(now);
  const minute = now.toISOString().slice(0, 16);

  jobs.push({
    name: JOBS.stalenessMonitor,
    data: {},
    jobId: jobId(JOBS.stalenessMonitor, minute.replace(":", "")),
  });

  // The latest session that closed at least eodDelayMinutes ago (early closes included).
  const eodSession = latestClosedSession(new Date(now.getTime() - cfg.eodDelayMinutes * 60_000));
  jobs.push({
    name: JOBS.scheduleEod,
    data: { date: eodSession.date },
    jobId: jobId(JOBS.scheduleEod, eodSession.date),
  });

  if (etMinutes >= minutesOfDay(cfg.reconcileAt)) {
    const through = latestClosedSession(now).date;
    jobs.push({
      name: JOBS.reconcileEod,
      data: { through, days: cfg.reconcileDays },
      jobId: jobId(JOBS.reconcileEod, today),
    });
  }
  if (etMinutes >= minutesOfDay(cfg.partitionsAt)) {
    jobs.push({
      name: JOBS.ensurePartitions,
      data: {},
      jobId: jobId(JOBS.ensurePartitions, today),
    });
  }
  if (etMinutes >= minutesOfDay(cfg.macroAt)) {
    for (const seriesId of cfg.macroSeries) {
      jobs.push({
        name: JOBS.ingestMacro,
        data: { seriesId },
        jobId: jobId(JOBS.ingestMacro, today, seriesId),
      });
    }
  }
  if (etMinutes >= minutesOfDay(cfg.calendarsAt)) {
    if (cfg.earningsEnabled) {
      jobs.push({ name: JOBS.ingestEarnings, data: {}, jobId: jobId(JOBS.ingestEarnings, today) });
    }
    if (cfg.releasesEnabled) {
      jobs.push({ name: JOBS.ingestReleases, data: {}, jobId: jobId(JOBS.ingestReleases, today) });
    }
  }
  if (etMinutes >= minutesOfDay(cfg.screenerAt)) {
    jobs.push({ name: JOBS.refreshScreener, data: {}, jobId: jobId(JOBS.refreshScreener, today) });
  }
  if (etMinutes >= minutesOfDay(cfg.alertsAt)) {
    jobs.push({ name: JOBS.evaluateAlerts, data: {}, jobId: jobId(JOBS.evaluateAlerts, today) });
  }
  if (cfg.edgarEnabled && etMinutes >= minutesOfDay(cfg.edgarAt)) {
    jobs.push({ name: JOBS.scheduleEdgar, data: {}, jobId: jobId(JOBS.scheduleEdgar, today) });
  }
  if (cfg.edgarEnabled && etMinutes >= minutesOfDay(cfg.insidersAt)) {
    jobs.push({ name: JOBS.sweepInsiders, data: {}, jobId: jobId(JOBS.sweepInsiders, today) });
  }
  if (cfg.edgarEnabled && etMinutes >= minutesOfDay(cfg.form13fAt)) {
    jobs.push({ name: JOBS.schedule13f, data: {}, jobId: jobId(JOBS.schedule13f, today) });
  }
  return jobs;
}
