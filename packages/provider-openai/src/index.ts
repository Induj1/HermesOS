/**
 * @hermes/provider-openai — an OpenAI-compatible chat and embedding provider.
 *
 * Implements `@hermes/model`'s `ChatModel`/`ToolCallingModel` and the embedding
 * platform's provider over an injected `@hermes/tools-http` client. Because the
 * wire format is the de-facto standard, the same package serves **Azure OpenAI,
 * Ollama's `/v1` endpoint, vLLM, and other OpenAI-compatible servers** — only the
 * `baseUrl` and key differ.
 *
 * ```ts
 * import { OpenAIClient, OpenAIChatModel, OpenAIEmbeddingProvider } from '@hermes/provider-openai';
 * import { FetchHttpClient, guarded } from '@hermes/tools-http';
 * import { EmbeddingService } from '@hermes/embedding';
 * import { ModelRegistry } from '@hermes/model-router';
 *
 * const http = guarded(new FetchHttpClient(), { policy: { allowHosts: ['api.openai.com'] } });
 * const client = new OpenAIClient({ http, apiKey: process.env.OPENAI_API_KEY });
 *
 * const chat = new OpenAIChatModel({ client, model: 'gpt-4o-mini' });
 * registry.register(chat);                                    // hand to the router
 *
 * const embeddings = new EmbeddingService(new OpenAIEmbeddingProvider({ http, apiKey }));
 * ```
 *
 * All model calls classify failures into `@hermes/model` `ModelError`s so the
 * router's fallback works. See `docs/rfcs/RFC-0015-openai-provider.md`, and
 * STATUS.md for what needs a live key.
 */

export { OpenAIClient, safeJson } from './client.js';
export type { OpenAIClientOptions } from './client.js';

export { OpenAIChatModel } from './chat.js';
export type { OpenAIChatModelOptions } from './chat.js';

export { OpenAIEmbeddingProvider } from './embeddings.js';
export type { OpenAIEmbeddingOptions } from './embeddings.js';
