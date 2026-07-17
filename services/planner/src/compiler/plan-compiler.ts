/**
 * The compiler: `Plan` → `MissionSpec`.
 *
 * The single place where the planner's vocabulary meets the kernel's, and the
 * only file here that knows what a `MissionSpec` is. Everything upstream reasons
 * about plans; everything downstream reasons about missions; this is the seam.
 *
 * Pure. It does not submit, validate, or touch a runtime — deliberately, because
 * a compiler that could start a mission is a compiler nobody can call to "just
 * see what this would do".
 *
 * ## The projection is lossy, and that is correct
 *
 * `intent`, `rationale`, `confidence`, `optional`, and the plan id have no place
 * in the kernel's model — it is a scheduler and refuses to know why work exists
 * (RFC-0001 §2). They are not thrown away, though: they land in `metadata`, which
 * the kernel's own docs describe as carried and never interpreted
 * (`MissionSpec.goal`: "Human-readable statement of intent. Carried, never
 * interpreted"). So a compiled mission can still explain itself — through the
 * one channel the kernel provides for exactly that — and `@hermes/memory`
 * persists that metadata verbatim (RFC-0002 §4.3), which means the explanation
 * survives a restart.
 */

import type { MissionSpec, TaskSpec } from '@hermes/kernel';
import type { Plan, PlanStep } from '../model.js';

export interface CompileOptions {
  /**
   * Mission name. Defaults to a slug of the goal statement.
   *
   * The kernel requires a non-empty name and otherwise never reads it, so this is
   * purely what a human sees in a log or a `mission` row.
   */
  readonly name?: string;
  /** Merged over the metadata the compiler derives. A host's own tags win. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Project a plan onto the kernel's mission model.
 *
 * The plan is assumed valid: `PlannerService` validates before compiling, and
 * `Mission.create` validates again on the way in. Compiling an invalid plan is
 * not checked for here because it cannot produce a *valid* mission — the kernel
 * catches it, with a message about the graph that is no worse than one this
 * function could invent.
 */
export function compilePlan(plan: Plan, options: CompileOptions = {}): MissionSpec {
  return {
    name: options.name ?? slugify(plan.goal.statement),
    // The kernel carries `goal` without interpreting it, which is exactly what a
    // natural-language statement needs.
    goal: plan.goal.statement,
    tasks: plan.steps.map(compileStep),
    ...(plan.goal.failurePolicy === undefined
      ? {}
      : { failurePolicy: plan.goal.failurePolicy }),
    metadata: {
      // Provenance. The question "why did this mission run, and what decided
      // that?" is answerable from the mission alone, months later, because these
      // four fields travel with it into `mission.metadata` (RFC-0002 §4.3).
      planId: plan.id,
      planStrategy: plan.strategy,
      planRationale: plan.rationale,
      planConfidence: plan.confidence,
      plannedAt: plan.createdAt,
      ...(plan.goal.subject === undefined ? {} : { subject: plan.goal.subject }),
      ...plan.metadata,
      ...options.metadata,
    },
  };
}

function compileStep(step: PlanStep): TaskSpec {
  return {
    name: step.name,
    handler: { kind: step.capability.kind, name: step.capability.name },
    // `exactOptionalPropertyTypes` is on, so an explicit `undefined` is not the
    // same as an absent key. Each of these is spread conditionally rather than
    // assigned, so that "the planner said nothing" reaches the kernel as silence
    // and its own defaults apply — rather than as `undefined`, which would not
    // type-check against `TaskSpec`.
    ...(step.input === undefined ? {} : { input: step.input }),
    ...(step.dependsOn === undefined ? {} : { dependsOn: step.dependsOn }),
    ...(step.priority === undefined ? {} : { priority: step.priority }),
    ...(step.maxAttempts === undefined ? {} : { maxAttempts: step.maxAttempts }),
    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    metadata: {
      // The step's reason for existing, carried into the kernel's one
      // never-interpreted field. This is what makes a persisted `mission_task`
      // row readable by a human who has never seen the plan.
      intent: step.intent,
      ...(step.optional === true ? { optional: true } : {}),
      ...step.metadata,
    },
  };
}

/**
 * A goal statement, reduced to something reasonable to see in a log line.
 *
 * Not an identity: two goals can slug to the same name, and that is fine — the
 * kernel's mission ids are what identify a mission, and it derives no meaning
 * from a mission's name (it only requires it to be non-empty).
 */
export function slugify(statement: string): string {
  const slug = statement
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so "café" slugs to "cafe" rather than losing the
    // whole word to the non-ASCII filter below.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');

  // A statement with no ASCII-able characters at all — "日本語" — slugs to the
  // empty string, and the kernel rejects an empty mission name. Fall back rather
  // than fail: a mission with a dull name still runs.
  return slug === '' ? 'mission' : slug;
}
