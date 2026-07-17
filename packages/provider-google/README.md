# @hermes/provider-google

A Google Gemini chat and tool-calling provider over the `generateContent` API.

- **Design record:** [RFC-0019](../../docs/rfcs/RFC-0019-google-provider.md).
- **Depends on:** `@hermes/model`, `@hermes/tools-http`,
  `@hermes/provider-http`.

## Usage

```ts
import { GoogleClient, GoogleChatModel } from '@hermes/provider-google';
import { FetchHttpClient, guarded } from '@hermes/tools-http';
import { ModelRegistry } from '@hermes/model-router';

const http = guarded(new FetchHttpClient(), {
  policy: { allowHosts: ['generativelanguage.googleapis.com'] },
});
const gemini = new GoogleChatModel({
  client: new GoogleClient({ http, apiKey: process.env.GEMINI_API_KEY }),
  model: 'gemini-2.0-flash',
  contextWindow: 1_000_000,
});

registry.register(gemini); // hand to the model router
await gemini.chatWithTools(messages, tools);
```

## What it bridges

Gemini's `generateContent` is a third distinct shape, hidden by this package:

- **`user`/`model` roles** (not `assistant`) and a hoisted `systemInstruction`.
- **Content is `parts`** — text, `functionCall`, and `functionResponse` parts.
- **Tool results match by function name** — pass it as the message `name`
  (`toolResult(id, content, name)`); the id is the fallback.
- **Roles are coalesced** (Gemini rejects two `user` turns in a row).
- **The key is an `x-goog-api-key` header** — never the URL, so it stays out of
  logs.

Failures classify into `@hermes/model` `ModelError`s via the shared
`@hermes/provider-http` base, so the router's fallback works.

Chat/tools only (Gemini's embedding API is a separate shape); streaming
unimplemented until the transport supports it.

## What needs a live key

Everything is verified against a fake HTTP client. A real `GEMINI_API_KEY`
confirms the wire shape and a real round-trip. See RFC-0019 §4 and STATUS.md.
