import type { JobsOptions, Queue } from "bullmq";
import type { Dispatcher, JobRequest } from "./context";
import { DEFAULT_JOB_OPTIONS, QUEUE_OF, type QueueName } from "./queues";

/** Enqueues into BullMQ; a job id that already exists is ignored by BullMQ (idempotent). */
export class BullDispatcher implements Dispatcher {
  constructor(
    private readonly queues: ReadonlyMap<QueueName, Queue>,
    private readonly options: JobsOptions = DEFAULT_JOB_OPTIONS,
  ) {}

  async dispatch(job: JobRequest): Promise<void> {
    const queue = this.queues.get(QUEUE_OF[job.name]);
    if (!queue) throw new Error(`No queue for job ${job.name}`);
    await queue.add(job.name, job.data, { ...this.options, jobId: job.jobId });
  }
}

/**
 * In-process queue for the CLI and tests: jobs run in FIFO order when drained, including jobs
 * dispatched by other jobs. Each job id runs at most once, like BullMQ's dedupe.
 */
export class InlineDispatcher implements Dispatcher {
  private readonly pending: JobRequest[] = [];
  private readonly seen = new Set<string>();

  dispatch(job: JobRequest): Promise<void> {
    if (!this.seen.has(job.jobId)) {
      this.seen.add(job.jobId);
      this.pending.push(job);
    }
    return Promise.resolve();
  }

  get size(): number {
    return this.pending.length;
  }

  async drain(
    run: (job: JobRequest) => Promise<unknown>,
    onError: (job: JobRequest, err: unknown) => void = () => {},
  ): Promise<{ ran: number; failed: number }> {
    let ran = 0;
    let failed = 0;
    for (let job = this.pending.shift(); job; job = this.pending.shift()) {
      try {
        await run(job);
        ran += 1;
      } catch (err) {
        failed += 1;
        onError(job, err);
      }
    }
    return { ran, failed };
  }
}
