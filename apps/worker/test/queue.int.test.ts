import { randomUUID } from "node:crypto";
import { ProviderError } from "@market/market-data";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerContext } from "../src/context";
import { createLogger } from "../src/log";
import { QUEUES, type JobName } from "../src/queues";
import { startRuntime, type Runtime } from "../src/runtime";

const redisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const connections: Redis[] = [];
const connection = () => {
  const r = new Redis(redisUrl, { maxRetriesPerRequest: null });
  connections.push(r);
  return r;
};

const calls: { name: JobName; data: unknown }[] = [];
let runtime: Runtime;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(() => {
  const base = {
    appEnv: "test",
    db: undefined as never,
    providers: new Map(),
    routes: undefined as never,
    clock: () => new Date(),
    log: createLogger("silent"),
    events: { emit: () => {} },
  } satisfies Omit<WorkerContext, "dispatch">;
  runtime = startRuntime(base, {
    connection,
    prefix: `test-${randomUUID()}`,
    jobOptions: { attempts: 3, backoff: { type: "fixed", delay: 10 } },
    run: (_ctx, name, data) => {
      calls.push({ name, data });
      const kind = (data as { kind?: string }).kind;
      if (kind === "flaky") return Promise.reject(new Error("transient"));
      if (kind === "fatal")
        return Promise.reject(
          new ProviderError("tiingo", "HTTP 404", { status: 404, retryable: false }),
        );
      return Promise.resolve({ ok: true });
    },
  });
});

afterAll(async () => {
  await runtime.close();
  for (const r of connections) r.disconnect();
});

const deadLetter = (): Queue => runtime.queues.get(QUEUES.deadLetter)!;

describe("BullMQ runtime", () => {
  it("runs a job id once no matter how often it is dispatched", async () => {
    const job = {
      name: "ingest-eod" as const,
      data: { kind: "ok", n: 1 },
      jobId: "ingest-eod/2026-09-29/TEST_A",
    };
    await runtime.dispatcher.dispatch(job);
    await runtime.dispatcher.dispatch(job);
    await runtime.dispatcher.dispatch(job);
    const queue = runtime.queues.get(QUEUES.eod)!;
    await waitFor(async () => (await queue.getJobCounts("completed")).completed === 1);
    expect(calls.filter((c) => (c.data as { n?: number }).n === 1)).toHaveLength(1);
  });

  it("retries a failing job, then moves it to the dead-letter queue", async () => {
    await runtime.dispatcher.dispatch({
      name: "ingest-eod",
      data: { kind: "flaky" },
      jobId: "ingest-eod/flaky",
    });
    await waitFor(async () => (await deadLetter().getJobCounts("waiting")).waiting === 1);
    expect(calls.filter((c) => (c.data as { kind?: string }).kind === "flaky")).toHaveLength(3);
    const [dead] = await deadLetter().getJobs(["waiting"]);
    expect(dead!.data).toMatchObject({
      queue: "ingest-eod",
      name: "ingest-eod",
      reason: "transient",
    });
  });

  it("does not retry non-retryable provider errors", async () => {
    await runtime.dispatcher.dispatch({
      name: "ingest-eod",
      data: { kind: "fatal" },
      jobId: "ingest-eod/fatal",
    });
    await waitFor(async () => (await deadLetter().getJobCounts("waiting")).waiting === 2);
    expect(calls.filter((c) => (c.data as { kind?: string }).kind === "fatal")).toHaveLength(1);
  });
});
