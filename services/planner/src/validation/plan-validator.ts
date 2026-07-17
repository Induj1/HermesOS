/**
 * Plan validation — everything that must be true before anything runs.
 *
 * Pure and synchronous. It takes a plan and a catalog and returns issues; it
 * touches nothing, awaits nothing, and logs nothing. That is what makes the
 * planner's most consequential rules testable without a runtime, a database, or a
 * model — the same payoff the kernel gets from keeping `Mission.refresh` pure
 * (RFC-0001 §12).
 *
 * ## What this checks that the kernel does not
 *
 * The kernel's `Mission.create` already rejects: empty names, an empty task list,
 * `maxAttempts < 1`, a non-positive `timeoutMs`, self-dependency, duplicate
 * names, missing dependencies, and cycles. **Re-checking those here is not
 * redundant**, and it is worth being explicit about why:
 *
 *   * A plan is rejected *before* a mission exists, so the error names a step and
 *     a strategy rather than a task and a mission the caller never authored.
 *   * The service tries the next strategy on an invalid plan (`§5.2`). That
 *     requires knowing invalidity *without* constructing a `Mission` and catching
 *     — exceptions as control flow across a chain of five strategies.
 *   * Validation runs before repair rewires the graph, and after. Only a pure
 *     function can be called twice for free.
 *
 * And the check the kernel genuinely cannot make: **do these capabilities
 * exist?** See `ports/capability-catalog.ts` for why that gap is real and what it
 * costs when nobody closes it.
 */

import { topoSort } from '@hermes/kernel';
import { PlanValidationError, type PlanIssue } from '../errors.js';
import type { CapabilityCatalog } from '../ports/capability-catalog.js';
import type { Plan, PlanConstraints, PlanStep } from '../model.js';

export type ValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly issues: readonly PlanIssue[] };

export class PlanValidator {
  readonly #catalog: CapabilityCatalog;

  constructor(catalog: CapabilityCatalog) {
    this.#catalog = catalog;
  }

  /**
   * Check a plan, returning **every** problem rather than the first.
   *
   * Modelled on the kernel's `MissionValidationError`, for its stated reason: an
   * author fixing a spec wants all the issues at once. That author is
   * increasingly a language model repairing its own output, for which a complete
   * issue list is the difference between one retry and five.
   */
  validate(plan: Plan): ValidationResult {
    const issues: PlanIssue[] = [
      ...this.#validateShape(plan.steps),
      ...this.#validateCapabilities(plan.steps),
      ...validateGraph(plan.steps),
      ...validateConstraints(plan.steps, plan.goal.constraints),
    ];
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  }

  /** Throwing form. `validate` is for the chain; this is for a caller who is done. */
  assertValid(plan: Plan): void {
    const result = this.validate(plan);
    if (!result.ok) throw new PlanValidationError(result.issues);
  }

  #validateShape(steps: readonly PlanStep[]): readonly PlanIssue[] {
    const issues: PlanIssue[] = [];

    if (steps.length === 0) {
      // The kernel rejects this too ("mission must have at least one task"), but
      // by then the caller is looking at a mission they did not write. A strategy
      // returning an empty plan is a strategy bug, and this says so.
      issues.push({ step: undefined, message: 'a plan must have at least one step' });
    }

    for (const step of steps) {
      if (step.name.trim() === '') {
        issues.push({ step: undefined, message: 'step name must not be empty' });
      }
      if (step.intent.trim() === '') {
        // Enforced, not merely typed. `intent` is the only thing that explains a
        // plan to someone who did not write it, and an unexplainable plan is one
        // nobody will let run unattended.
        issues.push({ step: step.name, message: 'intent must not be empty' });
      }
      if (step.capability.name.trim() === '') {
        issues.push({ step: step.name, message: 'capability name must not be empty' });
      }
      if (step.maxAttempts !== undefined && step.maxAttempts < 1) {
        issues.push({ step: step.name, message: 'maxAttempts must be at least 1' });
      }
      if (step.timeoutMs !== undefined && step.timeoutMs <= 0) {
        issues.push({ step: step.name, message: 'timeoutMs must be positive' });
      }
      if (step.priority !== undefined && !Number.isFinite(step.priority)) {
        issues.push({ step: step.name, message: 'priority must be a finite number' });
      }
    }

    return issues;
  }

  #validateCapabilities(steps: readonly PlanStep[]): readonly PlanIssue[] {
    const issues: PlanIssue[] = [];

    for (const step of steps) {
      const { kind, name } = step.capability;
      if (name.trim() === '') continue; // already reported by #validateShape

      if (this.#catalog.has(name, kind)) continue;

      // The most useful error this class produces, so it is worth the effort of
      // being specific. A step naming a real capability with the wrong kind is a
      // different mistake from one naming nothing at all, and the fixes differ.
      const otherKind = this.#catalog.find(name);
      if (otherKind) {
        issues.push({
          step: step.name,
          message:
            `wants ${kind} "${name}", but "${name}" is registered as a ${otherKind.kind}. ` +
            `Change the step's capability kind to "${otherKind.kind}".`,
        });
        continue;
      }

      issues.push({
        step: step.name,
        message:
          `wants ${kind} "${name}", which is not registered. ` +
          `The kernel resolves handlers at dispatch, so this would fail mid-mission ` +
          `after earlier steps had already run.${suggest(name, this.#catalog)}`,
      });
    }

    return issues;
  }
}

