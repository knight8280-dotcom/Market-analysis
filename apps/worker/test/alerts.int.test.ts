import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OWNER_USER_ID } from "@market/config";
import { sql } from "@market/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ResendMailer } from "../src/mail";
import { harness, type Harness } from "./helpers/context";

/**
 * Alert evaluation and delivery (Phase 1 steps I2 and I3) against a real database, with a local
 * HTTP server standing in for Resend's API.
 */
const OTHER_USER = "00000000-0000-0000-0000-0000000000ff";
const TO = "owner@test.invalid";

interface Captured {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: { from: string; to: string[]; subject: string; text: string };
}
let server: Server;
let received: Captured[] = [];
let failNext = 0;
let h: Harness;
let baseUrl: string;

async function bar(ticker: string, date: string, close: number) {
  await sql`
    insert into market.prices_daily (security_id, date, source, open, high, low, close, volume)
    select security_id, ${date}::date, 'synthetic', ${close}, ${close}, ${close}, ${close}, 1000
    from market.securities where ticker = ${ticker}
    on conflict (security_id, date, source) do update set close = excluded.close,
      open = excluded.open, high = excluded.high, low = excluded.low
  `.execute(h.t.db);
}

async function alert(
  ticker: string,
  kind: string,
  params: unknown,
  opts: { user?: string; active?: boolean; cooldown?: number } = {},
): Promise<string> {
  const r = await sql<{ alert_id: string }>`
    insert into public.alerts (user_id, security_id, kind, params, active, cooldown_hours)
    select ${opts.user ?? OWNER_USER_ID}, security_id, ${kind}, ${JSON.stringify(params)}::jsonb,
      ${opts.active ?? true}, ${opts.cooldown ?? 24}
    from market.securities where ticker = ${ticker}
    returning alert_id::text
  `.execute(h.t.db);
  return r.rows[0]!.alert_id;
}

const events = () =>
  sql<{
    alert_id: string;
    bar_date: string;
    delivery_status: string;
    error: string | null;
    message: string;
  }>`
    select alert_id::text, bar_date, delivery_status, error, message from public.alert_events
    order by event_id
  `
    .execute(h.t.db)
    .then((r) => r.rows);

