/**
 * Replanning: turning a failed mission back into a plan.
 *
 * The kernel freezes a mission's DAG at creation — "nothing can add a task to a
 * running mission" (RFC-0001 §11.3) — and a settled mission is settled for good:
 * `succeeded`, `failed`, and `cancelled` are terminal states with no outgoing
 * transitions. So a mission cannot be resumed. It can only be *succeeded by
 * another mission*, and RFC-0001 §11.3 names that as the recommended shape:
 * "a mission per plan step, composed by a service above the kernel. Cheapest; no
 * kernel change."
 *
 * This is that service, doing that composition. Given the snapshot of a mission
 * that did not finish, it produces a plan for the part that did not happen.
 *
 * Deterministic and pure: no model, no network, no clock beyond the injected one.
 * Recovery is the last thing that should depend on a language model being awake.
 *
 * ## The honest caveat, stated once and loudly
 *
 * **A task that was `running` when the process died has genuinely unknown
 * status.** RFC-0001 §11.2 says exactly this: "did the effect happen? That is an
 * at-least-once/idempotency conversation." Replanning it means running it again,
 * and whether that is safe depends entirely on whether its tool is idempotent —
 * which the kernel does not model and this service cannot know.
 *
 * So `IncompleteTaskPolicy` makes the choice explicit and refuses to have a safe
 * default, because there is no safe default: `retry` may double-send an email,
 * and `skip` may silently drop the only step that mattered. The caller knows
 * their tools; this code does not. See RFC-0003 §7.2.
 */

import type { MissionSnapshot, TaskSnapshot, TaskState } from '@hermes/kernel';
import { NothingToReplanError } from '../errors.js';
import { buildPlan, type PlanContext } from '../ports/plan-strategy.js';
import type { Goal, Plan, PlanStep } from '../model.js';

/**
 * What to do with a task whose fate is unknown — one that was `running` when
 * everything stopped.
 *
 * `retry`  — run it again. Right when tools are idempotent, which is the
 *            property a tool should be designed for but is not required to have.
 * `skip`   — leave it out, and drop the steps that depended on it. Right when a
 *            repeated effect is worse than a missing one (a payment, a message).
 * `fail`   — refuse to replan at all. Right when a human must look first. The
 *            correct default for anything with irreversible side effects.
 */
export type IncompleteTaskPolicy = 'retry' | 'skip' | 'fail';

export interface ReplanOptions {
  /**
   * How to treat tasks left `running` or `ready` by a crash.
   *
   * Required. There is deliberately no default — see the module header. A default
   * here would be this code guessing about side effects it cannot see.
   */
  readonly incomplete: IncompleteTaskPolicy;
  /**
   * Also re-run tasks that succeeded. Default false.
   *
   * For the case where a mission is a pure computation and partial results are
   * not trustworthy — a rebuild rather than a resume.
   */
  readonly includeSucceeded?: boolean;
  /**
   * Override the goal. Defaults to one reconstructed from the snapshot.
   *
   * Useful when the original goal is known to the caller in richer form than the
   * kernel's single `goal` string preserved.
   */
  readonly goal?: Goal;
}

/** Which tasks a replan will and will not carry, and why. Returned for inspection. */
export interface ReplanAnalysis {
  readonly missionId: string;
  /** Tasks that will be re-run, by name. */
  readonly resume: readonly string[];
  /** Tasks left out because they already succeeded. */
  readonly completed: readonly string[];
  /**
   * Tasks left out, with the state they were left in.
   *
   * Under a `skip` policy this is the mid-flight task *and everything downstream
   * of it*: a dependent whose prerequisite is not carried cannot run, so it is
   * abandoned too rather than silently promoted into a step with no dependency.
   * See {@link abandonDependents}.
   */
  readonly abandoned: readonly { readonly name: string; readonly state: TaskState }[];
}

/**
 * States a replan carries forward.
 *
 * `skipped` is included and it is worth saying why: the kernel marks a task
 * skipped when an upstream dependency did not succeed (`Mission.refresh`). It
 * never ran, so it is not a fate — it is work still outstanding. Excluding it
 * would silently drop the entire downstream half of a mission that failed at its
 * first step, which is precisely the half a replan is for.
 */
const RESUMABLE: readonly TaskState[] = ['failed', 'skipped', 'pending', 'cancelled'];

/** States whose effects may or may not have landed. See {@link IncompleteTaskPolicy}. */
const UNCERTAIN: readonly TaskState[] = ['running', 'ready'];

export class Replanner {
  readonly #ctx: PlanContext;