/**
 * Graph rules, via the kernel's own `topoSort`.
 *
 * Reused rather than reimplemented, and that is the point: `topoSort` is a public
 * kernel export used internally for exactly this ("used twice: to order a
 * mission's tasks and to order plugin setup", kernel `graph.ts`). Writing a
 * second cycle detector here would risk the planner accepting a graph the kernel
 * then rejects — two implementations of one rule, disagreeing at the worst
 * moment. One implementation cannot disagree with itself.
 */
function validateGraph(steps: readonly PlanStep[]): readonly PlanIssue[] {
  const issues: PlanIssue[] = [];

  for (const step of steps) {
    if (step.dependsOn?.includes(step.name) === true) {
      issues.push({ step: step.name, message: 'depends on itself' });
    }
  }

  const sorted = topoSort(
    steps.map((step) => ({ id: step.name, dependsOn: step.dependsOn ?? [] })),
  );

  if (!sorted.ok) {
    if (sorted.reason === 'duplicate') {
      issues.push({ step: sorted.id, message: `duplicate step name "${sorted.id}"` });
    } else if (sorted.reason === 'missing') {
      issues.push({
        step: sorted.from,
        message: `depends on unknown step "${sorted.missing}"`,
      });
    } else {
      issues.push({
        step: undefined,
        message: `dependency cycle: ${sorted.cycle.join(' -> ')}`,
      });
    }
  }

  return issues;
}

function validateConstraints(
  steps: readonly PlanStep[],
  constraints: PlanConstraints | undefined,
): readonly PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (!constraints) return issues;

  if (constraints.maxSteps !== undefined && steps.length > constraints.maxSteps) {
    issues.push({
      step: undefined,
      message: `plan has ${String(steps.length)} steps, exceeding maxSteps of ${String(constraints.maxSteps)}`,
    });
  }

  if (constraints.maxDepth !== undefined) {
    const depth = graphDepth(steps);
    if (depth > constraints.maxDepth) {
      issues.push({
        step: undefined,
        message: `plan is ${String(depth)} steps deep, exceeding maxDepth of ${String(constraints.maxDepth)}`,
      });
    }
  }

  return issues;
}

/**
 * Longest dependency chain, in steps.
 *
 * Depth bounds latency the way step count bounds work: a 40-step fan-out finishes
 * in one round at concurrency 40, while a 40-step chain cannot beat the sum of
 * its parts however many cores you give it.
 *
 * Returns 0 for a cyclic graph rather than looping forever. Callers reach here
 * only after `validateGraph` has already reported the cycle, so the number is
 * never read in that case — but a helper that hangs on bad input is a helper that
 * will eventually hang on bad input.
 */
export function graphDepth(steps: readonly PlanStep[]): number {
  const byName = new Map(steps.map((step) => [step.name, step]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (name: string): number => {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    if (visiting.has(name)) return 0; // cycle; reported elsewhere
    const step = byName.get(name);
    if (!step) return 0; // missing dep; reported elsewhere

    visiting.add(name);
    const deps = step.dependsOn ?? [];
    const depth = deps.length === 0 ? 1 : 1 + Math.max(...deps.map(depthOf));
    visiting.delete(name);

    memo.set(name, depth);
    return depth;
  };

  return steps.length === 0 ? 0 : Math.max(...steps.map((step) => depthOf(step.name)));
}

/**
 * Offer a near-miss, if there is an obvious one.
 *
 * "Unknown tool 'github.crate_issue'" is a fine error; "did you mean
 * 'github.create_issue'?" is the difference between a five-second fix and a
 * five-minute one. The threshold is deliberately tight — a wrong suggestion is
 * worse than none, because it sends the reader looking in the wrong place.
 */
function suggest(name: string, catalog: CapabilityCatalog): string {
  const candidates = catalog
    .list()
    .map((capability) => ({
      name: capability.name,
      distance: editDistance(name.toLowerCase(), capability.name.toLowerCase()),
    }))
    .filter((candidate) => candidate.distance <= Math.max(2, name.length * 0.25))
    .sort((a, b) => a.distance - b.distance);

  const best = candidates[0];
  return best ? ` Did you mean "${best.name}"?` : '';
}

/** Levenshtein distance, two rows at a time. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1, // insertion
        (previous[j] ?? 0) + 1, // deletion
        (previous[j - 1] ?? 0) + cost, // substitution
      );
    }
    previous = current;
  }

  return previous[b.length] ?? 0;
}
