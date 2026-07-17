/**
 * Adapting `@hermes/memory` to the read-only port.
 *
 * Fourteen lines, and it is the entire enforcement of "agents never write
 * memory". `MemoryService` has `remember`, `forget`, `prune` and a `db` handle;
 * `MemoryAdapter` has `recall`. This narrows the first to the second, and once it
 * has, a reasoner holding the result cannot write even if it wanted to — there is
 * no method to call.
 *
 * That is why the adapter exists rather than passing `MemoryService` in whole.
 * The wide type carries the ability to do the thing the narrow one exists to
 * prevent, and "please do not call `remember`" is a rule, while this is a fact.
 * Same argument the planner makes for `CapabilitySource` over `Runtime`
 * (RFC-0003 §3.1).
 *
 * An agent that wants to remember something still can — by deciding to, with a
 * `ToolsDecision` naming `memory.remember`, which memory already registers as a
 * real tool. The write goes out through the same door as every other effect,
 * where the scheduler sees it, the audit log records it, and an approval
 * middleware can refuse it. See `ports/memory-adapter.ts`.
 */

import type { MemoryKind, MemoryService, ScoredMemory } from '@hermes/memory';
import { MEMORY_KINDS } from '@hermes/memory';
import type { MemoryAdapter, RecallLimits } from '../ports/memory-adapter.js';

/**
 * A read-only view onto a memory service.
 *
 * @param memory The service. Held, not copied — recall reads through, so an
 *   agent sees memories written a moment ago by a step in the same mission.
 */
export function memoryAdapter(memory: MemoryService): MemoryAdapter {
  return {
    recall: async (
      subject: string,
      text: string,
      options: RecallLimits = {},
    ): Promise<readonly ScoredMemory[]> => {
      // The port takes `readonly string[]` because a reasoner's kinds usually
      // came from a model and may be nonsense. Unknown ones are dropped rather
      // than rejected — a model asking for a kind that does not exist should get
      // the memories it *can* have, not an error it cannot act on.
      //
      // But when *every* requested kind is unknown, the filter empties, and
      // memory reads an empty `kinds` as "no filter" (RFC-0002 §9.7). Passing it
      // down would silently widen the request from "only vibes" to "every kind
      // there is" — a filter that fails open, which is the direction that lets an
      // agent see memories a host used `kinds` to keep it away from. Nothing is
      // the honest answer: for a kind that does not exist, there are no memories.
      const kinds =
        options.kinds === undefined ? undefined : narrowKinds(options.kinds);
      if (kinds?.length === 0) return [];

      return await memory.recall(subject, text, {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.minSimilarity === undefined
          ? {}
          : { minSimilarity: options.minSimilarity }),
        ...(kinds === undefined ? {} : { kinds }),
      });
    },
  };
}

/** Keep only the kinds memory actually has. */
function narrowKinds(kinds: readonly string[]): readonly MemoryKind[] {
  return kinds.filter((kind): kind is MemoryKind =>
    MEMORY_KINDS.includes(kind as MemoryKind),
  );
}
