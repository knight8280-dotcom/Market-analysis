import type { IsoDate } from "@market/calendar";
import type { AppEnv } from "@market/config";
import type { Database } from "@market/db";
import type {
  Dataset,
  MarketDataProvider,
  ProviderId,
  RoutingEvent,
  RoutingTable,
} from "@market/market-data";
import type { Logger } from "./log";
import type { JobName } from "./queues";

export type WorkerEvent =
  | RoutingEvent
  | { type: "adjustments_recomputed"; securityId: string; at: Date }
  | {
      type: "alert_opened" | "alert_resolved";
      kind: string;
      dataset: string;
      source: ProviderId | null;
      at: Date;
    };

export interface EventSink {
  emit(event: WorkerEvent): void | Promise<void>;
}

export interface JobRequest {
  name: JobName;
  data: Record<string, unknown>;
  jobId: string;
}

/** Enqueues follow-up work: BullMQ in the worker, an in-memory queue in the CLI and tests. */
export interface Dispatcher {
  dispatch(job: JobRequest): Promise<void>;
}

export interface WorkerContext {
  appEnv: AppEnv;
  db: Database;
  providers: ReadonlyMap<ProviderId, MarketDataProvider>;
  routes: RoutingTable;
  clock: () => Date;
  log: Logger;
  events: EventSink;
  dispatch: Dispatcher;
  /** Id of the job being run, for ingestion run records. */
  jobId?: string;
}

export type DatasetKey = Dataset;
export type { IsoDate };
