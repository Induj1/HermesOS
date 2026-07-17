/**
 * The execution context — what one execution knows so far.
 *
 * It is the store `$from` references resolve against, and therefore the reason
 * data can flow between steps at all. Everything else in this package is
 * arrangement around this one fact: the kernel will not carry a result from one
 * task to another (RFC-0001 §11.4), so something above it has to hold them.
 *
 * ## Why a class and not a Map
 *
 * Because the interesting operations are not `get` and `set`. They are "give me
 * a checkpoint I can write to disk", "restore yourself from one a dead process
 * wrote", and "tell me the results in a form a reference can resolve against".
 * A bare `Map` would leave each of those at the call site, and the third one —
 * deciding that a *failed* step has no result to offer — is precisely the
 * decision that must not be duplicated.
 *
 * ## Why results live here rather than on the kernel's tasks
 *
 * The kernel does hold `snapshot.tasks[].result`, and reading it would work
 * right up until the first recovery. A replanned execution is a *new mission*
 * (RFC-0001 §11.3), and the new mission's snapshot knows nothing about the steps
 * that succeeded in the old one. Their results still have to resolve. So the
 * context outlives any single mission, which is the whole reason it is a
 * separate thing.
 */

import type { Clock } from '@hermes/kernel';
import type { ResultLookup } from '../refs.js';
import type { StepRecord, StepState } from '../model.js';

/**
 * The mutable state of one execution's steps.
 *
 * Mutable on purpose, and the only mutable thing in this package. An execution
 * is a process, not a value; pretending otherwise would mean rebuilding a record
 * array on every step completion for the aesthetics of it. What leaves this
 * class — {@link snapshot}, {@link checkpointSteps} — is always a copy.
 */
export class ExecutionContext implements ResultLookup {
  readonly #steps = new Map<string, StepRecord>();
  readonly #clock: Clock;

  constructor(clock: Clock, steps: readonly StepRecord[] = []) {
    this.#clock = clock;
    for (const step of steps) this.#steps.set(step.name, step);
  }

  /**
   * Rebuild a context from a checkpoint.
   *
   * The counterpart to {@link checkpointSteps}, and the whole point of both: a
   * process that never saw an execution start can pick it up from here, with
   * every earlier result still resolvable.
   */
  static restore(clock: Clock, steps: readonly StepRecord[]): ExecutionContext {
    return new ExecutionContext(clock, steps);
  }

