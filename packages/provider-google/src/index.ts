/**
 * @hermes/provider-google — a Google Gemini chat and tool-calling provider.
 *
 * Implements `@hermes/model`'s `ChatModel`/`ToolCallingModel` over Gemini's
 * `generateContent` API, on the shared `@hermes/provider-http` base. The vendor
 * knowledge is confined to `chat.ts`'s message bridge — Gemini uses `user`/`model`
 * roles, a hoisted `systemInstruction`, `parts` (with `functionCall`/
 * `functionResponse`), and matches tool results by function name — so a caller
 * holds a plain `ChatModel`.
 *
 * Gemini's key is sent as an `x-goog-api-key` header (not in the URL). No first-
 * party embedding model is exposed here; pair Gemini with an OpenAI/Ollama
 * embedding provider.
 *
 * ```ts
 * import { GoogleClient, GoogleChatModel } from '@hermes/provider-google';
 * import { FetchHttpClient, guarded } from '@hermes/tools-http';
 *
 * const http = guarded(new FetchHttpClient(), { policy: { allowHosts: ['generativelanguage.googleapis.com'] } });
 * const gemini = new GoogleChatModel({
 *   client: new GoogleClient({ http, apiKey: process.env.GEMINI_API_KEY }),
 *   model: 'gemini-2.0-flash',
 * });
 * registry.register(gemini); // hand to the model router
 * ```
 *
 * See `docs/rfcs/RFC-0019-google-provider.md` and STATUS.md.
 */

export { GoogleClient } from './client.js';
export type { GoogleClientOptions } from './client.js';

export { GoogleChatModel, toGoogleContents } from './chat.js';
export type { GoogleChatModelOptions } from './chat.js';
