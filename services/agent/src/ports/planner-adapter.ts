/**
 * The planning port: how an agent asks for a plan.
 *
 * ## Why an agent does not call the planner
 *
 * It could. The framework depends on `@hermes/planner` for `Goal`, and handing a
 * reasoner a `PlannerService` would work on the first try. It is rejected for the
 * same reason `PlanDecision` exists at all: planning is **expensive and
 * consequential** — a multi-step plan, possibly a model call, possibly money —
 * and a thing like that should be a decision a host can see, gate, cost or
 * refuse, rather than something that happens invisibly inside a reasoner.
 *
 * So the ordinary path for "this needs a plan" is a {@link PlanDecision}: the
 * agent hands the goal back and the host decides. That keeps the interesting
 * moment in the transcript.
 *
 * ## Then why does this port exist
 *
 * For the reasoner that must plan *in order to decide* — one weighing two
 * approaches by planning both and comparing their shape, which cannot be
 * expressed by handing a goal back and stopping. It is a real case and this is
 * the seam for it, deliberately narrow: one method, no compile, no execute. A
 * reasoner can obtain a plan and cannot start one.
 *
 * A host that does not want agents planning at all simply does not wire this in.
 * It is optional on the context, and a reasoner that needs it and did not get it
 * should abstain rather than guess.
 */

import type { Goal, Plan } from '@hermes/planner';

export interface PlannerAdapter {
  /**
   * Produce a plan for this goal.
   *
   * Returns the `Plan` and nothing else — not the `MissionSpec` it compiles to,
   * and not a mission. A plan is inspectable data (RFC-0003 §6); a `MissionSpec`
   * is a thing you hand a runtime. Returning the second would put "and now run
   * it" one call away from a reasoner, which is the boundary this whole subsystem
   * is drawn around.
   *
   * @throws Whatever the planner throws — `PlanningFailedError` when no strategy
   *   produced a valid plan. Not caught and flattened here: a reasoner asking for
   *   a plan usually wants to know *why* it could not have one, and the planner's
   *   error carries the whole chain (RFC-0003 §5.2).
   */
  plan(goal: Goal, signal?: AbortSignal): Promise<Plan>;
}
