import { rsi, sma } from "@market/indicators";
import { compact, dateTimeET, day, fingerprint, formName, money, percent, plain } from "./format";
import type { AlertDefinition, AlertState, ScreenMember } from "./schema";

/** The latest end-of-day bar and the one before it, both in the latest bar's split basis. */
export interface LatestBar {
  date: string;
  close: number;
  prevDate: string | null;
  /** Previous close adjusted for any split between the two sessions; null without one. */
  prevClose: number | null;
}

export interface UpcomingEarnings {
  date: string;
  /** bmo, amc or dmh when the vendor says. */
  hour: string | null;
}

/** End-of-day sessions in ascending order, ending at the latest bar evaluated. */
export interface DailySeries {
  dates: string[];
  /** Split- and dividend-adjusted closes. */
  close: number[];
  /** Split-adjusted volumes. */
  volume: number[];
}

/** A filing stored for the alert's company, accepted after the alert was created. */
export interface FilingItem {
  accessionNo: string;
  form: string;
  /** EDGAR acceptance time. */
  filedAt: Date;
  filingDate: string;
  url: string;
  /** When our database stored it; filings stored after `state.filingsSeenThrough` are new. */
  storedAt: Date;
}

/** A saved screen's current results on the screener snapshot. */
export interface ScreenResults {
  screenId: string;
  name: string;
  /** Fingerprint of the screen's conditions: a changed screen starts a new comparison. */
  definition: string;
  /** The latest session in the snapshot. */
  asOf: string;
  members: ScreenMember[];
}

export interface EvaluationInput {
  /** The security's ticker (empty for screen alerts). */
  ticker: string;
  bar: LatestBar | null;
  /** The next earnings date after `today`, if known. */
  earnings: UpcomingEarnings | null;
  /** The exchange-calendar date the evaluation runs on. */
  today: string;
  now: Date;
  lastFiredAt: Date | null;
  cooldownHours: number;
  /** The alert stays quiet until then (snoozed from a notification or its page). */
  snoozedUntil?: Date | null;
  /** RSI, moving-average and volume conditions. */
  series?: DailySeries | null;
  /** New-filing conditions; null when the company has no SEC registrant id (CIK). */
  filings?: readonly FilingItem[] | null;
  /** Screen conditions. */
  screen?: ScreenResults | null;
  /** What the alert remembered after its last evaluation. */
  state?: AlertState;
}

export type Evaluation =
  | {
      fire: false;
      reason: "no_data" | "not_met" | "baseline" | "cooldown" | "snoozed";
      /** State to store although nothing fired: a screen's starting point, filings looked at. */
      state?: AlertState;
    }
  | {
      fire: true;
      /**
       * Idempotency key (unique per alert in alert_events): the bar's date for price and
       * indicator conditions, the report date for earnings, the latest accession number for
       * filings, and the snapshot date plus a fingerprint of the results for screens. Each
       * crossing, report, filing or change of results fires at most once.
       */
      key: string;
      /** The date of the data behind the event (alert_events.bar_date). */
      date: string;
      subject: string;
      /** The full message (emails), with figures, dates and any SEC links. */
      text: string;
      /** A shorter message for the in-app notification, when it differs from `text`. */
      summary?: string;
      /** Where the notification leads: an app path, or the SEC page of a filing. */
      href: string | null;
      /** State to store with the event. */
      state?: AlertState;
    };

type Quiet = Extract<Evaluation, { fire: false }>;
type Hit = Omit<Extract<Evaluation, { fire: true }>, "fire">;

const NO_DATA: Quiet = { fire: false, reason: "no_data" };
const NOT_MET: Quiet = { fire: false, reason: "not_met" };

const HOUR: Record<string, string> = {
  bmo: "before the open",
  amc: "after the close",
  dmh: "during market hours",
};

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Computed prices to the cent ("$99.81"); levels the owner typed keep their decimals. */
const cents = (n: number) => money(Number(n.toFixed(2)));
const stockPath = (ticker: string) => `/stocks/${encodeURIComponent(ticker)}`;
const known = (v: number | null | undefined): v is number => v !== null && v !== undefined;

