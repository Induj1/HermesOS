# @hermes/provider-openai

An OpenAI-compatible chat and embedding provider — also serves Azure OpenAI,
Ollama's `/v1` endpoint, vLLM, and other OpenAI-shaped servers.

- **Design record:** [RFC-0015](../../docs/rfcs/RFC-0015-openai-provider.md).
- **Depends on:** `@hermes/model`, `@hermes/kernel`, `@hermes/tools-http`,
  `@hermes/embedding`.

## Usage

```ts
import {
  OpenAIClient,
  OpenAIChatModel,
  OpenAIEmbeddingProvider,
} from '@hermes/provider-openai';
import { FetchHttpClient, guarded } from '@hermes/tools-http';
import { EmbeddingService } from '@hermes/embedding';
import { ModelRegistry, RoutingChatModel } from '@hermes/model-router';

const http = guarded(new FetchHttpClient(), {
  policy: { allowHosts: ['api.openai.com'] },
});
const client = new OpenAIClient({ http, apiKey: process.env.OPENAI_API_KEY });

// Chat — register with the router
const chat = new OpenAIChatModel({
  client,
  model: 'gpt-4o-mini',
  contextWindow: 128000,
});
const model = new RoutingChatModel(new ModelRegistry().register(chat));
await model.chatWithTools(messages, tools);

// Embeddings — hand to the platform service
const embeddings = new EmbeddingService(
  new OpenAIEmbeddingProvider({ http, apiKey: process.env.OPENAI_API_KEY }),
);
await embeddings.embed({ texts, normalize: true });
```

## Compatible servers

Only `baseUrl` and the key differ:

```ts
// Ollama's OpenAI-compatible endpoint (no key)
new OpenAIClient({
  http,
  baseUrl: 'http://localhost:11434/v1',
  provider: 'ollama',
});
// Azure OpenAI (api-key header)
new OpenAIClient({
  http,
  baseUrl: azureUrl,
  headers: { 'api-key': key },
  provider: 'azure',
});
```

## Behaviour

- **Chat / tools** — full message, tool, and `tool_choice` mapping; response
  content, tool calls (JSON-string arguments parsed, kept raw if invalid), stop
  reasons, and usage. `options.extra` merges into the request body.
- **Errors** — classified into `@hermes/model` `ModelError`s (auth, rate limit
  with `retry-after`, unavailable, invalid, context-too-long) so the router's
  fallback works.
- **Embeddings** — extends the platform's `HttpEmbeddingProvider`; sorts results
  by `index` so ordering never depends on the server.
- **Streaming** — not implemented (`supports.streaming: false`) until the
  transport supports it.

## What needs a live key

Everything is verified against a fake HTTP client. A real `OPENAI_API_KEY` (or a
compatible endpoint) confirms the wire shape and a real round-trip. See RFC-0015
§8 and STATUS.md.
