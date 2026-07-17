/**
 * @hermes/provider-anthropic — a Claude chat and tool-calling provider.
 *
 * Implements `@hermes/model`'s `ChatModel`/`ToolCallingModel` over Anthropic's
 * Messages API, through an injected `@hermes/tools-http` client. The vendor
 * knowledge is confined to two translations (see `chat.ts`): Anthropic hoists the
 * system prompt to a top-level field, represents tool calls and results as content
 * blocks, and requires alternating roles — all bridged here so a caller holds a
 * plain `ChatModel`.
 *
 * Anthropic offers no embedding API, so this package is chat only; pair it with an
 * OpenAI/Ollama embedding provider in a mixed deployment.
 *
 * ```ts
 * import { AnthropicClient, AnthropicChatModel } from '@hermes/provider-anthropic';
 * import { FetchHttpClient, guarded } from '@hermes/tools-http';
 *
 * const http = guarded(new FetchHttpClient(), { policy: { allowHosts: ['api.anthropic.com'] } });
 * const claude = new AnthropicChatModel({
 *   client: new AnthropicClient({ http, apiKey: process.env.ANTHROPIC_API_KEY }),
 *   model: 'claude-sonnet-4-5',
 * });
 * registry.register(claude); // hand to the model router
 * ```
 *
 * Failures classify into `@hermes/model` `ModelError`s so the router's fallback
 * works. See `docs/rfcs/RFC-0016-anthropic-provider.md` and STATUS.md.
 */

export { AnthropicClient, safeJson } from './client.js';
export type { AnthropicClientOptions } from './client.js';

export { AnthropicChatModel, toAnthropicMessages } from './chat.js';
export type { AnthropicChatModelOptions } from './chat.js';