/** "A, B, C, … and 12 more" */
function tickers(members: readonly ScreenMember[], max = 30): string {
  const shown = members.slice(0, max).map((m) => m.ticker);
  const more = members.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/**
 * Whether an alert fires. Pure: the worker supplies the data and records the result.
 *
 * Level conditions (price, RSI, moving averages) fire on a crossing only, so a value that stays
 * past a level fires once, not every day; the cooldown then keeps a value hovering around the
 * level from firing repeatedly. Daily events (moves, volume spikes) fire for each session that
 * meets them. Filings and screen results compare with what the alert last reported; while an
 * alert is snoozed or cooling down, those changes are kept for later rather than dropped.
 */
export function evaluateAlert(def: AlertDefinition, input: EvaluationInput): Evaluation {
  const hit = check(def, input);
  if (!("key" in hit)) return hit;
  if (input.snoozedUntil && input.snoozedUntil.getTime() > input.now.getTime()) {
    return { fire: false, reason: "snoozed" };
  }
  if (
    input.lastFiredAt &&
    input.now.getTime() - input.lastFiredAt.getTime() < input.cooldownHours * 3_600_000
  ) {
    return { fire: false, reason: "cooldown" };
  }
  return { fire: true, ...hit };
}

function check(def: AlertDefinition, input: EvaluationInput): Hit | Quiet {
  const { ticker, bar } = input;
  switch (def.kind) {
    case "price_above":
    case "price_below": {
      if (!bar || bar.prevClose === null) return NO_DATA;
      const level = def.params.price;
      const above = def.kind === "price_above";
      const crossed = above
        ? bar.prevClose <= level && bar.close > level
        : bar.prevClose >= level && bar.close < level;
      if (!crossed) return NOT_MET;
      const word = above ? "above" : "below";
      return {
        key: bar.date,
        date: bar.date,
        subject: `${ticker} closed ${word} ${money(level)}`,
        text:
          `${ticker} closed at ${money(bar.close)} on ${day(bar.date)}, ${word} your level of ` +
          `${money(level)} (previous close ${money(bar.prevClose)}).`,
        href: stockPath(ticker),
      };
    }

    case "pct_move": {
      if (!bar || bar.prevClose === null || bar.prevClose <= 0) return NO_DATA;
      const change = bar.close / bar.prevClose - 1;
      const { pct, direction } = def.params;
      // A little tolerance so a move of exactly the threshold counts despite float rounding.
      const eps = 1e-12;
      const met =
        (direction !== "down" && change >= pct - eps) ||
        (direction !== "up" && change <= -pct + eps);
      if (!met) return NOT_MET;
      const verb = change >= 0 ? "rose" : "fell";
      return {
        key: bar.date,
        date: bar.date,
        subject: `${ticker} ${verb} ${percent(change)} on ${day(bar.date)}`,
        text:
          `${ticker} ${verb} ${percent(change, 2)} on ${day(bar.date)}, closing at ` +
          `${money(bar.close)} (previous close ${money(bar.prevClose)}, split-adjusted). ` +
          `Your threshold: ${percent(pct)}.`,
        href: stockPath(ticker),
      };
    }

    case "earnings_upcoming": {
      const e = input.earnings;
      if (!e) return NO_DATA;
      if (!(e.date > input.today && e.date <= addDays(input.today, def.params.days))) {
        return NOT_MET;
      }
      const when = e.hour && HOUR[e.hour] ? ` (${HOUR[e.hour]})` : "";
      return {
        key: e.date,
        date: e.date,
        subject: `${ticker} reports earnings on ${day(e.date)}`,
        text: `${ticker} is scheduled to report earnings on ${day(e.date)}${when}. Dates can move; check the calendar.`,
        href: stockPath(ticker),
      };
    }

    case "rsi_below":
    case "rsi_above": {
      const { level, period } = def.params;
      const s = input.series;
      if (!s || s.close.length < period + 2) return NO_DATA;
      const values = rsi(s.close, period);
      const curr = values.at(-1);
      const prev = values.at(-2);
      if (!known(curr) || !known(prev)) return NO_DATA;
      const below = def.kind === "rsi_below";
      const crossed = below ? prev >= level && curr < level : prev <= level && curr > level;
      if (!crossed) return NOT_MET;
      const date = s.dates.at(-1)!;
      const word = below ? "below" : "above";
      return {
        key: date,
        date,
        subject: `${ticker} RSI(${period}) crossed ${word} ${plain(level)}`,
        text:
          `${ticker}'s ${period}-session RSI closed at ${plain(curr, 1)} on ${day(date)}, ${word} ` +
          `your level of ${plain(level)} (${plain(prev, 1)} the session before). RSI uses ` +
          `Wilder smoothing on split- and dividend-adjusted closes.`,
        href: stockPath(ticker),
      };
    }

    case "sma_cross": {
      const { fast, slow, direction } = def.params;
      const s = input.series;
      if (!s || s.close.length < slow + 1) return NO_DATA;
      const slowAvg = sma(s.close, slow);
      const fastAvg = fast === 1 ? s.close : sma(s.close, fast);
      const [fc, fp, sc, sp] = [fastAvg.at(-1), fastAvg.at(-2), slowAvg.at(-1), slowAvg.at(-2)];
      if (!known(fc) || !known(fp) || !known(sc) || !known(sp)) return NO_DATA;
      const up = direction === "above";
      const crossed = up ? fp <= sp && fc > sc : fp >= sp && fc < sc;
      if (!crossed) return NOT_MET;
      const date = s.dates.at(-1)!;
      return {
        key: date,
        date,
        ...(fast === 1
          ? {
              subject: `${ticker} closed ${direction} its ${slow}-day average`,
              text:
                `${ticker} closed at ${cents(fc)} on ${day(date)}, ${direction} its ${slow}-day ` +
                `simple moving average of ${cents(sc)} (the session before: ${cents(fp)} against ` +
                `${cents(sp)}). Closes adjusted for splits and dividends.`,
            }
          : {
              subject: `${ticker} ${fast}-day average crossed ${direction} the ${slow}-day`,
              text:
                `On ${day(date)}, ${ticker}'s ${fast}-day simple moving average (${cents(fc)}) ` +
                `crossed ${direction} its ${slow}-day average (${cents(sc)}); the session before ` +
                `they were ${cents(fp)} and ${cents(sp)}. Closes adjusted for splits and dividends.`,
            }),
        href: stockPath(ticker),
      };
    }

    case "volume_spike": {
      const { multiple, lookback } = def.params;
      const s = input.series;
      if (!s || s.volume.length < lookback + 1) return NO_DATA;
      const volume = s.volume.at(-1)!;
      const average = s.volume.slice(-1 - lookback, -1).reduce((a, b) => a + b, 0) / lookback;
      if (!(average > 0)) return NO_DATA;
      const ratio = volume / average;
      if (ratio < multiple - 1e-12) return NOT_MET;
      const date = s.dates.at(-1)!;
      return {
        key: date,
        date,
        subject: `${ticker} volume ${plain(ratio, 1)}× its ${lookback}-day average`,
        text:
          `${ticker} traded ${compact(volume)} shares on ${day(date)}, ${plain(ratio, 1)} times ` +
          `its average of ${compact(average)} over the previous ${lookback} sessions ` +
          `(split-adjusted). Your threshold: ${plain(multiple)}×.`,
        href: stockPath(ticker),
      };
    }

    case "new_filing": {
      // Null: the company has no SEC registrant id, so its filings cannot be followed.
      if (!input.filings) return NO_DATA;
      const seen = input.state?.filingsSeenThrough
        ? Date.parse(input.state.filingsSeenThrough)
        : -Infinity;
      const fresh = input.filings.filter((f) => f.storedAt.getTime() > seen);
      if (fresh.length === 0) return NOT_MET;
      const state: AlertState = {
        ...input.state,
        filingsSeenThrough: new Date(
          Math.max(...fresh.map((f) => f.storedAt.getTime())),
        ).toISOString(),
      };
      const forms = new Set(def.params.forms);
      const matches = fresh
        .filter(
          (f) =>
            forms.has(f.form) ||
            (def.params.amendments && f.form.endsWith("/A") && forms.has(f.form.slice(0, -2))),
        )
        .sort(
          (a, b) =>
            a.filedAt.getTime() - b.filedAt.getTime() || a.accessionNo.localeCompare(b.accessionNo),
        );
      // Other forms were looked at and are not news: remember that, so they are not re-read.
      if (matches.length === 0) return { fire: false, reason: "not_met", state };
      const latest = matches.at(-1)!;
      const shown = matches.slice(-20);
      const omitted = matches.length - shown.length;
      const line = (f: FilingItem) => `${formName(f.form)}, accepted ${dateTimeET(f.filedAt)}`;
      const names = [...new Set(matches.map((f) => formName(f.form)))].join(", ");
      return {
        key: latest.accessionNo,
        date: latest.filingDate,
        subject:
          matches.length === 1
            ? `New ${ticker} filing: ${formName(latest.form)}`
            : `${matches.length} new ${ticker} filings: ${names}`,
        text: [
          `${ticker} filed with the SEC:`,
          ...shown.map((f) => `- ${line(f)}: ${f.url}`),
          ...(omitted > 0 ? [`- and ${omitted} earlier`] : []),
        ].join("\n"),
        summary: [
          `${ticker} filed with the SEC:`,
          ...shown.map((f) => `- ${line(f)}`),
          ...(omitted > 0 ? [`- and ${omitted} earlier`] : []),
        ].join("\n"),
        href: latest.url,
        state,
      };
    }

    case "screen_membership": {
      const results = input.screen;
      if (!results) return NO_DATA;
      const members = [...results.members].sort(
        (a, b) => a.ticker.localeCompare(b.ticker) || a.securityId.localeCompare(b.securityId),
      );
      const current: AlertState = {
        ...input.state,
        screen: { definition: results.definition, asOf: results.asOf, members },
      };
      const previous = input.state?.screen;
      // No starting point, or the screen's conditions changed: these results are the new one.
      if (!previous || previous.definition !== results.definition) {
        return { fire: false, reason: "baseline", state: current };
      }
      const before = new Set(previous.members.map((m) => m.securityId));
      const after = new Set(members.map((m) => m.securityId));
      const entered = members.filter((m) => !before.has(m.securityId));
      const left = previous.members.filter((m) => !after.has(m.securityId));
      const { change } = def.params;
      const shownEntered = change === "leaves" ? [] : entered;
      const shownLeft = change === "enters" ? [] : left;
      if (shownEntered.length + shownLeft.length === 0) {
        // Changes the alert does not watch still move the starting point forward.
        return entered.length + left.length > 0
          ? { fire: false, reason: "not_met", state: current }
          : NOT_MET;
      }
      const ids = members
        .map((m) => m.securityId)
        .sort()
        .join(",");
      const counts = [
        shownEntered.length ? `${shownEntered.length} entered` : null,
        shownLeft.length ? `${shownLeft.length} left` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const size = `${members.length} ${members.length === 1 ? "result" : "results"}`;
      return {
        key: `${results.asOf}:${fingerprint(ids)}`,
        date: results.asOf,
        subject: `Screen “${results.name}”: ${counts}`,
        text: [
          `As of ${day(results.asOf)}, your saved screen “${results.name}” has ${size}.`,
          ...(shownEntered.length ? [`Entered: ${tickers(shownEntered)}.`] : []),
          ...(shownLeft.length ? [`Left: ${tickers(shownLeft)}.`] : []),
        ].join("\n"),
        href: `/screener?saved=${encodeURIComponent(results.screenId)}`,
        state: current,
      };
    }
  }
}
