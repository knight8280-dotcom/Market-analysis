import { ProviderError } from "@market/market-data";
import {
  Queue,
  UnrecoverableError,
  Worker,
  type ConnectionOptions,
  type JobsOptions,
} from "bullmq";
import type { WorkerContext } from "./context";
import { BullDispatcher } from "./dispatch";
import { runJob, type Handler } from "./jobs/index";
import { CONCURRENCY, DEFAULT_JOB_OPTIONS, QUEUES, type JobName, type QueueName } from "./queues";

export interface Runtime {
  queues: Map<QueueName, Queue>;
  workers: Worker[];
  dispatcher: BullDispatcher;
  close(): Promise<void>;
}

/**
 * BullMQ wiring: one queue and one Worker per queue name, a dead-letter queue for jobs that
 * exhaust their retries (or fail unrecoverably), and non-retryable provider errors converted to
 * UnrecoverableError so they are not retried pointlessly.
 */
export function startRuntime(
  base: Omit<WorkerContext, "dispatch">,
  opts: {
    connection: () => ConnectionOptions;
    prefix?: string;
    jobOptions?: JobsOptions;
    run?: (ctx: WorkerContext, name: JobName, data: unknown) => Promise<unknown>;
  },
): Runtime {
  const prefix = opts.prefix ?? "bull";
  const run = opts.run ?? runJob;
  const queueConnection = opts.connection();
  const queues = new Map<QueueName, Queue>(
    Object.values(QUEUES).map((name) => [
      name,
      new Queue(name, { connection: queueConnection, prefix }),
    ]),
  );
  const dispatcher = new BullDispatcher(queues, opts.jobOptions ?? DEFAULT_JOB_OPTIONS);
  const ctx: WorkerContext = { ...base, dispatch: dispatcher };
  const deadLetter = queues.get(QUEUES.deadLetter)!;

  const workers = Object.values(QUEUES)
    .filter((name) => name !== QUEUES.deadLetter)
    .map((name) => {
      const worker = new Worker(
        name,
        async (job) => {
          const jobCtx = {
            ...ctx,
            jobId: job.id,
            log: ctx.log.child({ queue: name, job: job.id }),
          };
          try {
            return await run(jobCtx, job.name as JobName, job.data);
          } catch (err) {
            // Retrying cannot fix a non-retryable provider error (404, bad shape, license).
            if (err instanceof ProviderError && !err.retryable)
              throw new UnrecoverableError(err.message);
            throw err;
          }
        },
        { connection: opts.connection(), prefix, concurrency: CONCURRENCY[name] },
      );
      worker.on("failed", (job, err) => {
        if (!job) return;
        const exhausted =
          job.attemptsMade >= (job.opts.attempts ?? 1) || err instanceof UnrecoverableError;
        ctx.log.error({ queue: name, job: job.id, attempts: job.attemptsMade, err }, "job failed");
        if (exhausted) {
          void deadLetter.add(
            "dead-letter",
            {
              queue: name,
              name: job.name,
              id: job.id,
              data: job.data as unknown,
              reason: err.message,
            },
            { attempts: 1, jobId: `dead-letter/${job.id ?? "unknown"}`, removeOnComplete: false },
          );
        }
      });
      return worker;
    });

  return {
    queues,
    workers,
    dispatcher,
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}

export type { Handler };
