/**
 * The memory port: what an agent may remember, and what it may not do about it.
 *
 * ## Read-only, and enforced by the type
 *
 * "Agents may read memory. Agents never write directly." There is no `remember`
 * on this interface, and that is the enforcement — not a convention, not a
 * review comment. A reasoner cannot write a memory because it has nothing to
 * write one with.
 *
 * Which raises the obvious question: how does anything ever get remembered? An
 * agent that learns something worth keeping **decides** to keep it — a
 * `ToolsDecision` naming `memory.remember`, which `@hermes/memory` already
 * registers as a real tool through its plugin. So the write goes out through the
 * same door as every other effect: a decision, executed by something else, with
 * an observation coming back. It is visible to the scheduler, it appears in the
 * audit log, and an approval gate can refuse it.
 *
 * That is worth more than it costs. A reasoner holding `MemoryService` could
 * write on a path nobody watches, and "the agent remembered something during
 * reasoning" is exactly the effect you want to be able to see, cost, and veto.
 *
 * ## Why an adapter and not `MemoryService`
 *
 * The framework depends on `@hermes/memory` already, so `MemoryService` could be
 * passed in whole. It is not, for the same reason `CapabilitySource` is not a
 * `Runtime` (RFC-0003 §3.1): the wide type carries the ability to do the thing
 * the narrow one exists to prevent. `MemoryService` has `remember`, `forget`, and
 * a `db` handle. Handing that to a reasoner and asking it not to write is a rule;
 * handing it this is a fact.
 */

import type { ScoredMemory } from '@hermes/memory';

export interface MemoryAdapter {
  /**
   * Memories relevant to this text, best first.
   *
   * Scoped by `subject`, which is memory's isolation boundary (RFC-0002 §9.5).
   * The framework has no user model and does not interpret it.
   */
  recall(
    subject: string,
    text: string,
    options?: RecallLimits,
  ): Promise<readonly ScoredMemory[]>;
}

export interface RecallLimits {
  readonly limit?: number;
  /**
   * Which kinds to consider.
   *
   * Typed as `readonly string[]` rather than memory's `MemoryKind` union
   * deliberately. A reasoner passing kinds usually got them from a model, and
   * they may be nonsense; `memory.recall` already drops unknown kinds rather than
   * rejecting them (RFC-0002 §9.7), and narrowing here would force a cast at
   * every call site to reach the behaviour that already handles it.
   */
  readonly kinds?: readonly string[];
  readonly minSimilarity?: number;
}