const deliver = (dailyCap = 20, mailer = true) => {
  h.ctx.alertDelivery = {
    mailer: mailer ? new ResendMailer({ apiKey: "re_test_key", baseUrl }) : null,
    to: TO,
    from: "Market Analysis <onboarding@resend.dev>",
    dailyCap,
  };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (failNext > 0) {
        failNext--;
        res.writeHead(500);
        res.end(JSON.stringify({ name: "internal_server_error", message: "try again" }));
        return;
      }
      received.push({
        url: req.url,
        headers: req.headers,
        body: JSON.parse(data) as Captured["body"],
      });
      res.writeHead(200);
      res.end(JSON.stringify({ id: `email-${received.length}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // 19:00 EDT on Wednesday 2026-09-30.
  h = await harness({ now: "2026-09-30T23:00:00Z" });
  await sql`
    with s as (
      insert into market.securities (ticker, name, asset_class)
      values ('TEST_ALERT', 'Alert Test Corp', 'equity'), ('TEST_ALSPLIT', 'Split Test Corp', 'equity')
      returning security_id, ticker
    )
    insert into market.provider_symbols (security_id, source, source_symbol, valid_from)
    select security_id, 'synthetic', ticker, '2020-01-02' from s
  `.execute(h.t.db);
  // TEST_ALSPLIT split 4:1 effective 2026-09-30: 400 then 99 is a 1% fall, not 75%.
  await sql`
    insert into market.adjustment_factors (security_id, ex_date, split_factor, dividend_factor)
    select security_id, '2026-09-30', 0.25, 1 from market.securities where ticker = 'TEST_ALSPLIT'
  `.execute(h.t.db);
  await bar("TEST_ALERT", "2026-09-29", 99);
  await bar("TEST_ALERT", "2026-09-30", 101);
  await bar("TEST_ALSPLIT", "2026-09-29", 400);
  await bar("TEST_ALSPLIT", "2026-09-30", 99);
  await sql`
    insert into market.earnings_events (security_id, source, report_date, hour, fetched_at)
    select security_id, 'finnhub', '2026-10-05', 'amc', now()
    from market.securities where ticker = 'TEST_ALERT'
  `.execute(h.t.db);
});

afterAll(async () => {
  server.close();
  await h.t.drop();
});

beforeEach(() => {
  received = [];
  failNext = 0;
  deliver();
});

describe("evaluate-alerts", () => {
  let crossing: string;

  it("fires met conditions, emails the owner and suppresses other users", async () => {
    crossing = await alert("TEST_ALERT", "price_above", { price: 100 });
    await alert("TEST_ALSPLIT", "pct_move", { pct: 0.05, direction: "down" });
    await alert("TEST_ALSPLIT", "price_below", { price: 150 });
    await alert("TEST_ALERT", "earnings_upcoming", { days: 7 });
    await alert("TEST_ALERT", "price_above", { price: 100 }, { active: false });
    await alert("TEST_ALERT", "price_above", { price: 100 }, { user: OTHER_USER });

    const result = (await h.run("evaluate-alerts")) as Record<string, unknown>;
    expect(result).toMatchObject({
      evaluated: 5,
      fired: 3,
      notMet: 2,
      delivery: { sent: 2, suppressed: 1, failed: 0 },
    });

    const stored = await events();
    expect(stored.map((e) => [e.bar_date, e.delivery_status])).toEqual([
      ["2026-09-30", "sent"],
      ["2026-10-05", "sent"],
      ["2026-09-30", "suppressed"],
    ]);

    expect(received).toHaveLength(2);
    const [price, earnings] = received;
    expect(price!.url).toBe("/emails");
    expect(price!.headers.authorization).toBe("Bearer re_test_key");
    expect(price!.headers["idempotency-key"]).toMatch(/^alert-event-\d+$/);
    expect(price!.body.to).toEqual([TO]);
    expect(price!.body.subject).toBe("[SAMPLE DATA] TEST_ALERT closed above $100.00");
    expect(price!.body.text).toContain(
      "TEST_ALERT closed at $101.00 on Sep 30, 2026, above your level of $100.00",
    );
    expect(price!.body.text).toContain("SAMPLE DATA");
    expect(price!.body.text).toContain("not investment advice");
    expect(earnings!.body.subject).toBe("[SAMPLE DATA] TEST_ALERT reports earnings on Oct 5, 2026");
  });

  it("is idempotent: a second run fires and sends nothing new", async () => {
    const result = (await h.run("evaluate-alerts")) as Record<string, unknown>;
    // The crossing is still the latest bar, but its event exists (and the cooldown is running).
    expect(result).toMatchObject({ fired: 0, delivery: { sent: 0 } });
    expect(received).toHaveLength(0);
    expect(await events()).toHaveLength(3);
  });

  it("fires once per crossing, and again after a new crossing once the cooldown ends", async () => {
    // Stays above: no crossing.
    h.setNow("2026-10-01T23:00:00Z");
    await bar("TEST_ALERT", "2026-10-01", 103);
    await h.run("evaluate-alerts");
    // Dips below, then crosses again two days after the first event.
    h.setNow("2026-10-02T23:00:00Z");
    await bar("TEST_ALERT", "2026-10-02", 98);
    await h.run("evaluate-alerts");
    h.setNow("2026-10-05T23:00:00Z");
    await bar("TEST_ALERT", "2026-10-05", 100.5);
    await h.run("evaluate-alerts");
    const mine = (await events()).filter((e) => e.alert_id === crossing);
    expect(mine.map((e) => e.bar_date)).toEqual(["2026-09-30", "2026-10-05"]);
    expect(received.map((r) => r.body.subject)).toEqual([
      "[SAMPLE DATA] TEST_ALERT closed above $100.00",
    ]);
  });

  it("holds a crossing inside the cooldown", async () => {
    const slow = await alert("TEST_ALERT", "price_below", { price: 100 }, { cooldown: 72 });
    await sql`update public.alerts set last_fired_at = '2026-10-05T12:00:00Z' where alert_id = ${slow}`.execute(
      h.t.db,
    );
    h.setNow("2026-10-06T23:00:00Z");
    await bar("TEST_ALERT", "2026-10-06", 99);
    const result = (await h.run("evaluate-alerts")) as Record<string, unknown>;
    expect(result).toMatchObject({ cooldown: 1 });
    expect((await events()).filter((e) => e.alert_id === slow)).toEqual([]);
  });

  it("records a failed send, retries it on the next run, and never sends twice", async () => {
    await alert("TEST_ALERT", "price_above", { price: 99.5 }, { cooldown: 0 });
    h.setNow("2026-10-07T23:00:00Z");
    await bar("TEST_ALERT", "2026-10-07", 100);
    failNext = 1;
    await expect(h.run("evaluate-alerts")).rejects.toThrow(
      /1 alert email\(s\) failed: Resend HTTP 500: try again/,
    );
    const failed = (await events()).at(-1)!;
    expect(failed).toMatchObject({ bar_date: "2026-10-07", delivery_status: "failed" });
    expect(failed.error).toContain("Resend HTTP 500");

    const retry = (await h.run("evaluate-alerts")) as Record<string, unknown>;
    expect(retry).toMatchObject({ fired: 0, delivery: { sent: 1, failed: 0 } });
    expect((await events()).at(-1)).toMatchObject({ delivery_status: "sent", error: null });
    expect(received).toHaveLength(1);
    const runs = await sql<{ status: string }>`
      select status from ops.data_ingestion_runs where job_name = 'evaluate-alerts'
      order by run_id desc limit 2
    `.execute(h.t.db);
    expect(runs.rows.map((r) => r.status)).toEqual(["succeeded", "failed"]);
  });

  it("stops emailing at the daily cap and without email settings", async () => {
    await alert("TEST_ALERT", "pct_move", { pct: 0.01, direction: "either" }, { cooldown: 0 });
    await alert("TEST_ALERT", "price_above", { price: 101.5 }, { cooldown: 0 });
    h.setNow("2026-10-08T23:00:00Z");
    await bar("TEST_ALERT", "2026-10-08", 102);
    deliver(1);
    // 100 → 102 also re-crosses the first alert's level, for the owner and the other user.
    const capped = (await h.run("evaluate-alerts")) as Record<string, unknown>;
    expect(capped).toMatchObject({ fired: 4, delivery: { sent: 1, suppressed: 3 } });
    const day = (await events()).filter((e) => e.bar_date === "2026-10-08");
    expect(day.map((e) => [e.delivery_status, e.error])).toEqual([
      ["sent", null],
      ["suppressed", "emails go only to the owner"],
      ["suppressed", "daily cap of 1 emails reached"],
      ["suppressed", "daily cap of 1 emails reached"],
    ]);

    await alert("TEST_ALERT", "price_below", { price: 101 }, { cooldown: 0 });
    h.setNow("2026-10-09T23:00:00Z");
    await bar("TEST_ALERT", "2026-10-09", 100.9);
    deliver(20, false);
    received = [];
    await h.run("evaluate-alerts");
    expect(received).toHaveLength(0);
    expect((await events()).at(-1)).toMatchObject({
      delivery_status: "suppressed",
      error: "email not configured (RESEND_API_KEY, ALERT_EMAIL_TO)",
    });
  });
});
