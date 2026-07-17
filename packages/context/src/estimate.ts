/**
 * Token estimation — deliberately a heuristic, and deliberately injectable.
 *
 * The context builder needs to know "roughly how many tokens is this" to pack a
 * budget, but it must not depend on a tokenizer: the real tokenizer is
 * model-specific (a `tiktoken`, a SentencePiece), pulling one in would tie this
 * pure package to a vendor and a WASM blob, and the builder's decisions are robust
 * to a small error anyway (it reserves headroom). So the default is the
 * well-known ~4-characters-per-token approximation, and a caller with a real
 * tokenizer passes it as {@link TokenEstimator}.
 */

import type { ModelMessage } from '@hermes/model';

/** Estimate the token count of a string. */
export type TokenEstimator = (text: string) => number;

/**
 * The default estimator: ~1 token per 4 characters, floored at 1 for non-empty
 * text. Empty text is 0 tokens.
 *
 * It runs a little *high* on English prose, which is the safe direction — an
 * over-estimate packs a little less into the budget and never blows past the
 * model's real limit.
 */
export const charEstimator: TokenEstimator = (text) =>
  text === '' ? 0 : Math.ceil(text.length / 4);

/**
 * Estimate a message's tokens, including a small per-message overhead.
 *
 * Every chat format spends a few tokens per message on role markers and
 * delimiters (OpenAI's is famously ~3–4). Counting only the content would
 * under-count a long conversation of short turns, so a fixed overhead is added.
 */
export function estimateMessage(
  message: ModelMessage,
  estimate: TokenEstimator,
  overhead = 4,
): number {
  let tokens = estimate(message.content) + overhead;
  if (message.name !== undefined) tokens += estimate(message.name);
  for (const call of message.toolCalls ?? []) {
    tokens += estimate(call.name) + estimate(JSON.stringify(call.args ?? {}));
  }
  return tokens;
}
