/**
 * @hermes/worker — a worker runtime: a job queue and a deterministic processing
 * loop.
 *
 * A {@link Worker} drains a {@link JobQueue}, running each job through a handler
 * and settling it (ack / retry-with-backoff / dead-letter), with bounded
 * concurrency. Given a `@hermes/scheduler`, it also enqueues due scheduled jobs
 * each tick — so "every morning, run the digest" becomes a queued job processed
 * like any other.
 *
 * The core is {@link Worker.tick}, one step over an explicit `nowMs`, so retries,
 * backoff, concurrency, and dead-lettering are testable with no real time. The
 * queue is a port: the {@link InMemoryJobQueue} is the default and the test double;
 * a Postgres/Redis queue implements the same interface.
 *
 * ```ts
 * import { Worker } from '@hermes/worker';
 *
 * const worker = new Worker<{ mission: string }>({
 *   handler: async (job) => { await runtime.run(missionFor(job.mission)); },
 *   concurrency: 8,
 *   maxAttempts: 5,
 * });
 * await worker.submit({ mission: 'digest' });
 * await worker.runForever({ signal: shutdown.signal });
 * ```
 *
 * See `docs/rfcs/RFC-0021-worker.md` for the design.
 */

export { Worker } from './worker.js';
export type { WorkerOptions, JobHandler, JobContext, TickResult } from './worker.js';

export { InMemoryJobQueue } from './queue.js';
export type {
  JobQueue,
  QueuedJob,
  EnqueueOptions,
  QueueStats,
  DeadJob,
} from './queue.js';
