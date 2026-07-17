/**
 * Middleware — what wraps a decision.
 *
 * The cross-cutting seam: logging, timing, guards, redaction, approval gates.
 * The shape is the one every reader already knows — `(request, ctx, next)` — and
 * that familiarity is the argument for it. An `onBeforeDecide` / `onAfterDecide`
 * hook pair would be more discoverable and strictly less capable: it cannot wrap
 * a `try`/`finally` around the call, cannot short-circuit without a sentinel
 * return, and cannot time the thing it brackets without stashing state between
 * two callbacks.
 *
 * ## What middleware is for, and the one thing it is really for
 *
 * A guard. `next` returns an `AgentDecision`, which is *data describing what
 * should happen* and has not happened yet — so a middleware can read it, rewrite
 * it, or refuse it, and nothing has been done in the meantime. That is only
 * possible because agents decide rather than act; in a framework where the agent
 * had already run the tool, an "approval" middleware could only apologise.
 *
 * ```ts
 * const requireApproval: AgentMiddleware = async (request, ctx, next) => {
 *   const decision = await next(request, ctx);
 *   if (decision.kind !== 'tools') return decision;
 *   const risky = decision.requests.filter((r) => r.name.startsWith('payment.'));
 *   if (risky.length === 0) return decision;
 *   return { kind: 'answer', content: 'That needs a human.', rationale: '…' };
 * };
 * ```
 */

import type { AgentContext } from './context.js';
import type { AgentDecision, AgentRequest } from './model.js';
import type { Reasoner } from './ports/reasoner.js';

/** The next link. Calling it runs the rest of the chain and then the reasoner. */
export type NextDecision = (
  request: AgentRequest,
  ctx: AgentContext,
) => Promise<AgentDecision>;

/**
 * Wrap a decision.
 *
 * Both `request` and `ctx` are passed on rather than closed over, so a middleware
 * can rewrite either — narrowing `ctx.capabilities` before a reasoner sees them
 * is a real use, and it is the enforcement point a `ToolSelectionStrategy` cannot
 * be, because a strategy is the agent's own declaration and a middleware is the
 * host's.
 */
export type AgentMiddleware = (
  request: AgentRequest,
  ctx: AgentContext,
  next: NextDecision,
) => Promise<AgentDecision>;

/**
 * Wrap a reasoner in middleware.
 *
 * The **first** middleware in the array is the outermost — it sees the request
 * first and the decision last. That is the order everyone means by "middleware"
 * and the opposite of what a naive `reduce` produces, which is why this reduces
 * from the right.
 *
 * Returns a `Reasoner`, not a special type. So a wrapped reasoner goes anywhere a
 * reasoner goes: inside a `ReasonerChain`, wrapped again, or straight onto an
 * agent. Nothing downstream can tell it was wrapped, and nothing has to know.
 */
export function withMiddleware(
  reasoner: Reasoner,
  middleware: readonly AgentMiddleware[],
): Reasoner {
  if (middleware.length === 0) return reasoner;

  const wrapped = [...middleware].reverse().reduce<NextDecision>(
    (next, layer) => (request, ctx) => layer(request, ctx, next),
    (request, ctx) => reasoner.reason(request, ctx),
  );

  return {
    // The name is the reasoner's, unchanged. A middleware is not a decision-maker
    // and should not appear as one in a chain's account of itself: an operator
    // reading "logging abstained" would go looking for a reasoner that does not
    // exist.
    name: reasoner.name,
    reason: async (request, ctx) => await wrapped(request, ctx),
  };
}
