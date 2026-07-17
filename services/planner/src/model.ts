/**
 * The planner's domain types — plain, serialisable data.
 *
 * A {@link Plan} is deliberately *not* a `MissionSpec`. It is a superset that
 * carries the things the kernel refuses to know about — why a step exists, which
 * strategy proposed it, how confident that strategy was, whether the step may be
 * dropped — and `PlanCompiler` projects it down to the kernel's vocabulary
 * (`compiler/plan-compiler.ts`).
 *
 * Two types, not one, because the alternative is smuggling planner concepts into
 * `MissionSpec.metadata` and hoping nothing downstream trips over them. Keeping a
 * plan a first-class value means it can be inspected, logged, diffed, shown to a
 * human for approval, and stored — before anything runs.
 *
 * Conventions inherited from the kernel rather than invented: timestamps are
 * epoch milliseconds from an injected `Clock`, and steps are identified by a
 * `name` unique within their plan (kernel `task.ts`), because a plan must be
 * serialisable and a function reference is not.
 */

import type { Brand, FailurePolicy } from '@hermes/kernel';

export type PlanId = Brand<string, 'PlanId'>;

export function toPlanId(raw: string): PlanId {
  return raw as PlanId;
}

/** What can run: a kernel tool or a kernel agent, named. */
export type CapabilityKind = 'tool' | 'agent';

/**
 * A reference to something the runtime can execute.
 *
 * Structurally identical to the kernel's `TaskHandlerRef`, and deliberately
 * re-declared rather than imported. A plan is authored and validated *before* a
 * runtime exists, and a strategy proposing a step should not have to reach for a
 * kernel type to name a capability it hopes is registered. The compiler is the
 * one place the two vocabularies meet.
 */
export interface CapabilityRef {
  readonly kind: CapabilityKind;
  readonly name: string;
}

/**
 * Something the runtime knows how to do, as the planner sees it.
 *
 * `tags` comes from `Agent.capabilities`, which the kernel describes as
 * "free-form capability tags... carried for routing layers built above it; it
 * never reads them itself" (kernel `agent.ts`). This is that routing layer, and
 * this field is the socket the kernel left for it.
 */
export interface Capability {
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

/**
 * What someone wants. The planner's input.
 *
 * `statement` is natural language and stays uninterpreted by everything except a
 * strategy — the planner core never parses it. That is what lets a keyword
 * matcher and a language model satisfy the same interface (`ports/plan-strategy.ts`).
 */
export interface Goal {
  readonly statement: string;
  /**
   * Whose goal this is, in the memory service's sense (`@hermes/memory`'s
   * `Subject`). Opaque here: the planner has no user model. Carried so a strategy
   * can scope a memory lookup and so the compiled mission records who it was for.
   */
  readonly subject?: string;
  /** Structured facts a strategy may use. Never interpreted by the core. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Passed through to the compiled mission. Defaults to the kernel's `fail-fast`. */
  readonly failurePolicy?: FailurePolicy;
  readonly constraints?: PlanConstraints;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PlanConstraints {
  /**
   * Reject a plan with more than this many steps.
   *
   * A guard against a strategy that decomposes without bound — which is a real
   * failure mode for a model-backed one, and an expensive one, because the cost
   * is paid in execution rather than in planning.
   */
  readonly maxSteps?: number;
  /**
   * Reject a plan whose steps are nested deeper than this.
   *
   * Depth is the longest dependency chain. It bounds *latency* the way `maxSteps`
   * bounds *work*: a 40-step fan-out finishes in one round at concurrency 40,
   * while a 40-step chain cannot go faster than the sum of its parts.
   */
  readonly maxDepth?: number;
}

export interface PlanStep {
  /** Unique within the plan. How `dependsOn` refers to it, and the compiled task's name. */
  readonly name: string;
  /**
   * Why this step exists, in one line.
   *
   * Required, not optional. It is the only field that survives into a human's
   * understanding of a plan they did not write, and a planner whose output cannot
   * be explained is a planner nobody will let run unattended. Compiled into the
   * task's metadata, where the kernel carries it without ever reading it.
   */
  readonly intent: string;
  readonly capability: CapabilityRef;
  /**
   * The step's input, fixed at plan time.
   *
   * Static, because the kernel's `dependsOn` is an ordering constraint and not a
   * data flow (RFC-0001 §11.4): a step does **not** receive its dependencies'
   * outputs. See RFC-0003 §7.1 — this is the planner's sharpest constraint and
   * it is inherited, not chosen.
   */
  readonly input?: unknown;
  /** Names of steps in the same plan that must succeed first. */
  readonly dependsOn?: readonly string[];
  /** Higher runs first among ready steps. Passed through to the kernel. */
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  /**
   * May this step be dropped if its capability is not registered?
   *
   * The knob behind graceful degradation. An optional step whose tool is missing
   * is removed and its dependents rewired onto its own dependencies
   * (`validation/plan-repair.ts`); a required one makes the plan invalid. Default
   * false — silently dropping work is the more dangerous default, so it must be
   * asked for.
   */
  readonly optional?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Plan {
  readonly id: PlanId;
  readonly goal: Goal;
  readonly steps: readonly PlanStep[];
  /** Name of the {@link PlanStrategy} that produced this. For logs and for routing. */
  readonly strategy: string;
  /** Why the plan has this shape. Free-form, human-facing, never parsed. */
  readonly rationale: string;
  /**
   * How much the strategy trusts this plan, in [0,1].
   *
   * Advisory, and deliberately not acted on by the core: the service takes the
   * first *valid* plan, not the most confident one (see RFC-0003 §5.2). It exists
   * so a host can require approval below a threshold, and so a strategy can be
   * honest about a guess.
   */
  readonly confidence: number;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** A plan, plus what it took to get it. Returned by `PlannerService.plan`. */
export interface PlanResult {
  readonly plan: Plan;
  /** Strategies that declined or failed before one succeeded, in order tried. */
  readonly attempts: readonly StrategyAttempt[];
  /** Steps dropped by repair, with the reason. Empty when nothing was dropped. */
  readonly dropped: readonly DroppedStep[];
}

export interface StrategyAttempt {
  readonly strategy: string;
  readonly outcome: 'declined' | 'invalid' | 'threw' | 'accepted';
  /** Why it did not produce a usable plan. Absent when accepted. */
  readonly reason?: string;
}

export interface DroppedStep {
  readonly name: string;
  readonly reason: string;
}
