import { createTestDatabase, type TestDatabase } from "@market/db/testing";
import {
  BaseProvider,
  buildRoutingTable,
  ProviderError,
  type MarketDataProvider,
  type ProviderId,
} from "@market/market-data";
import { SyntheticProvider } from "@market/market-data/adapters/synthetic";
import type { WorkerContext, WorkerEvent } from "../../src/context";
import { InlineDispatcher } from "../../src/dispatch";
import { runJob } from "../../src/jobs/index";
import { createLogger } from "../../src/log";
import type { JobName } from "../../src/queues";

export const TEMPLATE = "tmpl_worker";

/** A primary provider that can be switched between failing and healthy. */
export class StubPrimary extends BaseProvider {
  readonly id: ProviderId = "tiingo";
  failing = true;
  constructor(private readonly delegate: SyntheticProvider) {
    super();
  }
  private gate<T>(fn: () => Promise<T>): Promise<T> {
    return this.failing
      ? Promise.reject(
          new ProviderError("tiingo", "HTTP 503 from stub primary", {
            status: 503,
            retryable: true,
          }),
        )
      : fn();
  }
  override getDailyBars(req: Parameters<MarketDataProvider["getDailyBars"]>[0]) {
    return this.gate(() => this.delegate.getDailyBars(req));
  }
  override getCorporateActions(req: Parameters<MarketDataProvider["getCorporateActions"]>[0]) {
    return this.gate(() => this.delegate.getCorporateActions(req));
  }
  override healthCheck() {
    return this.gate(() => Promise.resolve());
  }
}

export interface Harness {
  t: TestDatabase;
  ctx: WorkerContext;
  events: WorkerEvent[];
  dispatcher: InlineDispatcher;
  synthetic: SyntheticProvider;
  setNow(iso: string): void;
  run(name: JobName, data?: Record<string, unknown>): Promise<unknown>;
  drain(): Promise<{ ran: number; failed: number }>;
}

export async function harness(opts: {
  universeSize?: number;
  now?: string;
  primary?: ProviderId;
  fallback?: ProviderId | null;
  extraProviders?: MarketDataProvider[];
}): Promise<Harness> {
  const t = await createTestDatabase(TEMPLATE);
  let now = new Date(opts.now ?? "2026-09-30T12:00:00Z");
  const clock = () => now;
  const synthetic = new SyntheticProvider({ universeSize: opts.universeSize ?? 20, now: clock });
  const providers = new Map<ProviderId, MarketDataProvider>([["synthetic", synthetic]]);
  for (const p of opts.extraProviders ?? []) providers.set(p.id, p);
  const events: WorkerEvent[] = [];
  const dispatcher = new InlineDispatcher();
  const ctx: WorkerContext = {
    appEnv: "test",
    db: t.db,
    providers,
    routes: buildRoutingTable({
      primary: opts.primary ?? "synthetic",
      fallback: opts.fallback ?? null,
    }),
    clock,
    log: createLogger("silent"),
    events: { emit: (e) => void events.push(e) },
    dispatch: dispatcher,
  };
  return {
    t,
    ctx,
    events,
    dispatcher,
    synthetic,
    setNow(iso) {
      now = new Date(iso);
    },
    run: (name, data = {}) => runJob(ctx, name, data),
    drain: () =>
      dispatcher.drain(
        (job) => runJob({ ...ctx, jobId: job.jobId }, job.name, job.data),
        () => {},
      ),
  };
}