  constructor(ctx: PlanContext) {
    this.#ctx = ctx;
  }

  /**
   * What a replan would do, without doing it.
   *
   * Pure and cheap, so it can be logged, shown for approval, or asserted on in a
   * test. Same plan/apply split as `@hermes/memory`'s pruner, for the same
   * reason: the dangerous decision should be inspectable before it is taken.
   */
  analyse(snapshot: MissionSnapshot, options: ReplanOptions): ReplanAnalysis {
    const resume = new Set<string>();
    const completed = new Set<string>();
    const abandoned = new Set<string>();

    for (const task of snapshot.tasks) {
      if (task.state === 'succeeded' && options.includeSucceeded !== true) {
        completed.add(task.name);
      } else if (RESUMABLE.includes(task.state) || task.state === 'succeeded') {
        resume.add(task.name);
      } else if (UNCERTAIN.includes(task.state) && options.incomplete === 'retry') {
        resume.add(task.name);
      } else {
        abandoned.add(task.name);
      }
    }

    abandonDependents(snapshot, resume, completed, abandoned);

    // Rebuilt in snapshot order rather than in discovery order: the order tasks
    // were declared in is the one a human reading the analysis expects, and the
    // closure below discovers them breadth-first from wherever the failure was.
    const inOrder = (names: ReadonlySet<string>): string[] =>
      snapshot.tasks.filter((task) => names.has(task.name)).map((task) => task.name);

    return {
      missionId: snapshot.id,
      resume: inOrder(resume),
      completed: inOrder(completed),
      abandoned: snapshot.tasks
        .filter((task) => abandoned.has(task.name))
        .map((task) => ({ name: task.name, state: task.state })),
    };
  }

  /**
   * Build a plan for the unfinished part of a mission.
   *
   * Dependencies on tasks that already succeeded are **dropped**, not preserved:
   * the new mission does not contain them, so a surviving `dependsOn` would name
   * a task that does not exist and the kernel would reject the whole spec
   * ("depends on unknown task"). Dropping is also semantically right — the
   * dependency is satisfied; that is what "succeeded" means.
   *
   * A dependency that was *abandoned* rather than satisfied is a different matter
   * entirely, and dropping that edge would be a bug: the dependent is abandoned
   * with it. See {@link abandonDependents}.
   *
   * @throws {NothingToReplanError} when nothing is left to carry — either every
   *   task succeeded, or a `skip` policy abandoned all the remaining work.
   * @throws {NothingToReplanError} when an uncertain task exists and the policy is
   *   `fail` — the mission needs a human, not a retry.
   */
  replan(snapshot: MissionSnapshot, options: ReplanOptions): Plan {
    const analysis = this.analyse(snapshot, options);

    if (options.incomplete === 'fail') {
      const uncertain = snapshot.tasks.filter((task) => UNCERTAIN.includes(task.state));
      if (uncertain.length > 0) {
        throw new NothingToReplanError(
          snapshot.id,
          `it is ${snapshot.state}, but ${String(uncertain.length)} task(s) were mid-flight ` +
            `(${uncertain.map((task) => `"${task.name}"`).join(', ')}) and the incomplete ` +
            `policy is "fail". Their effects may or may not have landed; decide with ` +
            `"retry" or "skip"`,
        );
      }
    }

    if (analysis.resume.length === 0) {
      // Two different situations, and conflating them sends the reader the wrong
      // way: "everything succeeded" is a mission that is simply done, while
      // "everything was abandoned" is a `skip` that swallowed the mission whole
      // and probably wanted `retry`.
      throw new NothingToReplanError(
        snapshot.id,
        analysis.abandoned.length > 0
          ? `it is ${snapshot.state}; ${String(analysis.completed.length)} task(s) already ` +
              `succeeded and ${String(analysis.abandoned.length)} were abandoned under the ` +
              `"${options.incomplete}" policy, leaving no work to carry`
          : `it is ${snapshot.state} and every task already succeeded`,
      );
    }

    const carried = new Set(analysis.resume);
    const byName = new Map(snapshot.tasks.map((task) => [task.name, task]));

    const steps = analysis.resume
      .map((name) => byName.get(name))
      .filter((task): task is TaskSnapshot => task !== undefined)
      .map((task): PlanStep => {
        const deps = task.dependsOn.filter((dep) => carried.has(dep));
        return {
          name: task.name,
          intent: intentOf(task),
          capability: { kind: task.handler.kind, name: task.handler.name },
          ...(task.input === undefined ? {} : { input: task.input }),
          dependsOn: deps,
          priority: task.priority,
          maxAttempts: task.maxAttempts,
          metadata: {
            ...task.metadata,
            // Provenance for the humans and for RFC-0002's mission audit log: this
            // task is a second attempt, and here is where the first one died.
            replannedFrom: snapshot.id,
            previousState: task.state,
            previousAttempts: task.attempts,
          },
        };
      });

    const goal = options.goal ?? goalFrom(snapshot);

    return buildPlan('replan', goal, steps, this.#ctx, {
      rationale:
        `Resuming mission "${snapshot.name}" (${snapshot.id}), which ${snapshot.state}. ` +
        `Carrying ${String(steps.length)} unfinished step(s); ` +
        `${String(analysis.completed.length)} already succeeded and ` +
        `${String(analysis.abandoned.length)} abandoned.`,
      // Deterministic: this is derived from a snapshot, not guessed. Whether
      // re-running is *safe* is the caller's call via IncompleteTaskPolicy, and is
      // a different question from whether this plan is what it claims to be.
      confidence: 1,
      metadata: {
        replannedFrom: snapshot.id,
        incompletePolicy: options.incomplete,
        abandoned: analysis.abandoned.map((task) => task.name),
      },
    });
  }
}

