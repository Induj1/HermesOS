/**
 * The strategy port: how a goal becomes a plan.
 *
 * This is the socket AI plugs into, and it is the reason the planner can exist
 * before any model does. The kernel says of its own `Agent` interface that "a
 * hand-written if/else, a rules table, and a future model-backed planner all
 * satisfy this interface identically... that is what keeps the kernel free of AI
 * while leaving the socket that AI plugs into" (kernel `agent.ts`). The same
 * argument applies one layer up, and this is the same shape of socket.
 *
 * Today `TemplateStrategy` is deterministic and needs no network. When a model
 * router arrives, an `LlmStrategy` implements this and goes *in front of* the
 * template one in the chain. Nothing else changes — and when the model is down,
 * the chain falls through to the deterministic strategy behind it, which is the
 * whole of "if AI fails, fall back to deterministic behaviour" (RFC-0003 §5.2).
 */

import type { Clock, Logger } from '@hermes/kernel';
import type { CapabilityCatalog } from './capability-catalog.js';
import type { Goal, Plan, PlanId, PlanStep } from '../model.js';

/**
 * What a strategy is given.
 *
 * Everything is injected; a strategy reads no ambient state and no `process.env`,
 * per the kernel's rule that configuration is injected, never discovered
 * (RFC-0001 §3).
 */
export interface PlanContext {
  /** What the system can do. A model-backed strategy renders this into its prompt. */
  readonly catalog: CapabilityCatalog;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Aborts when the caller gives up.
   *
   * Honouring it is not optional for anything that awaits: the kernel's
   * cancellation is cooperative (RFC-0001 §11.1), and a strategy that ignores its
   * signal is exactly the "held slot forever" failure that section describes,
   * relocated one layer up.
   */
  readonly signal: AbortSignal | undefined;
  /**
   * Mints a plan id. Injected rather than imported so tests are deterministic —
   * the same reason the kernel injects `IdGenerator` (kernel `ids.ts`).
   */
  newPlanId(): PlanId;
}

export interface PlanStrategy {
  /** Stable identifier. Appears in `Plan.strategy`, in logs, and in failure reports. */
  readonly name: string;
  /**
   * Propose a plan, or decline.
   *
   * **Returning `undefined` means "this goal is not mine"** — a normal outcome,
   * not a failure. It is what makes the chain a chain of responsibility rather
   * than a list of things that error: a template strategy declines every goal it
   * has no template for, and the next strategy gets its turn.
   *
   * **Throwing means "I should have handled this but broke"** — a network
   * failure, a model returning nonsense. The service catches it, records it, and
   * moves on to the next strategy. A strategy is never required to be defensive
   * on the service's behalf.
   *
   * The proposal need not be valid: `PlannerService` repairs and validates every
   * proposal before accepting it, so a strategy is free to be optimistic. It must
   * not, however, be *dishonest* — see `confidence` on {@link Plan}.
   */
  propose(goal: Goal, ctx: PlanContext): Promise<Plan | undefined>;
}

/**
 * Assemble a {@link Plan} from the parts a strategy actually decides.
 *
 * Every strategy would otherwise repeat the same six lines of bookkeeping — id,
 * timestamp, its own name, default confidence — and each repetition is a chance
 * to forget one. Exported because third-party strategies live outside this
 * package and deserve the same help.
 *
 * @param strategy Name of the proposing strategy. Recorded on the plan.
 * @param goal The goal being planned for, carried through unchanged.
 * @param steps The decomposition. Not validated here; the service does that.
 * @param details `rationale` explains the shape to a human; `confidence` in [0,1]
 *   says how much the strategy trusts it, defaulting to 1 for a deterministic
 *   strategy that either matched or declined.
 */
export function buildPlan(
  strategy: string,
  goal: Goal,
  steps: readonly PlanStep[],
  ctx: PlanContext,
  details: {
    readonly rationale: string;
    readonly confidence?: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Plan {
  return {
    id: ctx.newPlanId(),
    goal,
    steps,
    strategy,
    rationale: details.rationale,
    // 1 by default: a deterministic strategy that matched a goal is not guessing.
    // A strategy that *is* guessing has to say so explicitly, which is the right
    // way round — silence should not read as certainty.
    confidence: details.confidence ?? 1,
    createdAt: ctx.clock.now(),
    metadata: details.metadata ?? {},
  };
}
