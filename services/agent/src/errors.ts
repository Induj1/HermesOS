/**
 * Every error the agent framework throws on purpose.
 *
 * Same contract as every layer below: a stable machine-readable `code` that
 * callers branch on, so message wording stays free to change (RFC-0001 §5). And
 * this hierarchy extends neither `KernelError` nor `PlannerError` nor
 * `ModelError` — an agent error that were `instanceof ModelError` would claim a
 * provider threw it, and blame the wrong layer in the one place a reader is
 * looking for the right one.
 */

export type AgentErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'REASONING_FAILED'
  | 'TURNS_EXHAUSTED'
  | 'DELEGATION_LOOP'
  | 'INVALID_INPUT';

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * A decision named an agent nobody registered.
 *
 * Almost always a `DelegateDecision` from a model that invented a plausible
 * colleague. That is a normal failure mode rather than an exotic one, which is
 * why it has its own code: a host may reasonably want to catch it and answer
 * "I don't have anyone for that" instead of erroring.
 */
export class AgentNotFoundError extends AgentError {
  readonly agent: string;

  constructor(agent: string, known: readonly string[]) {
    super(
      'AGENT_NOT_FOUND',
      known.length === 0
        ? `No agent named "${agent}" is registered, and no agents are registered at all.`
        : `No agent named "${agent}" is registered. Known agents: ${known.join(', ')}.`,
    );
    this.agent = agent;
  }
}

/**
 * Every reasoner in a chain broke.
 *
 * Carries what each one did, because "reasoning failed" alone makes a
 * three-reasoner chain undebuggable — the same argument `PlanningFailedError`
 * makes for a strategy chain (RFC-0003 §5.2), and the same shape, deliberately.
 */
export class ReasoningFailedError extends AgentError {
  readonly attempts: readonly ReasonerAttempt[];

  constructor(agent: string, attempts: readonly ReasonerAttempt[]) {
    super(
      'REASONING_FAILED',
      attempts.length === 0
        ? `Agent "${agent}" has an empty reasoner chain, so it can never decide anything`
        : `Every reasoner for agent "${agent}" failed. Tried ${String(attempts.length)}: ` +
            attempts
              .map(
                (attempt) =>
                  `${attempt.reasoner} (${attempt.outcome}: ${attempt.reason})`,
              )
              .join('; '),
    );
    this.attempts = attempts;
  }
}

export interface ReasonerAttempt {
  readonly reasoner: string;
  readonly outcome: 'threw' | 'abstained';
  readonly reason: string;
}

/**
 * The session ran out of turns.
 *
 * Thrown only when a host asked for it; the default is to return a result with
 * `outcome: 'exhausted'` instead. An agent looping is a *finding*, not
 * necessarily an incident — the transcript is the interesting part, and throwing
 * it away to raise an exception would discard the evidence.
 */
export class TurnsExhaustedError extends AgentError {
  readonly turns: number;

  constructor(agent: string, turns: number) {
    super(
      'TURNS_EXHAUSTED',
      `Agent "${agent}" did not reach an answer within ${String(turns)} turn(s).`,
    );
    this.turns = turns;
  }
}

/**
 * Agents delegated in a circle.
 *
 * Its own code because the remedy is unlike any other failure here: nothing the
 * caller passed is wrong and retrying will not help. Two agents each think the
 * other should handle this, which is a *configuration* fault, and the path is the
 * only thing that identifies it.
 */
export class DelegationLoopError extends AgentError {
  readonly path: readonly string[];

  constructor(path: readonly string[]) {
    super('DELEGATION_LOOP', `Agents delegated in a circle: ${path.join(' -> ')}.`);
    this.path = path;
  }
}

/** Input was rejected at the framework's boundary. */
export class InvalidInputError extends AgentError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('INVALID_INPUT', `Invalid input: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

/**
 * Coerce anything thrown into an `Error`.
 *
 * Each layer keeps its own rather than importing another's: every catch block
 * here would otherwise depend on a package to handle an error that package did
 * not throw — a coupling with no payoff.
 */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'string') return new Error(thrown);
  return new Error(`Non-Error thrown: ${String(thrown)}`, { cause: thrown });
}
