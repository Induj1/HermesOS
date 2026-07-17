/**
 * PlannerService — the composition root and the public entry point.
 *
 * Everything below it is independently usable: the validator works without a
 * strategy, the compiler without a catalog, the replanner without either. This is
 * the assembled default, so a host writes one call rather than wiring five
 * objects and getting the clock wrong in one of them.
 *
 * ## The pipeline
 *
 * ```
 * goal ──▶ strategy chain ──▶ repair ──▶ validate ──▶ plan ──▶ compile ──▶ MissionSpec
 *            (first to           (drop      (reject      │
 *             produce a         optional    early)       └─▶ inspect / approve / store
 *             valid plan)       missing)
 * ```
 *
 * Each stage has one job, and every stage but the first is pure. That is what
 * makes the interesting behaviour testable without a runtime.
 *
 * ## Why the chain takes the first *valid* plan, not the *best* one
 *
 * There is no comparator that could rank two valid plans without knowing what the
 * user values — speed, cost, thoroughness, risk — and inventing one would bury a
 * product decision in a service. `confidence` is deliberately not used for
 * ranking: it is a strategy's report about itself, and a strategy that overstates
 * it would win every race it should lose.
 *
 * So order is policy, and it belongs to whoever composes the chain. Put the model
 * first if novelty matters; put templates first if cost and determinism do (they
 * usually do — RFC-0003 §5.2). Either way the chain is explicit, in one array, at
 * the composition root, rather than emergent from a scoring function nobody can
 * predict.
 *
 * ## Graceful degradation is the chain, not a special case
 *
 * A strategy that throws is recorded and the chain continues. That is the whole
 * of "if AI fails, fall back to deterministic behaviour": no try/catch at the call
 * site, no health check, no circuit breaker — a model-backed strategy that is down
 * simply throws, and the template strategy behind it answers. The mechanism is the
 * architecture.
 */

import { noopLogger, randomIds, systemClock } from '@hermes/kernel';
import type {
  Clock,
  IdGenerator,
  Logger,
  MissionSnapshot,
  MissionSpec,
} from '@hermes/kernel';
import { InvalidInputError, PlanningFailedError, toError } from './errors.js';
import { compilePlan, type CompileOptions } from './compiler/plan-compiler.js';
import type { Goal, Plan, PlanId, PlanResult, StrategyAttempt } from './model.js';
import { toPlanId } from './model.js';
import type { CapabilityCatalog } from './ports/capability-catalog.js';
import type { PlanContext, PlanStrategy } from './ports/plan-strategy.js';
import { repairPlan } from './validation/plan-repair.js';
import { PlanValidator } from './validation/plan-validator.js';
import { Replanner, type ReplanOptions } from './replan/replanner.js';

export interface PlannerServiceOptions {
  /**
   * The chain, tried in order. Order is policy — see the module header.
   *
   * An empty chain is rejected at construction rather than at the first goal: a
   * planner that can never plan is a wiring mistake, and it should fail where the
   * wiring is, not hours later in production.
   */
  readonly strategies: readonly PlanStrategy[];
  readonly catalog: CapabilityCatalog;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Injected so plan ids are deterministic in tests, as the kernel does for missions. */
  readonly ids?: IdGenerator;
}

export interface PlanRequest extends Goal {
  /** Aborts the chain. Honoured between strategies and passed to each. */
  readonly signal?: AbortSignal;
}

export class PlannerService {
  readonly validator: PlanValidator;
  readonly replanner: Replanner;

  readonly #strategies: readonly PlanStrategy[];
  readonly #catalog: CapabilityCatalog;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #ids: IdGenerator;

  constructor(options: PlannerServiceOptions) {
    if (options.strategies.length === 0) {
      throw new InvalidInputError([
        'PlannerService needs at least one strategy; with none it can never produce a plan',
      ]);
    }

    this.#strategies = options.strategies;
    this.#catalog = options.catalog;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? noopLogger;
    this.#ids = options.ids ?? randomIds;

    this.validator = new PlanValidator(options.catalog);
    this.replanner = new Replanner(this.#context(undefined));
  }

  /** The strategy chain, in the order it will be tried. For diagnostics. */
  get strategies(): readonly PlanStrategy[] {
    return this.#strategies;
  }

  /**
   * Turn a goal into a validated plan.
   *
   * Tries each strategy in order until one produces a plan that survives repair
   * and validation.
   *
   * @throws {PlanningFailedError} when no strategy produced a valid plan. The
   *   error carries the whole chain — what each strategy did and why — because
   *   "planning failed" alone makes a five-strategy chain undebuggable.
   */
  async plan(request: PlanRequest): Promise<PlanResult> {
    const goal = validateGoal(request);
    const attempts: StrategyAttempt[] = [];
    const ctx = this.#context(request.signal);

    for (const strategy of this.#strategies) {
      // Checked between strategies as well as inside them: a chain of five
      // strategies must not run the remaining four after the caller has gone.
      request.signal?.throwIfAborted();

      const outcome = await this.#tryStrategy(strategy, goal, ctx);
      attempts.push(outcome.attempt);

      if (outcome.result) {
        this.#logger.info('Planned', {
          strategy: strategy.name,
          steps: outcome.result.plan.steps.length,
          dropped: outcome.result.dropped.length,
          attempted: attempts.length,
        });
        return { ...outcome.result, attempts };
      }
    }

