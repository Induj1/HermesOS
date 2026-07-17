/**
 * The tool-selection port: which capabilities a reasoner is told about.
 *
 * ## Why this is not a detail
 *
 * A rule-based reasoner ignores it. A model-backed one lives or dies by it: every
 * capability offered is tokens spent on every turn, and a model handed sixty
 * tools picks worse than the same model handed the six that matter. So "which
 * tools does this agent get to see" is a real decision with real cost, and the
 * two obvious answers — all of them, or a hardcoded list per agent — are both
 * wrong for a system whose capabilities arrive from plugins at runtime.
 *
 * Making it a port means an agent can be given `AllTools` today and a
 * retrieval-backed selector later, with nothing else changing. That is the same
 * bet as `Reasoner`: the thing that will eventually need a model is an interface
 * before the model exists.
 *
 * ## Why selection is not filtering-in-the-reasoner
 *
 * A reasoner could filter `ctx.executor.available()` itself. Then every reasoner
 * would carry its own copy of the policy, they would drift, and the one place a
 * host wants to say "this agent may not see the payment tools" would be N places.
 */

import type { AgentRequest } from '../model.js';
import type { AvailableCapability } from './agent-executor.js';

export interface ToolSelectionStrategy {
  readonly name: string;

  /**
   * Choose what to offer, from what exists.
   *
   * Pure and synchronous by design. An implementation that wanted to embed the
   * request and rank tools by similarity cannot fit here — and that is the
   * intended pressure: doing so would make *every turn of every agent* wait on an
   * embedding call. A selector that needs I/O belongs behind a cache the host
   * builds, and it can populate one from outside and select from it here.
   *
   * Returning an empty list is legal and means "no tools this turn". It is not an
   * error: an agent that should answer from memory alone is expressed exactly
   * that way.
   */
  select(
    request: AgentRequest,
    available: readonly AvailableCapability[],
  ): readonly AvailableCapability[];
}