/**
 * Abandon everything downstream of an abandoned task, transitively.
 *
 * Without this, `skip` does the opposite of what it promises. The plan compiler
 * drops a `dependsOn` naming a task the new mission does not contain — it has to,
 * or the kernel rejects the spec for depending on an unknown task — so a
 * dependent of a skipped task would survive with its edge silently deleted and
 * run *immediately*, with no prerequisite. Skipping a mid-flight `charge-card`
 * would then send the receipt for a payment that may never have happened. The
 * caller asked for one less effect and would have got a worse one.
 *
 * Dropping a dependency is only sound when the dependency is *satisfied*, which
 * is what `succeeded` means and is why `completed` tasks are not poisoned and
 * block propagation: a step whose prerequisite already succeeded is genuinely
 * free to run, and the chain is broken there. Only tasks that would re-run can be
 * poisoned, so under `includeSucceeded` a carried succeeded task is poisoned like
 * any other — it would run again, and its prerequisite would not.
 *
 * Mutates the sets in place; they are the caller's locals, never exposed.
 */
function abandonDependents(
  snapshot: MissionSnapshot,
  resume: Set<string>,
  completed: ReadonlySet<string>,
  abandoned: Set<string>,
): void {
  const dependents = new Map<string, string[]>();
  for (const task of snapshot.tasks) {
    for (const dep of task.dependsOn) {
      const existing = dependents.get(dep);
      if (existing) existing.push(task.name);
      else dependents.set(dep, [task.name]);
    }
  }

  // Breadth-first from every task already abandoned. Iterating an array while
  // pushing to it is deliberate and safe: the array iterator reads by index, so
  // a task appended here is visited later in this same loop. Terminates because
  // a task is appended only on joining `abandoned`, and it joins at most once.
  const queue = [...abandoned];
  for (const name of queue) {
    for (const dependent of dependents.get(name) ?? []) {
      if (completed.has(dependent) || abandoned.has(dependent)) continue;
      if (!resume.has(dependent)) continue;
      resume.delete(dependent);
      abandoned.add(dependent);
      queue.push(dependent);
    }
  }
}

/**
 * Recover a step's intent from its task metadata.
 *
 * `compilePlan` writes `intent` into `TaskSpec.metadata`, and the kernel carries
 * metadata through to the snapshot untouched — so a mission this planner compiled
 * round-trips its own explanations, even across a process restart via
 * `@hermes/memory`. A mission authored by hand has no intent to recover, and gets
 * an honest placeholder rather than a fabricated rationale.
 */
function intentOf(task: TaskSnapshot): string {
  const intent = task.metadata['intent'];
  if (typeof intent === 'string' && intent.trim() !== '') return intent;
  return `Re-run task "${task.name}" (${task.handler.kind} "${task.handler.name}")`;
}

/**
 * Reconstruct a goal from a snapshot.
 *
 * The kernel keeps `goal` as an optional free-text field it never interprets, so
 * this is usually just reading it back. `subject` is recovered from metadata,
 * where `compilePlan` put it — which is what lets a replanned mission stay
 * attached to the right memory subject.
 */
function goalFrom(snapshot: MissionSnapshot): Goal {
  const subject = snapshot.metadata['subject'];
  return {
    statement: snapshot.goal ?? `Complete mission "${snapshot.name}"`,
    ...(typeof subject === 'string' ? { subject } : {}),
    failurePolicy: snapshot.failurePolicy,
  };
}