    this.#logger.warn('No strategy produced a valid plan', {
      goal: goal.statement,
      attempts,
    });
    throw new PlanningFailedError(goal.statement, attempts);
  }

  /**
   * Run one strategy, catching everything it can throw.
   *
   * The catch is the load-bearing part. A strategy is not required to be
   * defensive on the service's behalf — a model-backed one will throw on a
   * network blip, on a rate limit, on JSON that is not JSON — and every one of
   * those must degrade to "try the next strategy", never to an unhandled
   * rejection reaching the host.
   */
  async #tryStrategy(
    strategy: PlanStrategy,
    goal: Goal,
    ctx: PlanContext,
  ): Promise<{ attempt: StrategyAttempt; result?: PlanResult }> {
    let proposal: Plan | undefined;

    try {
      proposal = await strategy.propose(goal, ctx);
    } catch (thrown) {
      const error = toError(thrown);
      // An abort is the caller leaving, not the strategy failing. Trying the next
      // strategy would ignore the abort; recording it as a strategy fault would
      // blame the wrong thing. Propagate.
      if (ctx.signal?.aborted === true) throw error;

      this.#logger.warn('Strategy threw; falling through to the next', {
        strategy: strategy.name,
        error: error.message,
      });
      return {
        attempt: { strategy: strategy.name, outcome: 'threw', reason: error.message },
      };
    }

    if (!proposal) {
      return { attempt: { strategy: strategy.name, outcome: 'declined' } };
    }

    // Repair before validate, always. Repair drops optional steps whose
    // capabilities are missing; validating first would reject the plan for
    // exactly the steps repair was about to remove.
    const repaired = repairPlan(proposal, this.#catalog);
    const verdict = this.validator.validate(repaired.plan);

    if (!verdict.ok) {
      const reason = verdict.issues
        .map((issue) =>
          issue.step ? `${issue.step}: ${issue.message}` : issue.message,
        )
        .join('; ');
      this.#logger.debug('Strategy proposed an invalid plan', {
        strategy: strategy.name,
        issues: verdict.issues.length,
      });
      return { attempt: { strategy: strategy.name, outcome: 'invalid', reason } };
    }

    if (repaired.dropped.length > 0) {
      this.#logger.info('Dropped optional steps whose capabilities are missing', {
        strategy: strategy.name,
        dropped: repaired.dropped.map((step) => step.name),
      });
    }

    return {
      attempt: { strategy: strategy.name, outcome: 'accepted' },
      result: { plan: repaired.plan, attempts: [], dropped: repaired.dropped },
    };
  }

  /**
   * Project a validated plan onto the kernel's mission model.
   *
   * Separate from `plan()` on purpose: a host that wants a human to approve a
   * plan needs the plan first and the mission only afterwards. Fusing them would
   * make "show me what you would do" impossible to express.
   */
  compile(plan: Plan, options?: CompileOptions): MissionSpec {
    return compilePlan(plan, options);
  }

  /** Plan and compile in one step, for a host that does not want to inspect. */
  async planMission(
    request: PlanRequest,
    options?: CompileOptions,
  ): Promise<MissionSpec> {
    const { plan } = await this.plan(request);
    return this.compile(plan, options);
  }

  /**
   * Build a plan for the unfinished part of a mission that did not complete.
   *
   * Deterministic and strategy-free: recovery is the last thing that should
   * depend on a model being awake. Validated like any other plan, so a replan of
   * a mission whose plugin has since been removed fails here rather than at
   * dispatch.
   *
   * @throws {NothingToReplanError} when there is nothing left to do.
   * @throws {PlanValidationError} when the surviving steps no longer validate.
   */
  replan(snapshot: MissionSnapshot, options: ReplanOptions): Plan {
    const plan = this.replanner.replan(snapshot, options);
    this.validator.assertValid(plan);
    return plan;
  }

  #context(signal: AbortSignal | undefined): PlanContext {
    return {
      catalog: this.#catalog,
      clock: this.#clock,
      logger: this.#logger,
      signal,
      newPlanId: (): PlanId => toPlanId(this.#ids('plan')),
    };
  }
}

function validateGoal(request: PlanRequest): Goal {
  const issues: string[] = [];
  if (request.statement.trim() === '') issues.push('goal statement must not be empty');
  if (request.constraints?.maxSteps !== undefined && request.constraints.maxSteps < 1) {
    issues.push('constraints.maxSteps must be at least 1');
  }
  if (request.constraints?.maxDepth !== undefined && request.constraints.maxDepth < 1) {
    issues.push('constraints.maxDepth must be at least 1');
  }
  if (issues.length > 0) throw new InvalidInputError(issues);

  // `signal` is a property of *this call*, not of the goal, and a strategy that
  // received it on the goal might store it somewhere it outlives. Stripped here
  // so the goal that reaches a strategy — and gets carried onto the plan, and
  // compiled into mission metadata — is plain, serialisable data.
  const { signal: _signal, ...goal } = request;
  return goal;
}
