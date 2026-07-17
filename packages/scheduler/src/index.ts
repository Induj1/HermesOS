/**
 * @hermes/scheduler — a deterministic background job scheduler.
 *
 * Holds jobs with cron / interval / once triggers and answers, for a given
 * `nowMs`, which are due — in time order, rescheduling the recurring ones. It runs
 * nothing itself and has no I/O: a caller polls it with the current time (from a
 * timer, a test clock, or a replay after restart) and does whatever a due job
 * means. Everything is a pure function of the clock, so schedules are fully
 * testable with fixed timestamps.
 *
 * Distinct from the kernel's task scheduler, which orders tasks within one
 * mission; this schedules whole jobs over time.
 *
 * ```ts
 * import { Scheduler } from '@hermes/scheduler';
 *
 * const scheduler = new Scheduler<{ mission: string }>();
 * scheduler.add({ id: 'nightly', trigger: { kind: 'cron', expression: '0 3 * * *' }, payload: { mission: 'digest' } }, now);
 * scheduler.add({ id: 'heartbeat', trigger: { kind: 'interval', everyMs: 60_000 }, payload: { mission: 'ping' } }, now);
 *
 * for (const job of scheduler.poll(Date.now())) runtime.run(missionFor(job.payload));
 * const sleepUntil = scheduler.nextWakeup();
 * ```
 *
 * See `docs/rfcs/RFC-0020-scheduler.md` for the design.
 */

export { Scheduler } from './scheduler.js';
export type { ScheduledJob, DueJob, SchedulerOptions } from './scheduler.js';

export { compileTrigger, nextRun } from './trigger.js';
export type { Trigger, CompiledTrigger } from './trigger.js';

export { parseCron, nextAfter } from './cron.js';
export type { Cron } from './cron.js';
