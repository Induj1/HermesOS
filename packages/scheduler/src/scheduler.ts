/**
 * The background scheduler — what fires, and when.
 *
 * It holds a set of jobs, each with a {@link Trigger} and an opaque payload, and
 * answers one question deterministically: **given it is now `nowMs`, which jobs are
 * due?** A caller drives it by polling with the current time — from a real timer,
 * a test's fixed clock, or a persistence layer replaying after a restart — and the
 * scheduler returns the due jobs (in time order) and reschedules the recurring
 * ones. It runs nothing itself; *what* a due job does is the caller's, which keeps
 * the scheduler free of the kernel, a queue, or any I/O.
 *
 * This is distinct from the kernel's task scheduler (RFC-0001), which orders the
 * tasks *within* one mission's DAG. This schedules whole jobs *over time* — "every
 * morning", "in five minutes", "on the first of the month".
 *
 * ## Missed ticks coalesce
 *
 * If the host was asleep and a job's time passed several times over (an interval
 * that should have fired thrice), a `poll` fires it **once** and schedules its next
 * run after `nowMs`. A scheduler is a "should this run now?" oracle, not a
 * backlog that replays every missed occurrence — replaying a day of missed
 * every-minute jobs on wake is a stampede, not a feature. A caller that needs
 * every occurrence records them itself.
 */

import { noopLogger, type Logger } from '@hermes/kernel';
import {
  compileTrigger,
  nextRun,
  type CompiledTrigger,
  type Trigger,
} from './trigger.js';

export interface ScheduledJob<P = unknown> {
  readonly id: string;
  readonly trigger: Trigger;
  readonly payload: P;
}

/** A job that is due, with the time it was scheduled for (which may be before now). */
export interface DueJob<P = unknown> {
  readonly id: string;
  readonly payload: P;
  readonly scheduledFor: number;
}

interface Entry<P> {
  readonly job: ScheduledJob<P>;
  readonly compiled: CompiledTrigger;
  /** Next fire time, or `undefined` once the job is exhausted (a fired `once`). */
  nextRunMs: number | undefined;
}

export interface SchedulerOptions {
  readonly logger?: Logger;
}

export class Scheduler<P = unknown> {
  readonly #entries = new Map<string, Entry<P>>();
  readonly #logger: Logger;

  constructor(options: SchedulerOptions = {}) {
    this.#logger = (options.logger ?? noopLogger).child({ component: 'scheduler' });
  }

  /**
   * Add (or replace) a job, computing its first run strictly after `nowMs`.
   *
   * Replacing a job by re-adding its id is deliberate — updating a schedule is a
   * normal act. A cron expression is validated here; a malformed one throws rather
   * than silently never firing.
   */
  add(job: ScheduledJob<P>, nowMs: number): this {
    const compiled = compileTrigger(job.trigger);
    this.#entries.set(job.id, { job, compiled, nextRunMs: nextRun(compiled, nowMs) });
    return this;
  }

  /** Remove a job. Returns whether it was present. */
  remove(id: string): boolean {
    return this.#entries.delete(id);
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The next time any job will fire, or `undefined` if nothing is scheduled. */
  nextWakeup(): number | undefined {
    let earliest: number | undefined;
    for (const entry of this.#entries.values()) {
      if (
        entry.nextRunMs !== undefined &&
        (earliest === undefined || entry.nextRunMs < earliest)
      ) {
        earliest = entry.nextRunMs;
      }
    }
    return earliest;
  }

  /**
   * Fire every job whose next run is at or before `nowMs`, returning them in time
   * order, and reschedule the recurring ones after `nowMs`. Exhausted `once` jobs
   * are removed. A missed job fires once, not once per missed occurrence.
   */
  poll(nowMs: number): DueJob<P>[] {
    const due: DueJob<P>[] = [];

    for (const entry of this.#entries.values()) {
      if (entry.nextRunMs === undefined || entry.nextRunMs > nowMs) continue;
      due.push({
        id: entry.job.id,
        payload: entry.job.payload,
        scheduledFor: entry.nextRunMs,
      });
      // Reschedule after *now* (coalescing missed ticks), not after the missed time.
      entry.nextRunMs = nextRun(entry.compiled, nowMs);
      if (entry.nextRunMs === undefined) {
        this.#entries.delete(entry.job.id);
        this.#logger.debug('one-shot job fired and removed', { id: entry.job.id });
      }
    }

    // Deterministic order: earliest scheduled-for first, ties broken by id.
    due.sort(
      (a, b) =>
        a.scheduledFor - b.scheduledFor || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return due;
  }
}
