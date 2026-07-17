/**
 * Plan repair: drop what cannot run, keep what can.
 *
 * This is where "degrade gracefully" stops being a slogan and becomes an
 * algorithm. A plan proposed against an ideal world meets a runtime that is
 * missing a plugin; the question is whether that costs you the whole mission or
 * just the part that genuinely depended on it.
 *
 * Pure and synchronous: plan in, plan out, nothing touched.
 *
 * ## The rule
 *
 * A step marked `optional: true` whose capability is not registered is removed,
 * and **its dependents are rewired onto its own dependencies**. That rewiring is
 * the whole difficulty, and skipping it is the bug this module exists to avoid:
 * deleting a step and leaving `dependsOn: ['the-deleted-step']` behind produces a
 * plan that fails validation with "depends on unknown step" — trading a missing
 * capability for a broken graph, which is worse than doing nothing at all.
 *
 * The operation is **node contraction**. Given `a -> b -> c` (c depends on b, b
 * depends on a), dropping `b` must leave `a -> c`, not `c` floating free. Order
 * is preserved: `c` still runs after `a`, which is what `dependsOn` promised and
 * what a caller silently relies on.
 *
 * ## What is deliberately not repaired
 *
 * A **required** step with a missing capability. Repair does not touch it, and
 * validation then rejects the plan. That is the correct outcome: `optional` is
 * how an author says "this is a nice-to-have", and inferring that from silence
 * would mean quietly shipping a plan that does less than it claims. Silently
 * dropping work is the more dangerous failure, so it must be asked for.
 */

import type { CapabilityCatalog } from '../ports/capability-catalog.js';
import type { DroppedStep, Plan } from '../model.js';

export interface RepairResult {
  readonly plan: Plan;
  readonly dropped: readonly DroppedStep[];
}

/**
 * Remove optional steps whose capabilities are missing, rewiring their dependents.
 *
 * Returns the plan unchanged (by identity) when nothing needs dropping, so the
 * common path allocates nothing and a caller can cheaply test `result.plan ===
 * plan` to know whether reality matched the proposal.
 *
 * @param plan The proposal to repair.
 * @param catalog What is actually registered.
 */
export function repairPlan(plan: Plan, catalog: CapabilityCatalog): RepairResult {
  const doomed = new Map<string, string>();

  for (const step of plan.steps) {
    if (step.optional !== true) continue;
    if (catalog.has(step.capability.name, step.capability.kind)) continue;
    doomed.set(
      step.name,
      `optional step dropped: ${step.capability.kind} "${step.capability.name}" is not registered`,
    );
  }

  if (doomed.size === 0) return { plan, dropped: [] };

  const byName = new Map(plan.steps.map((step) => [step.name, step]));

  /**
   * The dependencies a survivor should inherit in place of `name`.
   *
   * Recursive because dropped steps can chain: with `a -> b -> c -> d` and both
   * `b` and `c` dropped, `d` must end up depending on `a`. Resolving one level
   * would leave `d` depending on `b`, which no longer exists.
   *
   * `seen` guards against a cycle among dropped steps. Validation reports cycles
   * separately and rejects the plan, but repair runs *before* that verdict is
   * acted on — so this must terminate on input that is about to be declared
   * invalid, rather than hang while producing the error message.
   */
  const substitutesFor = (name: string, seen: Set<string>): readonly string[] => {
    if (seen.has(name)) return [];
    seen.add(name);

    const step = byName.get(name);
    if (!step) return []; // dangling dep; validation reports it
    return (step.dependsOn ?? []).flatMap((dep) =>
      doomed.has(dep) ? substitutesFor(dep, seen) : [dep],
    );
  };

  const steps = plan.steps
    .filter((step) => !doomed.has(step.name))
    .map((step) => {
      const deps = step.dependsOn ?? [];
      if (!deps.some((dep) => doomed.has(dep))) return step;

      const rewired = [
        ...new Set(
          deps.flatMap((dep) =>
            doomed.has(dep) ? substitutesFor(dep, new Set()) : [dep],
          ),
        ),
      ];

      // A step whose every dependency was dropped becomes a root. `dependsOn: []`
      // and an absent `dependsOn` are the same thing to the kernel, so this is
      // spelled explicitly rather than deleted — the empty array is a record that
      // this step *used* to depend on something.
      return { ...step, dependsOn: rewired };
    });

  return {
    plan: {
      ...plan,
      steps,
      metadata: {
        ...plan.metadata,
        // The plan is no longer what the strategy proposed. Anything reading this
        // plan later — a log, an approval screen, an RFC-0002 mission record —
        // should be able to see that without diffing against a proposal it does
        // not have.
        repaired: true,
        droppedSteps: [...doomed.keys()],
      },
    },
    dropped: [...doomed].map(([name, reason]) => ({ name, reason })),
  };
}
