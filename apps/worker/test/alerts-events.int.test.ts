import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { BAR_KINDS } from "@market/alerts";
import { OWNER_USER_ID } from "@market/config";
import { sql } from "@market/db";
import { SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRequest, WorkerContext } from "../src/context";
import { ResendMailer } from "../src/mail";
import { startRuntime, type Runtime } from "../src/runtime";
import { harness, type Harness } from "./helpers/context";

/**
 * Phase 2 steps E1 to E3 in the worker: the new conditions on stored data; evaluations queued by
 * new bars, filings and screener rebuilds; snoozing; in-app notifications; flags; and delivery
 * through the real queues within 60 seconds of the data arriving (spec §5.14).
 */
const NOW = "2026-09-30T23:00:00Z";
const APP_URL = "https://desk.example-tailnet.ts.net";
const FIXTURES = "../../../packages/market-data/test/fixtures/sec-edgar/";

let h: Harness;
let server: Server;
let baseUrl: string;
let received: { subject: string; text: string }[] = [];

function secProvider() {
  const submissions = readFileSync(
    fileURLToPath(new URL(`${FIXTURES}submissions-CIK0000000042.json`, import.meta.url)),
    "utf8",
  );
  return new SecEdgarProvider({
    appName: "Example Analytics",
    contactEmail: "admin@example.com",
    rateLimiter: { acquire: () => Promise.resolve(0) },
    baseUrl: "https://sec.test",
    fetch: (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return Promise.resolve(
        url.pathname === "/submissions/CIK0000000042.json"
          ? new Response(submissions, { status: 200 })
          : new Response("not found", { status: 404 }),
      );
    },
    sleep: () => Promise.resolve(),
    now: () => new Date(NOW),
  });
}

async function securityId(ticker: string): Promise<string> {
  const r = await sql<{ id: string }>`
    select security_id::text as id from market.securities where ticker = ${ticker}
  `.execute(h.t.db);
  return r.rows[0]!.id;
}

async function addSecurity(ticker: string, cik: string | null = null): Promise<string> {
  const r = await sql<{ id: string }>`
    insert into market.securities (ticker, name, asset_class, cik)
    values (${ticker}, ${`${ticker} Corp`}, 'equity', ${cik})
    returning security_id::text as id
  `.execute(h.t.db);
  return r.rows[0]!.id;
}

/** Bars on consecutive weekdays ending at `end` (the evaluator only uses their order). */
async function bars(ticker: string, closes: number[], end = "2026-09-30", volume = 1000) {
  const days: string[] = [];
  for (let d = new Date(`${end}T00:00:00Z`); days.length < closes.length;) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.unshift(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() - 86_400_000);
  }
  for (const [i, close] of closes.entries()) {
    await sql`
      insert into market.prices_daily (security_id, date, source, open, high, low, close, volume)
      select security_id, ${days[i]}::date, 'synthetic', ${close}, ${close}, ${close}, ${close}, ${volume}
      from market.securities where ticker = ${ticker}
      on conflict (security_id, date, source) do update set close = excluded.close,
        open = excluded.open, high = excluded.high, low = excluded.low
    `.execute(h.t.db);
  }
}

async function alert(
  kind: string,
  params: unknown,
  target: { ticker?: string; screenId?: string },
  opts: { cooldown?: number; createdAt?: string; state?: unknown } = {},
): Promise<string> {
  const r = await sql<{ alert_id: string }>`
    insert into public.alerts
      (user_id, security_id, screen_id, kind, params, cooldown_hours, created_at, state)
    values (
      ${OWNER_USER_ID},
      (select security_id from market.securities where ticker = ${target.ticker ?? null}),
      ${target.screenId ?? null}::bigint,
      ${kind}, ${JSON.stringify(params)}::jsonb, ${opts.cooldown ?? 0},
      ${opts.createdAt ?? NOW}::timestamptz, ${JSON.stringify(opts.state ?? {})}::jsonb)
    returning alert_id::text
  `.execute(h.t.db);
  return r.rows[0]!.alert_id;
}