  /** Seed the steps a plan declares, all `pending`. Called once, before running. */
  declare(
    steps: readonly {
      name: string;
      intent: string;
      capability: StepRecord['capability'];
    }[],
  ): void {
    for (const step of steps) {
      // Never clobber: on resume the plan is re-declared over a context that
      // already holds results, and overwriting them would silently throw away
      // the work the checkpoint existed to preserve.
      if (this.#steps.has(step.name)) continue;
      this.#steps.set(step.name, {
        name: step.name,
        intent: step.intent,
        capability: step.capability,
        state: 'pending',
        attempts: 0,
      });
    }
  }

  /**
   * Does this step have a result a reference may read?
   *
   * **`true` only for a step that succeeded.** A failed step has an `error`, not
   * a result; a running one has nothing yet. Both must resolve to "no", or a
   * reference would substitute `undefined` and hand a capability a value nobody
   * produced. This is the single most important line in the class.
   */
  has(step: string): boolean {
    return this.#steps.get(step)?.state === 'succeeded';
  }

  /** The result of a succeeded step, or `undefined`. Guard with {@link has}. */
  get(step: string): unknown {
    const record = this.#steps.get(step);
    return record?.state === 'succeeded' ? record.result : undefined;
  }

  /** The record for a step, whatever state it is in. */
  record(step: string): StepRecord | undefined {
    return this.#steps.get(step);
  }

  /** Every step, in declaration order. A copy; the caller cannot reach the state. */
  snapshot(): readonly StepRecord[] {
    return [...this.#steps.values()];
  }

  /**
   * The steps in the form a checkpoint stores.
   *
   * Identical to {@link snapshot} today, and separate anyway: a checkpoint is a
   * persistence format with a compatibility obligation, and a snapshot is a
   * debugging view with none. The day one grows a field the other should not
   * carry, this is the seam that lets it.
   */
  checkpointSteps(): readonly StepRecord[] {
    return this.snapshot();
  }

  /** Mark a step started. Records the attempt number the kernel reports. */
  started(step: string, attempt: number): void {
    this.#patch(step, (current) => ({
      ...current,
      state: 'running',
      attempts: attempt,
      // Only on the first attempt: a retry is the same step continuing, and
      // moving `startedAt` would make a step that retried four times look like it
      // started when it last retried, hiding exactly the delay worth seeing.
      ...(current.startedAt === undefined ? { startedAt: this.#clock.now() } : {}),
    }));
  }

  /**
   * Record a step's result.
   *
   * `result` is stored even when it is `undefined` — a capability returning
   * nothing still *succeeded*, and `has()` keys off `state`, never off whether
   * the result is defined. Conflating "returned undefined" with "did not run"
   * would make a void tool impossible to depend on.
   */
  succeeded(step: string, result: unknown): void {
    this.#patch(step, (current) => {
      // A step that succeeded on a retry must not keep the error from the
      // attempt before it: the record says what happened *to the step*, and what
      // happened is that it worked. Destructured out rather than set to
      // `undefined` because `exactOptionalPropertyTypes` draws a real
      // distinction between "absent" and "present and undefined", and only the
      // first survives a JSON round-trip into a checkpoint unchanged.
      const { error: _discarded, ...kept } = current;
      return {
        ...kept,
        state: 'succeeded',
        result,
        finishedAt: this.#clock.now(),
      };
    });
  }

  failed(step: string, error: StepRecord['error']): void {
    this.#patch(step, (current) => ({
      ...current,
      state: 'failed',
      ...(error === undefined ? {} : { error }),
      finishedAt: this.#clock.now(),
    }));
  }

  /** Mark a step skipped — its upstream did not succeed, so it never ran. */
  skipped(step: string): void {
    this.#patch(step, (current) => ({ ...current, state: 'skipped' }));
  }

  /**
   * Return a step to `pending`, as though it had never run.
   *
   * For recovery: a replanned step is about to be attempted again, and leaving
   * it `failed` would make the context claim it had settled when the whole point
   * is that it has not. The error and the timings are cleared with it — they
   * describe the previous attempt, and a record that mixed this attempt's state
   * with the last one's error is a record nobody can read.
   *
   * `attempts` is **kept**. It counts what has actually been tried, across
   * every attempt at the plan, and resetting it would hide a step that has now
   * failed four times behind a fresh-looking zero — which is exactly the signal
   * an operator needs to see.
   */
  reset(step: string): void {
    this.#patch(step, (current) => ({
      name: current.name,
      intent: current.intent,
      capability: current.capability,
      state: 'pending',
      attempts: current.attempts,
    }));
  }

  /** Every step in one of the given states, in declaration order. */
  inState(...states: readonly StepState[]): readonly StepRecord[] {
    return this.snapshot().filter((step) => states.includes(step.state));
  }

  /** Did every declared step reach a state that means "nothing left to do here"? */
  get settled(): boolean {
    return this.snapshot().every(
      (step) =>
        step.state === 'succeeded' ||
        step.state === 'failed' ||
        step.state === 'skipped',
    );
  }

  /**
   * Apply a change to a step, ignoring one that was never declared.
   *
   * Ignoring rather than throwing: the kernel reports on tasks, and a task the
   * engine did not declare is not something the engine can meaningfully record.
   * Throwing from an event listener would take down persistence for a condition
   * that is, at worst, cosmetic. The engine declares every step it compiles, so
   * in practice this cannot miss.
   */
  #patch(step: string, change: (current: StepRecord) => StepRecord): void {
    const current = this.#steps.get(step);
    if (!current) return;
    this.#steps.set(step, change(current));
  }
}
