import type { IsoDate } from "@market/calendar";
import type { AnthropicClient } from "@market/ai";
import type { AppEnv } from "@market/config";
import type { Database } from "@market/db";
import type { PushSender } from "@market/push";
import type {
  Dataset,
  MarketDataProvider,
  ProviderId,
  RoutingEvent,
  RoutingTable,
} from "@market/market-data";
import type { BacktestRunner } from "./backtest/runner";
import type { Logger } from "./log";
import type { Mailer } from "./mail";
import type { JobName } from "./queues";
import type { Universe } from "./universe";

export type WorkerEvent =
  | RoutingEvent
  | { type: "adjustments_recomputed"; securityId: string; at: Date }
  | { type: "bars_updated"; securityId: string; date: string; source: ProviderId; at: Date }
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
  /** Configured symbols for quota-limited vendors (config/universe.json). */
  universe?: Universe;
  /** Alert email delivery; without it alert events are recorded but not emailed. */
  alertDelivery?: AlertDelivery;
  /** Where backtests run (a worker thread in the worker); in-process when not set. */
  backtests?: BacktestRunner;
  /** AI requests on the owner's Anthropic key; without it nothing is sent anywhere. */
  ai?: AiServices;
}

export interface AiServices {
  client: Pick<AnthropicClient, "createMessage">;
  /** AI_MONTHLY_BUDGET_USD: no request starts that could take the month past it. */
  monthlyBudgetUsd: number;
  sentimentModel: string;
}

export interface AlertDelivery {
  mailer: Mailer | null;
  /** The owner's address (ALERT_EMAIL_TO); null when not configured. */
  to: string | null;
  from: string;
  /** Emails per exchange-calendar day across all alerts. */
  dailyCap: number;
  /** Base of the links in alert emails (APP_BASE_URL); http://localhost:3000 when not set. */
  appUrl?: string;
  /** Web Push to the owner's devices (WEB_PUSH_*); null when not configured. */
  push?: PushSender | null;
}

export type DatasetKey = Dataset;
export type { IsoDate };
