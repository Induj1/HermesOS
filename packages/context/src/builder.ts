/**
 * The context builder — pack a model prompt into a token budget, deterministically.
 *
 * An agent turn has more candidate context than fits: a system instruction, the
 * conversation so far, memories retrieved for this turn, and the tool definitions
 * the model will be given. The builder decides *what makes the cut* under a token
 * budget, and it does so by a fixed priority so the same inputs always produce the
 * same prompt — which is what makes an agent's behaviour reproducible and its
 * regressions debuggable.
 *
 * ## The priority, highest first
 *
 * 1. **System instruction** — always included; it defines the agent.
 * 2. **Tool definitions** — their token cost is reserved (the caller passes it),
 *    because the model is given the tools regardless; the builder just accounts
 *    for the space they take.
 * 3. **Recent history** — included newest-first until the budget runs out, then
 *    emitted in chronological order. The most recent turns matter most.
 * 4. **Retrieved memory** — included by descending relevance score until the
 *    remaining budget runs out.
 *
 * ## Why this shape and not "summarise the overflow"
 *
 * Summarisation needs a model call, which is slow, costs money, and is
 * non-deterministic — three things a context assembler should not be. Dropping by
 * priority is deterministic and free, and the caller who wants summarisation can
 * do it *before* handing history in. The builder's job is the mechanical,
 * reproducible part.
 */

import type { ModelMessage } from '@hermes/model';
import { charEstimator, estimateMessage, type TokenEstimator } from './estimate.js';

/** A memory retrieved for this turn, to be included by relevance if it fits. */
export interface MemorySnippet {
  readonly id: string;
  readonly text: string;
  /** Relevance score; higher is included first. Absent scores rank last, in order. */
  readonly score?: number;
}

export interface ContextRequest {
  /** The system instruction. Always included. */
  readonly system?: string;
  /** Conversation so far, in chronological order. Trimmed newest-first if needed. */
  readonly history?: readonly ModelMessage[];
  /** Memories retrieved for this turn; included by descending score while they fit. */
  readonly memories?: readonly MemorySnippet[];
  /** Tokens the tool definitions will cost the model (reserved, not emitted here). */
  readonly toolTokens?: number;
}

export interface ContextBuilderOptions {
  /** The model's context window in tokens. */
  readonly maxTokens: number;
  /** Tokens held back for the model's reply. Default 1024. */
  readonly reserveForResponse?: number;
  /** Token estimator. Defaults to the ~chars/4 heuristic. */
  readonly estimate?: TokenEstimator;
  /** Preamble prefixed to the retrieved-memory block. */
  readonly memoryHeader?: string;
}

/** The assembled prompt and an account of what was kept and dropped. */
export interface AssembledContext {
  /** The messages to send: system, then a memory block (if any), then history. */
  readonly messages: readonly ModelMessage[];
  /** Estimated tokens of everything in `messages`, plus the reserved tool tokens. */
  readonly tokens: number;
  /** Ids of the memories that were included, in included order. */
  readonly includedMemories: readonly string[];
  /** Ids of the memories that did not fit. */
  readonly droppedMemories: readonly string[];
  /** How many oldest history messages were dropped to fit. */
  readonly droppedHistory: number;
}

const DEFAULT_MEMORY_HEADER = 'Relevant context from memory:';

export class ContextBuilder {
  readonly #maxTokens: number;
  readonly #reserve: number;
  readonly #estimate: TokenEstimator;
  readonly #memoryHeader: string;

  constructor(options: ContextBuilderOptions) {
    this.#maxTokens = options.maxTokens;
    this.#reserve = options.reserveForResponse ?? 1024;
    this.#estimate = options.estimate ?? charEstimator;
    this.#memoryHeader = options.memoryHeader ?? DEFAULT_MEMORY_HEADER;
  }

  /**
   * Assemble a prompt within the budget.
   *
   * The budget for context is `maxTokens - reserveForResponse - toolTokens`. If
   * even the system instruction does not fit, it is still included (an agent
   * without its instruction is not an agent) and the returned `tokens` will
   * exceed the budget — a signal the caller can act on, rather than a silent
   * truncation of the one thing that must never be dropped.
   */
  build(request: ContextRequest): AssembledContext {
    const toolTokens = request.toolTokens ?? 0;
    let budget = this.#maxTokens - this.#reserve - toolTokens;

    // 1. System — always in.
    let system: ModelMessage | undefined;
    if (request.system !== undefined && request.system !== '') {
      system = { role: 'system', content: request.system };
      budget -= estimateMessage(system, this.#estimate);
    }

    // 2. History — newest-first while it fits, emitted chronologically.
    const history = request.history ?? [];
    const keptHistory: ModelMessage[] = [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      if (message === undefined) continue;
      const cost = estimateMessage(message, this.#estimate);
      if (cost > budget) break;
      keptHistory.push(message);
      budget -= cost;
    }
    keptHistory.reverse();
    const droppedHistory = history.length - keptHistory.length;

    // 3. Memories — by descending score while they fit, as one block after system.
    const ranked = rankMemories(request.memories ?? []);
    const included: MemorySnippet[] = [];
    const dropped: string[] = [];
    for (const memory of ranked) {
      const cost = this.#estimate(memory.text) + 1;
      if (cost <= budget) {
        included.push(memory);
        budget -= cost;
      } else {
        dropped.push(memory.id);
      }
    }

    // Assemble in reading order: system, memory block, history.
    const out: ModelMessage[] = [];
    if (system !== undefined) out.push(system);
    if (included.length > 0) {
      const block = `${this.#memoryHeader}\n${included.map((m) => `- ${m.text}`).join('\n')}`;
      out.push({ role: 'system', content: block });
    }
    out.push(...keptHistory);

    // Report the true cost of what was emitted, plus the reserved tool tokens.
    const tokens =
      toolTokens + out.reduce((sum, m) => sum + estimateMessage(m, this.#estimate), 0);

    return {
      messages: out,
      tokens,
      includedMemories: included.map((m) => m.id),
      droppedMemories: dropped,
      droppedHistory,
    };
  }
}

/**
 * Rank memories by descending score, stably.
 *
 * A missing score ranks *last* (it was retrieved but not scored, so it is the
 * weakest signal), and ties — including all-missing — keep their input order, so
 * the result is deterministic.
 */
export function rankMemories(
  memories: readonly MemorySnippet[],
): readonly MemorySnippet[] {
  return memories
    .map((memory, index) => ({ memory, index }))
    .sort((a, b) => {
      const scoreA = a.memory.score ?? Number.NEGATIVE_INFINITY;
      const scoreB = b.memory.score ?? Number.NEGATIVE_INFINITY;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.index - b.index;
    })
    .map((entry) => entry.memory);
}
