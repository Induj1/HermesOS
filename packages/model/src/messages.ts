/**
 * Building and inspecting model messages.
 *
 * Small, and here rather than in each consumer because every consumer needs the
 * same four constructors and each repetition is a chance to forget that a `tool`
 * message without a `toolCallId` is unattributable. These are the only runtime
 * code in this package; everything else is a contract.
 */

import type { ModelMessage, ModelResponse, TokenUsage, ToolCall } from './contracts.js';

/** A system instruction. */
export function system(content: string): ModelMessage {
  return { role: 'system', content };
}

/** Something the user said. */
export function user(content: string, name?: string): ModelMessage {
  return { role: 'user', content, ...(name === undefined ? {} : { name }) };
}

/** Something the model said, optionally asking for tools. */
export function assistant(
  content: string,
  toolCalls?: readonly ToolCall[],
): ModelMessage {
  return {
    role: 'assistant',
    content,
    // Omitted rather than empty: an assistant message with `toolCalls: []` says
    // "I considered tools and wanted none", which is a different claim from "no
    // tools were in play", and some providers reject the empty array outright.
    ...(toolCalls === undefined || toolCalls.length === 0 ? {} : { toolCalls }),
  };
}

/**
 * The result of a tool the model asked for.
 *
 * `toolCallId` is a required parameter rather than an optional field, because a
 * tool result that does not say which call it answers cannot be matched once two
 * tools run in parallel — and the failure is silent: the model reads the results
 * in the wrong order and reasons confidently about the wrong thing.
 */
export function toolResult(
  toolCallId: string,
  content: string,
  name?: string,
): ModelMessage {
  return {
    role: 'tool',
    content,
    toolCallId,
    ...(name === undefined ? {} : { name }),
  };
}

/**
 * Is this response asking for tools?
 *
 * Checks the calls rather than `stopReason`, and the difference is not academic:
 * providers disagree about whether a response carrying tool calls stops with
 * `tool_calls` or `stop`, and some emit both text and calls. What a caller
 * actually needs to know is whether there is work to run.
 */
export function wantsTools(response: ModelResponse): boolean {
  return (response.toolCalls?.length ?? 0) > 0;
}

/**
 * Was this response cut off?
 *
 * Worth its own function because `length` is the one stop reason a caller must
 * never treat as an answer: the model was mid-sentence, and the text reads
 * plausibly right up to where it stops.
 */
export function isTruncated(response: ModelResponse): boolean {
  return response.stopReason === 'length';
}

/**
 * Add up token usage across calls.
 *
 * Returns `undefined` when nothing reported any, rather than a zeroed total —
 * "this cost nothing" and "nobody said what this cost" are different facts, and
 * a billing or budget layer that confused them would under-report silently.
 */
export function totalUsage(
  usages: readonly (TokenUsage | undefined)[],
): TokenUsage | undefined {
  const known = usages.filter((usage): usage is TokenUsage => usage !== undefined);
  if (known.length === 0) return undefined;

  const cached = known.reduce((sum, usage) => sum + (usage.cachedTokens ?? 0), 0);
  return {
    promptTokens: known.reduce((sum, usage) => sum + usage.promptTokens, 0),
    completionTokens: known.reduce((sum, usage) => sum + usage.completionTokens, 0),
    // Only reported when something reported it, for the same reason as above.
    ...(known.some((usage) => usage.cachedTokens !== undefined)
      ? { cachedTokens: cached }
      : {}),
  };
}
