/**
 * The reasoning port: how a request becomes a decision.
 *
 * This is the socket AI plugs into, and it is why the framework can exist before
 * any model does. The argument is the kernel's, made twice already and still
 * true: "a hand-written if/else, a rules table, and a future model-backed planner
 * all satisfy this interface identically... that is what keeps the kernel free of
 * AI while leaving the socket that AI plugs into" (kernel `agent.ts`).
 * `PlanStrategy` is the same shape (RFC-0003 §5.1). This is the third, and the
 * repetition is the point — one shape, learned once.
 *
 * ## An agent is identity plus a reasoner
 *
 * That split is the whole class model. `Agent` is a name, a description and some
 * tags; `Reasoner` is the brain. Swapping `RuleBasedReasoner` for `LlmReasoner`
 * changes nothing else about the agent — not its name, not its registration, not
 * its callers. Making reasoning a *field* rather than a subclass is what buys
 * that: an inheritance hierarchy would have made "the same agent, thinking
 * differently" a different class.
 */

import type { AgentContext } from '../context.js';
import type { AgentDecision, AgentRequest } from '../model.js';

export interface Reasoner {
  /** Stable identifier. Appears in logs and in a chain's account of itself. */
  readonly name: string;

  /**
   * Decide what should happen.
   *
   * **Returning an `abstain` decision means "this is not mine"** — a normal
   * outcome that hands the request to the next reasoner in a chain. Returning
   * `undefined` is not an option and there is deliberately no such variant: a
   * reasoner that declines should say so in the type everything else already
   * reads, rather than in a second channel every consumer has to check.
   *
   * **Throwing means "I should have handled this but broke"** — a model is down,
   * a response was not JSON. A chain records it and moves on; nothing is required
   * to be defensive on the chain's behalf. That is the whole of "if AI fails,
   * fall back to deterministic behaviour", and it is the same mechanism the
   * planner uses (RFC-0003 §5.2) rather than a second one.
   *
   * The decision need not be *executable*: a reasoner may ask for a tool that
   * does not exist. Validation belongs to whoever runs it, and a reasoner
   * required to check would need the registry — which would let it call one.
   */
  reason(request: AgentRequest, ctx: AgentContext): Promise<AgentDecision>;
}
