/**
 * The worker runtime — a deterministic loop that drains a job queue.
 *
 * A worker turns a queue of jobs into work done: it claims a bounded number,
 * runs each through a handler, and confirms, retries (with exponential backoff),
 * or dead-letters the outcome. Optionally it feeds a {@link Scheduler}'s due jobs
 * into the queue first, so "every morning run the digest" becomes a queued job a
 * worker processes like any other.
 *
 * The whole thing is built around {@link tick}, a single pure-ish step over an
 * explicit `nowMs`: enqueue what is due, claim, run, settle. `runForever` is a thin
 * timer loop over `tick`. Keeping the core in `tick(nowMs)` is what makes retries,
 * backoff, concurrency, and dead-lettering testable without real time or a real
 * scheduler tick — the same reason the scheduler and the embedding service inject
 * their clocks.
 */

import { noopLogger, systemClock, type Clock, type Logger } from '@hermes/kernel';
import type { Scheduler } from '@hermes/scheduler';
import { type JobQueue, InMemoryJobQueue } from './queue.js';

/** What a handler is told about the job it is running. */
export interface JobContext {
  /** Which attempt this is (1 on the first). */
  readonly attempts: number;
  /** Aborts when the worker is shutting down; a long handler should honour it. */
  readonly signal: AbortSignal;
}

export type JobHandler<J> = (body: J, ctx: JobContext) => Promise<void>;

/** What one `tick` did. */
export interface TickResult {
  /** Scheduled jobs enqueued this tick. */
  readonly fired: number;
  /** Jobs claimed from the queue. */
  readonly claimed: number;
  /** Jobs the handler completed. */
  readonly processed: number;
  /** Jobs that failed and were requeued for a later attempt. */
  readonly retried: number;
  /** Jobs that exhausted their attempts and were dead-lettered. */
  readonly dead: number;
}

export interface WorkerOptions<J, P> {
  readonly queue?: JobQueue<J>;
  readonly handler: JobHandler<J>;
  /** Max jobs run per tick. Default 4. */
  readonly concurrency?: number;
  /** Attempts before a job is dead-lettered. Default 3. */
  readonly maxAttempts?: number;
  /** Base backoff in ms; doubles each attempt. Default 1000. */
  readonly backoffMs?: number;
  /** A scheduler whose due jobs are enqueued each tick. Requires {@link toJob}. */
  readonly scheduler?: Scheduler<P>;
  /** Turn a scheduled job's payload into a queue body. Required with `scheduler`. */
  readonly toJob?: (payload: P) => J;
  /** The clock for `runForever` (time + cancellable sleep). Default `systemClock`. */
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export class Worker<J = unknown, P = unknown> {
  readonly queue: JobQueue<J>;
  readonly #handler: JobHandler<J>;
  readonly #concurrency: number;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #scheduler: Scheduler<P> | undefined;
  readonly #toJob: ((payload: P) => J) | undefined;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(options: WorkerOptions<J, P>) {
    if (options.scheduler !== undefined && options.toJob === undefined) {
      throw new Error('a Worker with a scheduler requires a toJob mapper');
    }
    this.queue = options.queue ?? new InMemoryJobQueue<J>();
    this.#handler = options.handler;
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#backoffMs = options.backoffMs ?? 1000;
    this.#scheduler = options.scheduler;
    this.#toJob = options.toJob;
    this.#clock = options.clock ?? systemClock;
    this.#logger = (options.logger ?? noopLogger).child({ component: 'worker' });
  }

  /** Submit a job for processing now (or later, with `availableAtMs`). */
  submit(body: J, availableAtMs?: number): Promise<string> {
    return this.queue.enqueue(
      body,
      availableAtMs === undefined ? {} : { availableAtMs },
    );
  }

  /**
   * One processing step at `nowMs`: enqueue due scheduled jobs, claim up to
   * `concurrency`, run them, and settle each (ack / retry with backoff / dead-letter).
   */
  async tick(nowMs: number, signal?: AbortSignal): Promise<TickResult> {
    let fired = 0;
    if (this.#scheduler !== undefined && this.#toJob !== undefined) {
      for (const due of this.#scheduler.poll(nowMs)) {
        await this.queue.enqueue(this.#toJob(due.payload));
        fired += 1;
      }
    }

    const claimed = await this.queue.claim(this.#concurrency, nowMs);
    const jobSignal = signal ?? new AbortController().signal;

    let processed = 0;
    let retried = 0;
    let dead = 0;

    await Promise.all(
      claimed.map(async (job) => {
        try {
          await this.#handler(job.body, { attempts: job.attempts, signal: jobSignal });
          await this.queue.ack(job.id);
          processed += 1;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (job.attempts >= this.#maxAttempts) {
            await this.queue.deadLetter(job.id, reason);
            dead += 1;
            this.#logger.warn('job dead-lettered after exhausting attempts', {
              id: job.id,
              attempts: job.attempts,
              reason,
            });
          } else {
            const backoff = this.#backoffMs * 2 ** (job.attempts - 1);
            await this.queue.retry(job.id, nowMs + backoff);
            retried += 1;
            this.#logger.debug('job failed; retrying with backoff', {
              id: job.id,
              attempt: job.attempts,
              backoff,
            });
          }
        }
      }),
    );

    return { fired, claimed: claimed.length, processed, retried, dead };
  }

  /**
   * Run ticks until `signal` aborts, sleeping `pollIntervalMs` between them.
   *
   * The thin timer wrapper over {@link tick}. It is deliberately not where the
   * logic lives — a test drives `tick` directly with fixed times; this just keeps
   * calling it.
   */
  async runForever(options: {
    pollIntervalMs?: number;
    signal: AbortSignal;
  }): Promise<void> {
    const interval = options.pollIntervalMs ?? 1000;
    while (!options.signal.aborted) {
      await this.tick(this.#clock.now(), options.signal);
      try {
        await this.#clock.sleep(interval, options.signal);
      } catch {
        // The sleep was aborted (kernel Clock rejects with CancellationError) —
        // the loop condition ends it.
        return;
      }
    }
  }
}
