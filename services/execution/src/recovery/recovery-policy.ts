/**
 * When to try again, and when to stop.
 *
 * ## Why this is not "retry"
 *
 * The kernel already retries. `maxAttempts` and its backoff re-run a *task* that
 * threw, and that is the right mechanism for a flaky network call. Nothing here
 * duplicates it, and a host that wants a step tried three times should say
 * `maxAttempts: 3` on the step, not reach for this.
 *
 * This is the layer above: the kernel has exhausted its retries, the mission has
 * settled `failed`, and the question is whether the *plan* should be reshaped
 * around what went wrong. That question is not "try again harder" — it is "the
 * world is not what we thought it was when we planned", and its answer is a
 * replan (RFC-0003 §7.2). The two are different failures with different fixes,
 * and collapsing them into one number would make a plan that is wrong retry
 * itself identically until the budget ran out.
 *
 * ## Why there is a limit at all
 *
 * Because a replan loop that does not converge is worse than a failure. An
 * execution that replans, fails, replans identically, and fails again is not
 * making progress, and each turn costs real money if a model is in the chain.
 * The limit is what turns "burns the budget discovering it slowly" into
 * `RecoveryExhaustedError` with a count the operator can read.
 */

import type { IncompleteTaskPolicy } from '@hermes/planner';

export interface RecoveryPolicy {
  /**
   * How many times an execution may be replanned. Default 0 — off.
   *
   * **Off by default, deliberately.** Recovery re-runs steps, and whether that
   * is safe depends on whether their capabilities are idempotent — which this
   * package cannot know, exactly as the planner cannot (RFC-0003 §7.2). An
   * engine that replanned by default would double-send an email the first time
   * someone's network blipped, and they would not have asked for it. A host that
   * knows its tools opts in.
   */
  readonly maxAttempts?: number;

  /**
   * What to do with a step whose fate is unknown — one still mid-flight when
   * everything stopped.
   *
   * Handed straight to `Replanner`, which requires it and refuses to default it
   * because there is no safe default (RFC-0003 §7.2). This type deliberately
   * does not soften that: it is required here too whenever recovery is enabled,
   * so the decision stays with the caller who knows their tools.
   */
  readonly incomplete: IncompleteTaskPolicy;

  /**
   * Decide whether a given failure is worth replanning at all. Default: yes.
   *
   * The extension point that keeps this from being a blunt counter. A network
   * timeout is worth another shape; `InvalidInputError` from a tool's validator
   * is not — the plan is wrong in a way a replan of the same plan will reproduce
   * exactly. A host that can tell the two apart says so here, and saves itself
   * the whole loop.
   */
  shouldRecover?(failure: RecoveryDecision): boolean;
}

/** What a {@link RecoveryPolicy.shouldRecover} decision gets to look at. */
export interface RecoveryDecision {
  /** 1 on the first recovery, i.e. after the original attempt failed. */
  readonly attempt: number;
  /** The steps that failed, with their flattened errors. */
  readonly failures: readonly {
    readonly step: string;
    readonly message: string;
    readonly code?: string;
  }[];
}

/** Recovery off. What an engine uses when the host said nothing. */
export const NO_RECOVERY: RecoveryPolicy = { maxAttempts: 0, incomplete: 'fail' };

/**
 * Should this execution be replanned?
 *
 * Split out as a pure function so the decision is testable without an engine,
 * a runtime, or a plan — which is the difference between this being covered and
 * this being covered by accident.
 */
export function shouldRecover(
  policy: RecoveryPolicy,
  decision: RecoveryDecision,
): boolean {
  const budget = policy.maxAttempts ?? 0;
  if (decision.attempt > budget) return false;
  return policy.shouldRecover?.(decision) ?? true;
}
