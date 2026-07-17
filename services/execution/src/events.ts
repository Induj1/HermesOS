/**
 * The execution event catalogue.
 *
 * The engine publishes on its **own** bus, not the kernel's. That is the whole
 * of "the kernel should remain unaware this exists": the kernel emits
 * `mission:*` and `task:*` about missions and tasks, and knows nothing about
 * executions, steps, checkpoints or replans. Pushing execution events onto the
 * kernel's bus would make `@hermes/memory`'s `onAny` listener — which persists
 * every kernel event — start writing rows about a concept the kernel does not
 * have, through a seam RFC-0001 §11.2 reserved for kernel events.
 *
 * `EventBus<M>` is generic and public, so the engine gets the kernel's
 * backpressure, its error routing, and its `waitFor` for free without the kernel
 * learning a thing. That is reuse of a mechanism, not coupling to a vocabulary.
 *
 * ## Why events at all, when `execute()` returns a snapshot
 *
 * Because the snapshot arrives at the end. A long execution's whole value to a
 * Telegram interface or a REST stream is what it is doing *now*, and polling a
 * promise cannot answer that. These are that channel — and, like the kernel's,
 * they carry complete payloads rather than ids, so a listener never has to call
 * back into the engine to find out what happened.
 */

import type { MissionId } from '@hermes/kernel';
import type { ExecutionId, ExecutionSnapshot, StepRecord } from './model.js';

export interface ExecutionEventMap {
  /** An execution was created and is about to run. Carries the whole plan's shape. */
  'execution:started': { readonly execution: ExecutionSnapshot };
  /** An execution reached a terminal state. The last word on it. */
  'execution:settled': { readonly execution: ExecutionSnapshot };
  /** An execution was paused. `execution.state` is `paused`; a checkpoint exists. */
  'execution:paused': { readonly execution: ExecutionSnapshot };
  /** A paused or crashed execution was picked up again. */
  'execution:resumed': { readonly execution: ExecutionSnapshot };
  /**
   * An execution is being replanned after a failure.
   *
   * Emitted *before* the new mission is submitted, so a listener can veto by
   * cancelling, and so an operator sees the loop turning rather than a silence
   * that ends in `RECOVERY_EXHAUSTED`.
   */
  'execution:recovering': {
    readonly execution: ExecutionSnapshot;
    readonly attempt: number;
    readonly reason: string;
  };
  /** A checkpoint was written. Mostly for tests and for operational visibility. */
  'execution:checkpointed': {
    readonly id: ExecutionId;
    readonly state: ExecutionSnapshot['state'];
  };

  /** A step is about to be invoked, with its references already resolved. */
  'step:started': { readonly executionId: ExecutionId; readonly step: StepRecord };
  /** A step returned. `step.result` is what `$from` will now resolve to. */
  'step:succeeded': { readonly executionId: ExecutionId; readonly step: StepRecord };
  /** A step threw, after the kernel exhausted its retries. */
  'step:failed': { readonly executionId: ExecutionId; readonly step: StepRecord };

  /**
   * A kernel mission was submitted for this execution.
   *
   * The one place the two vocabularies are deliberately joined, and the only way
   * a listener can correlate an execution with the `mission:*` events memory is
   * persisting. Without it, the audit log and the execution history are two
   * stories about the same events with no key between them.
   */
  'mission:submitted': {
    readonly executionId: ExecutionId;
    readonly missionId: MissionId;
  };
}

export type ExecutionEventName = keyof ExecutionEventMap;
