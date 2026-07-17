/**
 * @hermes/context — budget-aware context assembly for a model prompt.
 *
 * Turns the candidates for an agent turn — a system instruction, the conversation
 * so far, memories retrieved for this turn, and the token cost of the tools the
 * model will be given — into the `ModelMessage[]` that fits the model's context
 * window, **deterministically**, by a fixed priority (system → tools → recent
 * history → relevant memory). No model call, no randomness: the same inputs always
 * produce the same prompt, which is what makes an agent reproducible.
 *
 * It is decoupled on purpose: it takes generic {@link MemorySnippet}s, so it
 * depends on `@hermes/model` (for `ModelMessage`) and nothing else — a caller
 * feeds it results from `@hermes/memory` without this package importing a database.
 *
 * ```ts
 * import { ContextBuilder } from '@hermes/context';
 *
 * const builder = new ContextBuilder({ maxTokens: 128000, reserveForResponse: 2048 });
 * const { messages, droppedHistory, includedMemories } = builder.build({
 *   system: agentInstruction,
 *   history: conversationSoFar,
 *   memories: retrieved,     // { id, text, score }
 *   toolTokens: toolBudget,
 * });
 * const answer = await model.chat(messages);
 * ```
 *
 * See `docs/rfcs/RFC-0017-context-builder.md` for the design.
 */

export { ContextBuilder, rankMemories } from './builder.js';
export type {
  ContextRequest,
  ContextBuilderOptions,
  AssembledContext,
  MemorySnippet,
} from './builder.js';

export { charEstimator, estimateMessage } from './estimate.js';
export type { TokenEstimator } from './estimate.js';
