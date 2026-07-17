/**
 * Plan → MissionSpec, with every step wrapped in an envelope.
 *
 * The planner has a compiler of its own (`compilePlan`) that projects a `Plan`
 * onto a `MissionSpec` with real handlers. This one deliberately does something
 * different, and both are right for their caller:
 *
 * | | planner's `compilePlan` | this |
 * | --- | --- | --- |
 * | handler | the real capability | `agent:hermes.step` |
 * | step data flow | impossible | `$from` resolved at dispatch |
 * | for | a host that runs a plan directly | the execution engine |
 *
 * A host that does not need data flow should keep using the planner's compiler
 * and skip this package entirely — it is simpler, and its missions read
 * honestly in the audit log. This exists for the case the planner named as its
 * sharpest limitation (RFC-0003 §7.1) and could not fix from where it sits.
 *
 * The planner's compiler is not wrapped or extended here. Wrapping it would mean
 * building a spec with real handlers and then rewriting every task, which is
 * more code and a standing invitation to drift. The two compilers agree on the
 * parts that matter — names, ordering, priorities, attempt budgets — because
 * both are projecting the same `Plan`, and `execution-compiler.test.ts` pins
 * that agreement.
 */

import type { MissionSpec, TaskSpec } from '@hermes/kernel';
import type { Plan, PlanStep } from '@hermes/planner';
import { slugify } from '@hermes/planner';
import { validateRefs } from '../refs.js';
import type { StepEnvelope } from './step-envelope.js';
import { STEP_AGENT_NAME } from './step-envelope.js';

export interface CompileExecutionOptions {
  /**
   * Which execution these tasks belong to. Stamped into every envelope.
   *
   * Required, and it is what lets one envelope agent serve every execution in
   * the process — see {@link StepEnvelope.executionId}.
   */
  readonly executionId: string;
  /** The mission's name. Defaults to a slug of the goal, as the planner's does. */
  readonly name?: string;
  /** The envelope agent's registered name. Defaults to {@link STEP_AGENT_NAME}. */
  readonly envelope?: string;
  /** Extra mission metadata, merged under the engine's own keys. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Steps to leave out.
   *
   * How a resume runs only the unfinished part: the steps that already succeeded
   * are excluded, and any `dependsOn` naming them is dropped, because the
   * dependency is *satisfied* — the same reasoning, and the same hazard, as
   * `Replanner` (RFC-0003 §7.2). Their results stay in the execution context, so
   * a surviving step's `$from` still resolves to them. That is precisely why the
   * context outlives the mission.
   */
  readonly exclude?: readonly string[];
}

/**
 * Compile a plan into a mission the kernel will run.
 *
 * @throws {InvalidReferenceError} if any `$from` names a step that is not in the
 *   plan, or is not a declared dependency of the step referencing it. Checked
 *   here, before anything runs, for the same reason the planner checks
 *   capabilities here rather than at dispatch (RFC-0003 §4): the alternative is
 *   discovering it after the upstream half has already had its effects.
 */
export function compileExecution(
  plan: Plan,
  options: CompileExecutionOptions,
): MissionSpec {
  const excluded = new Set(options.exclude ?? []);
  const envelope = options.envelope ?? STEP_AGENT_NAME;

  // Validated against the *whole* plan, not the surviving subset. A reference
  // into an excluded step is legal — it resolves from the context — so checking
  // only what runs would reject a correct resume.
  validateRefs(plan.steps);

  const tasks = plan.steps
    .filter((step) => !excluded.has(step.name))
    .map((step) => toTask(step, options.executionId, envelope, excluded));

  return {
    name: options.name ?? slugify(plan.goal.statement),
    goal: plan.goal.statement,
    tasks,
    ...(plan.goal.failurePolicy === undefined
      ? {}
      : { failurePolicy: plan.goal.failurePolicy }),
    metadata: {
      ...options.metadata,
      // Written last so a caller cannot overwrite the engine's own provenance
      // with a same-named key — the audit log's account of which plan produced
      // this mission has to be trustworthy.
      planId: plan.id,
      strategy: plan.strategy,
      ...(plan.goal.subject === undefined ? {} : { subject: plan.goal.subject }),
    },
  };
}

function toTask(
  step: PlanStep,
  executionId: string,
  envelope: string,
  excluded: ReadonlySet<string>,
): TaskSpec {
  const input: StepEnvelope = {
    executionId,
    step: step.name,
    capability: step.capability,
    ...(step.input === undefined ? {} : { input: step.input }),
  };

  return {
    name: step.name,
    handler: { kind: 'agent', name: envelope },
    input,
    // An excluded step already succeeded, so the edge is dropped rather than
    // preserved: the mission does not contain it, and the kernel rejects a spec
    // depending on a task that is not there.
    dependsOn: (step.dependsOn ?? []).filter((dep) => !excluded.has(dep)),
    ...(step.priority === undefined ? {} : { priority: step.priority }),
    ...(step.maxAttempts === undefined ? {} : { maxAttempts: step.maxAttempts }),
    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    metadata: {
      ...step.metadata,
      // The mitigation for this design's one real cost. The kernel's view of the
      // handler is `agent:hermes.step` for every task, so without these two keys
      // `@hermes/memory`'s projection could not say what any task actually did.
      // See `step-envelope.ts` and RFC-0004 §7.1.
      intent: step.intent,
      capability: `${step.capability.kind}:${step.capability.name}`,
    },
  };
}
