/**
 * Every error the planner throws on purpose.
 *
 * Same contract as the kernel's and the memory service's: a stable
 * machine-readable `code` that callers branch on, so message wording stays free
 * to change (RFC-0001 §5). And, as in `@hermes/memory`, this hierarchy does not
 * extend `KernelError` — a planner error that were `instanceof KernelError`
 * would claim the kernel threw it, and the kernel has never heard of this
 * package.
 */

export type PlannerErrorCode =
  'PLAN_INVALID' | 'PLANNING_FAILED' | 'NOTHING_TO_REPLAN' | 'INVALID_INPUT';

export class PlannerError extends Error {
  readonly code: PlannerErrorCode;

  constructor(code: PlannerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Where a validation issue lives, so a caller can point at it. */
export interface PlanIssue {
  /** The offending step, or undefined for a plan-wide problem. */
  readonly step: string | undefined;
  readonly message: string;
}

/**
 * A plan was rejected before it ever ran.
 *
 * Carries **every** issue, not the first. Deliberately modelled on the kernel's
 * `MissionValidationError`, for the same stated reason: "an author fixing a spec
 * wants all the issues, not the first one, then the second one on the next run"
 * (kernel `mission.ts`). That author is now sometimes a language model being
 * asked to repair its own output, which makes completeness worth more, not less.
 */
export class PlanValidationError extends PlannerError {
  readonly issues: readonly PlanIssue[];

  constructor(issues: readonly PlanIssue[]) {
    super('PLAN_INVALID', `Invalid plan: ${formatIssues(issues)}`);
    this.issues = issues;
  }
}

/**
 * No strategy produced a usable plan.
 *
 * Carries the whole chain — what each strategy did and why it did not work —
 * because the useful question after a planning failure is never "did it fail"
 * but "how far did it get, and which link broke". A bare "planning failed" would
 * make a five-strategy chain undebuggable.
 */
export class PlanningFailedError extends PlannerError {
  readonly attempts: readonly { strategy: string; outcome: string; reason?: string }[];

  constructor(
    goal: string,
    attempts: readonly { strategy: string; outcome: string; reason?: string }[],
  ) {
    super(
      'PLANNING_FAILED',
      attempts.length === 0
        ? `No strategy is registered, so nothing could plan: "${truncate(goal)}"`
        : `No strategy produced a valid plan for "${truncate(goal)}". ` +
            `Tried ${String(attempts.length)}: ${attempts
              .map(
                (attempt) =>
                  `${attempt.strategy} (${attempt.outcome}${
                    attempt.reason === undefined ? '' : `: ${attempt.reason}`
                  })`,
              )
              .join('; ')}`,
    );
    this.attempts = attempts;
  }
}

/**
 * A replan was asked for on a mission that has nothing left to do.
 *
 * An error rather than an empty plan, because the kernel rejects a mission with
 * no tasks ("mission must have at least one task"). Returning an empty plan would
 * push that failure to `Mission.create`, where the message names the wrong
 * problem entirely.
 */
export class NothingToReplanError extends PlannerError {
  readonly missionId: string;

  /**
   * @param missionId The mission that cannot be replanned.
   * @param reason Why, as a clause that completes "Nothing to replan for mission
   *   X: ...". There is deliberately no fixed explanation here: a replan is
   *   refused for several genuinely different reasons — everything succeeded,
   *   everything was abandoned by a `skip`, or a mid-flight task needs a human —
   *   and a caller reading the message has no other way to tell which.
   */
  constructor(missionId: string, reason: string) {
    super(
      'NOTHING_TO_REPLAN',
      `Nothing to replan for mission "${missionId}": ${reason}.`,
    );
    this.missionId = missionId;
  }
}

/** Input was rejected at the planner's boundary. */
export class InvalidInputError extends PlannerError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('INVALID_INPUT', `Invalid input: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

/**
 * Coerce anything a `throw` produced into an Error.
 *
 * Local rather than imported from the kernel for the same reason `@hermes/memory`
 * keeps its own: every catch block here would otherwise depend on the kernel to
 * handle an error the kernel did not throw — a coupling with no payoff.
 */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'string') return new Error(thrown);
  return new Error(`Non-Error thrown: ${String(thrown)}`, { cause: thrown });
}

function formatIssues(issues: readonly PlanIssue[]): string {
  return issues
    .map((issue) =>
      issue.step === undefined
        ? issue.message
        : `step "${issue.step}": ${issue.message}`,
    )
    .join('; ');
}

function truncate(text: string, max = 80): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