async function setFlag(key: string, enabled: boolean) {
  await sql`
    insert into ops.feature_flags (key, enabled) values (${key}, ${enabled})
    on conflict (key) do update set enabled = excluded.enabled
  `.execute(h.t.db);
}

const eventsOf = (alertId: string) =>
  sql<{ event_key: string; bar_date: string; message: string }>`
    select event_key, bar_date, message from public.alert_events
    where alert_id = ${alertId} order by event_id
  `
    .execute(h.t.db)
    .then((r) => r.rows);

const notificationOf = (alertId: string) =>
  sql<{ title: string; body: string; href: string | null; read_at: Date | null }>`
    select n.title, n.body, n.href, n.read_at from public.notifications n
    join public.alert_events e using (event_id)
    where e.alert_id = ${alertId} order by n.notification_id desc limit 1
  `
    .execute(h.t.db)
    .then((r) => r.rows[0] ?? null);

/** Runs every queued evaluate-alerts job (and only those) the way the queue would. */
async function runQueuedEvaluations(jobs: JobRequest[]) {
  const results = [];
  for (const job of jobs.filter((j) => j.name === "evaluate-alerts")) {
    results.push(await h.run(job.name, job.data));
  }
  return results;
}

function captureDispatch() {
  const spy = vi.spyOn(h.dispatcher, "dispatch");
  return {
    jobs: () => spy.mock.calls.map(([job]) => job),
    restore: () => spy.mockRestore(),
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(data) as { subject: string; text: string };
      received.push({ subject: body.subject, text: body.text });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `email-${received.length}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  h = await harness({ now: NOW, extraProviders: [secProvider()] });
  h.ctx.alertDelivery = {
    mailer: new ResendMailer({ apiKey: "re_test_key", baseUrl }),
    to: "owner@test.invalid",
    from: "Market Analysis <onboarding@resend.dev>",
    dailyCap: 100,
    appUrl: APP_URL,
  };
  await h.run("ingest-securities", { source: "synthetic" });
  await addSecurity("TEST_IND");
  await addSecurity("TEST_SCR");
  await addSecurity("TEST_FIL", "0000000042");
});

afterAll(async () => {
  server.close();
  await h.t.drop();
});

beforeEach(() => {
  received = [];
});

describe("flags", () => {
  it("leaves the Phase 2 kinds alone until their flag is on", async () => {
    await bars("TEST_IND", [10, 10, 10, 10, 10, 9, 9, 9, 9, 9, 12]);
    const id = await alert(
      "sma_cross",
      { fast: 1, slow: 5, direction: "above" },
      {
        ticker: "TEST_IND",
      },
    );
    const off = (await h.run("evaluate-alerts", { kinds: ["sma_cross"] })) as Record<
      string,
      unknown
    >;
    expect(off).toMatchObject({ evaluated: 1, disabled: 1, fired: 0 });
    expect(await eventsOf(id)).toEqual([]);

    await setFlag("alert_types", true);
    await setFlag("notifications", true);
    const on = (await h.run("evaluate-alerts", {
      trigger: "bars",
      securityIds: [await securityId("TEST_IND")],
      kinds: [...BAR_KINDS],
    })) as Record<string, unknown>;
    expect(on).toMatchObject({ trigger: "bars", evaluated: 1, fired: 1 });
  });
});

describe("moving-average and RSI alerts", () => {
  it("record the crossing once, with a notification and a link to manage the alert", async () => {
    const id = (
      await sql<{ alert_id: string }>`
        select alert_id::text from public.alerts where kind = 'sma_cross'
      `.execute(h.t.db)
    ).rows[0]!.alert_id;
    const [event] = await eventsOf(id);
    expect(event).toMatchObject({ event_key: "2026-09-30", bar_date: "2026-09-30" });
    expect(event!.message).toContain(
      `Manage this alert (snooze, pause or delete): ${APP_URL}/alerts/${id}`,
    );
    expect(event!.message).toContain(`All notifications: ${APP_URL}/notifications`);
    expect(event!.message).toContain(
      "Your alert on TEST_IND: Close crosses above its 5-day average.",
    );

    const note = await notificationOf(id);
    expect(note).toMatchObject({
      title: "TEST_IND closed above its 5-day average",
      href: "/stocks/TEST_IND",
      read_at: null,
    });
    expect(note!.body).toContain("simple moving average of $9.60");
    expect(note!.body).toContain("End-of-day data as of 2026-09-30.");
    expect(note!.body).toContain("SAMPLE DATA");

    const again = (await h.run("evaluate-alerts", { kinds: ["sma_cross"] })) as Record<
      string,
      unknown
    >;
    // Still the latest bar, with no cooldown: the same crossing again, already recorded.
    expect(again).toMatchObject({ fired: 0, duplicate: 1 });
    expect(await eventsOf(id)).toHaveLength(1);
  });

  it("finds an RSI crossing on the adjusted series", async () => {
    const closes = [...Array.from({ length: 30 }, (_, i) => 100 + i), 128, 122, 115];
    await bars("TEST_SCR", closes);
    const id = await alert("rsi_below", { level: 60, period: 14 }, { ticker: "TEST_SCR" });
    await h.run("evaluate-alerts", { kinds: ["rsi_below"] });
    const [event] = await eventsOf(id);
    expect(event?.message).toContain("[SAMPLE DATA] TEST_SCR RSI(14) crossed below 60");
  });
});

describe("evaluation as data arrives", () => {
  it("queues an evaluation after new bars for securities with alerts, and only then", async () => {
    const spy = captureDispatch();
    try {
      await alert("price_above", { price: 1 }, { ticker: "TEST_DIV" });
      const withAlert = (await h.run("ingest-eod", {
        symbol: "TEST_DIV",
        start: "2026-09-28",
        end: "2026-09-30",
        source: "synthetic",
      })) as { runId: string };
      const without = (await h.run("ingest-eod", {
        symbol: "TEST_SPLIT4",
        start: "2026-09-28",
        end: "2026-09-30",
        source: "synthetic",
      })) as { runId: string };
      const queued = spy.jobs().filter((j) => j.name === "evaluate-alerts");
      expect(queued).toEqual([
        {
          name: "evaluate-alerts",
          jobId: `evaluate-alerts/bars/${withAlert.runId}`,
          data: {
            trigger: "bars",
            kinds: [...BAR_KINDS],
            securityIds: [await securityId("TEST_DIV")],
          },
        },
      ]);
      expect(without.runId).not.toBe(withAlert.runId);
    } finally {
      spy.restore();
    }
  });

  it("checks new-filing alerts when a filings refresh stores new filings", async () => {
    // Created before the fixture's 2025 filings were accepted, so all of them are new to it.
    const id = await alert(
      "new_filing",
      { forms: ["10-Q", "8-K"], amendments: true },
      { ticker: "TEST_FIL" },
      { createdAt: "2025-01-01T00:00:00Z" },
    );
    const spy = captureDispatch();
    try {
      await h.run("ingest-filings", { cik: "42" });
      const queued = spy.jobs().filter((j) => j.name === "evaluate-alerts");
      expect(queued).toHaveLength(1);
      expect(queued[0]!.jobId).toMatch(/^evaluate-alerts\/filings\/\d+$/);
      const [result] = await runQueuedEvaluations(queued);
      expect(result).toMatchObject({ trigger: "filings", evaluated: 1, fired: 1 });
    } finally {
      spy.restore();
    }
    const [event] = await eventsOf(id);
    // The Form 4 is not one of the alert's forms.
    expect(event).toMatchObject({ event_key: "0000000042-25-000010", bar_date: "2025-08-01" });
    expect(event!.message).toContain("[SAMPLE DATA] 3 new TEST_FIL filings: 10-Q, 8-K");
    expect(event!.message).toContain(
      "https://sec.test/Archives/edgar/data/42/000000004225000010/test-20250628.htm",
    );
    expect(event!.message).toContain("Filings: SEC EDGAR (public domain).");
    // Links only ever lead into the app or to www.sec.gov; this stub's host is neither.
    expect(await notificationOf(id)).toMatchObject({
      title: "3 new TEST_FIL filings: 10-Q, 8-K",
      href: null,
    });

    // Refreshing again stores nothing new and fires nothing.
    expect(await h.run("ingest-filings", { cik: "42" })).toMatchObject({ rows_inserted: 0 });
    expect(await h.run("evaluate-alerts", { kinds: ["new_filing"] })).toMatchObject({
      fired: 0,
    });
  });

  it("holds new filings while snoozed and reports them once the snooze ends", async () => {
    const id = (
      await sql<{ alert_id: string }>`
        select alert_id::text from public.alerts where kind = 'new_filing'
      `.execute(h.t.db)
    ).rows[0]!.alert_id;
    await sql`
      update public.alerts set snoozed_until = '2026-10-01T12:00:00Z' where alert_id = ${id}
    `.execute(h.t.db);
    await sql`
      insert into market.filings (accession_no, cik, form_type, filed_at, filing_date, url, source)
      values ('0000000042-26-000001', '0000000042', '8-K', '2026-09-30T20:10:00Z', '2026-09-30',
        'https://www.sec.gov/Archives/edgar/data/42/000000004226000001/test-8k.htm', 'sec_edgar')
    `.execute(h.t.db);
    expect(await h.run("evaluate-alerts", { kinds: ["new_filing"] })).toMatchObject({
      snoozed: 1,
      fired: 0,
    });
    expect(await eventsOf(id)).toHaveLength(1);

    h.setNow("2026-10-01T12:00:01Z");
    try {
      expect(await h.run("evaluate-alerts", { kinds: ["new_filing"] })).toMatchObject({
        fired: 1,
      });
    } finally {
      h.setNow(NOW);
    }
    expect((await eventsOf(id)).at(-1)?.event_key).toBe("0000000042-26-000001");
    expect(await notificationOf(id)).toMatchObject({
      title: "New TEST_FIL filing: 8-K",
      href: "https://www.sec.gov/Archives/edgar/data/42/000000004226000001/test-8k.htm",
    });
  });

  it("compares a saved screen's results after each screener rebuild", async () => {
    const screen = await sql<{ screen_id: string }>`
      insert into public.saved_screens (user_id, name, definition)
      values (${OWNER_USER_ID}, 'Above 112', ${JSON.stringify({
        conditions: [
          { field: "ticker", op: "in", value: ["TEST_IND", "TEST_SCR"] },
          { field: "close", op: "gt", value: 112 },
        ],
        sort: { field: "ticker", dir: "asc" },
      })}::jsonb)
      returning screen_id::text
    `.execute(h.t.db);
    const screenId = screen.rows[0]!.screen_id;
    const id = await alert("screen_membership", { change: "either" }, { screenId });

    const rebuild = async () => {
      const spy = captureDispatch();
      try {
        await h.run("refresh-screener");
        return await runQueuedEvaluations(spy.jobs());
      } finally {
        spy.restore();
      }
    };
    // TEST_SCR closed at 115: in. TEST_IND at 12: out. The first results are the baseline.
    expect(await rebuild()).toEqual([
      expect.objectContaining({ trigger: "screener", baseline: 1, fired: 0 }),
    ]);
    await bars("TEST_SCR", [111], "2026-10-01");
    await bars("TEST_IND", [113], "2026-10-01");
    expect(await rebuild()).toEqual([expect.objectContaining({ fired: 1 })]);
    const [event] = await eventsOf(id);
    expect(event!.bar_date).toBe("2026-10-01");
    expect(event!.message).toContain("[SAMPLE DATA] Screen “Above 112”: 1 entered, 1 left");
    expect(event!.message).toContain("Entered: TEST_IND.\nLeft: TEST_SCR.");
    expect(event!.message).toContain("Screener snapshot as of 2026-10-01");
    expect(event!.message).toContain("Your alert on screen “Above 112”: A security enters or");
    expect(await notificationOf(id)).toMatchObject({ href: `/screener?saved=${screenId}` });

    // The same results again: nothing to report.
    expect(await rebuild()).toEqual([expect.objectContaining({ fired: 0, notMet: 1 })]);
  });

  it("writes no notification while the notifications flag is off", async () => {
    await setFlag("notifications", false);
    try {
      const id = await alert("price_below", { price: 112 }, { ticker: "TEST_SCR" });
      await h.run("evaluate-alerts", { kinds: ["price_below"] });
      const [event] = await eventsOf(id);
      expect(event?.message).toContain("TEST_SCR closed below $112.00");
      expect(event?.message).not.toContain("All notifications");
      expect(await notificationOf(id)).toBeNull();
    } finally {
      await setFlag("notifications", true);
    }
  });
});

describe("delivery through the queues", () => {
  const redisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
  const connections: Redis[] = [];
  let runtime: Runtime;

  beforeAll(() => {
    const { dispatch: _, ...base } = h.ctx;
    runtime = startRuntime(base satisfies Omit<WorkerContext, "dispatch">, {
      connection: () => {
        const r = new Redis(redisUrl, { maxRetriesPerRequest: null });
        connections.push(r);
        return r;
      },
      prefix: `test-${randomUUID()}`,
    });
  });
  afterAll(async () => {
    await runtime.close();
    for (const r of connections) r.disconnect();
  });

  it("emails a crossing within 60 seconds of the bar arriving (spec §5.14)", async ({
    annotate,
  }) => {
    // The synthetic vendor closes TEST_S002 at 90.98, then 90.55: a fall through 90.77.
    const symbol = "TEST_S002";
    await h.run("ingest-eod", {
      symbol,
      start: "2026-09-01",
      end: "2026-09-29",
      source: "synthetic",
    });
    const [next] = await h.synthetic.getDailyBars({
      symbol,
      start: "2026-09-30",
      end: "2026-09-30",
    });
    const prev = await sql<{ close: number }>`
      select close::float8 as close from market.prices_daily p
      join market.securities s using (security_id)
      where s.ticker = ${symbol} and p.date = '2026-09-29'
    `.execute(h.t.db);
    const before = prev.rows[0]!.close;
    const after = Number(next!.close);
    expect(after).not.toBe(before);
    const kind = after > before ? "price_above" : "price_below";
    const level = Math.round(((before + after) / 2) * 100) / 100;
    await alert(kind, { price: level }, { ticker: symbol });

    // Data arrives: the vendor's bar is fetched and stored by the queued ingest job.
    const started = Date.now();
    await runtime.dispatcher.dispatch({
      name: "ingest-eod",
      data: { symbol, start: "2026-09-30", end: "2026-09-30", source: "synthetic" },
      jobId: `ingest-eod/latency/${randomUUID()}`,
    });
    const word = kind === "price_above" ? "above" : "below";
    const deadline = started + 60_000;
    let email: { subject: string } | undefined;
    while (!email && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      email = received.find((e) => e.subject.startsWith(`[SAMPLE DATA] ${symbol} closed ${word}`));
    }
    const elapsed = Date.now() - started;
    expect(email, `no email after ${elapsed} ms`).toBeTruthy();
    expect(elapsed).toBeLessThan(60_000);
    await annotate(`emailed ${elapsed} ms after the ingest job was queued`);
  });
});
