/**
 * Lifecycle management.
 *
 * Tasks, missions, and the runtime itself all have a lifecycle: a small set of
 * states and a smaller set of legal moves between them. Rather than scatter
 * `if (this.state === 'running')` guards across three files, each declares a
 * transition table and shares this machine.
 *
 * The value is that illegal moves fail loudly at the moment they are attempted,
 * with the subject named. "task cannot transition from succeeded to running" is
 * a bug report; a silently ignored double-completion is a debugging session.
 */

import { InvalidTransitionError } from './errors.js';

/** For each state, the states it may legally move to. */
export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export interface StateMachineOptions<S extends string> {
  /** Called after every accepted transition. Runs synchronously. */
  readonly onTransition?: (from: S, to: S) => void;
  /** Names the subject in error messages, e.g. "task". */
  readonly subject?: string;
}

export class StateMachine<S extends string> {
  #state: S;
  readonly #transitions: TransitionMap<S>;
  readonly #onTransition: ((from: S, to: S) => void) | undefined;
  readonly #subject: string;

  constructor(
    initial: S,
    transitions: TransitionMap<S>,
    options: StateMachineOptions<S> = {},
  ) {
    this.#state = initial;
    this.#transitions = transitions;
    this.#onTransition = options.onTransition;
    this.#subject = options.subject ?? 'state machine';
  }

  get state(): S {
    return this.#state;
  }

  /** True if `next` is reachable from the current state in one move. */
  can(next: S): boolean {
    return this.#transitions[this.#state].includes(next);
  }

  /** True if no move out of the current state exists — a terminal state. */
  get isFinal(): boolean {
    return this.#transitions[this.#state].length === 0;
  }

  /** Move, or throw {@link InvalidTransitionError}. */
  to(next: S): void {
    if (!this.can(next)) {
      throw new InvalidTransitionError(this.#subject, this.#state, next);
    }
    const from = this.#state;
    this.#state = next;
    this.#onTransition?.(from, next);
  }

  /** Move if legal. Returns whether it moved. For idempotent callers. */
  tryTo(next: S): boolean {
    if (!this.can(next)) return false;
    this.to(next);
    return true;
  }
}
