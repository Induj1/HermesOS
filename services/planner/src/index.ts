/**
 * @hermes/planner — goals in, missions out.
 *
 * The kernel runs a graph of tasks and refuses to know where the graph came from
 * (RFC-0001 §2: "the kernel decides *when* things run. It never knows *what* they
 * do"). Something has to decide the shape of that graph. This is that something.
 *
 * It depends on `@hermes/kernel`'s public interfaces and nothing else — not on
 * `@hermes/memory`, and not on any model. A goal becomes a validated plan, and a
 * plan compiles to a `MissionSpec` the host submits.
 *
 * ## What it buys you
 *
 * The kernel validates a mission's *graph* but never its *handlers* — resolution
 * happens at dispatch, so a mission naming a tool that does not exist is accepted,
 * runs its upstream tasks for real, and only then fails. The planner catches that
 * before anything runs. That is its primary justification; see
 * `ports/capability-catalog.ts` and `tests/kernel-gap.test.ts`, which pins the gap.
 *
 * ## The intended shape of a host
 *
 * ```ts
 * const planner = new PlannerService({
 *   strategies: [new TemplateStrategy(myTemplates)],   // an LlmStrategy goes in front, later
 *   catalog: new RuntimeCapabilityCatalog(runtime),
 *   logger,
 * });
 *
 * const { plan } = await planner.plan({ statement: 'Summarise my day', subject: 'ada' });
 * const snapshot = await runtime.run(planner.compile(plan));
 *
 * if (snapshot.state === 'failed') {
 *   // A settled mission cannot be resumed (RFC-0001 §11.3); it is succeeded by another.
 *   const recovery = planner.replan(snapshot, { incomplete: 'retry' });
 *   await runtime.run(planner.compile(recovery));
 * }
 * ```
 *
 * See `docs/rfcs/RFC-0003-planner.md` for why it is shaped this way.
 */

export { PlannerService } from './planner-service.js';
export type { PlannerServiceOptions, PlanRequest } from './planner-service.js';

export type {
  Capability,
  CapabilityKind,
  CapabilityRef,
  DroppedStep,
  Goal,
  Plan,
  PlanConstraints,
  PlanId,
  PlanResult,
  PlanStep,
  StrategyAttempt,
} from './model.js';
export { toPlanId } from './model.js';

export type {
  CapabilityCatalog,
  CapabilitySource,
} from './ports/capability-catalog.js';
export {
  CompositeCapabilityCatalog,
  RuntimeCapabilityCatalog,
  StaticCapabilityCatalog,
} from './ports/capability-catalog.js';

export type { PlanContext, PlanStrategy } from './ports/plan-strategy.js';
export { buildPlan } from './ports/plan-strategy.js';

export { TemplateStrategy, matches } from './strategies/template-strategy.js';
export type {
  PlanTemplate,
  TemplateMatcher,
  TemplateStrategyOptions,
} from './strategies/template-strategy.js';

export { PlanValidator, graphDepth } from './validation/plan-validator.js';
export type { ValidationResult } from './validation/plan-validator.js';
export { repairPlan } from './validation/plan-repair.js';
export type { RepairResult } from './validation/plan-repair.js';

export { compilePlan, slugify } from './compiler/plan-compiler.js';
export type { CompileOptions } from './compiler/plan-compiler.js';

export { Replanner } from './replan/replanner.js';
export type {
  IncompleteTaskPolicy,
  ReplanAnalysis,
  ReplanOptions,
} from './replan/replanner.js';

export {
  InvalidInputError,
  NothingToReplanError,
  PlannerError,
  PlanningFailedError,
  PlanValidationError,
  toError,
} from './errors.js';
export type { PlanIssue, PlannerErrorCode } from './errors.js';
