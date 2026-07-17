# @hermes/provider-anthropic

A Claude chat and tool-calling provider over Anthropic's Messages API.

- **Design record:** [RFC-0016](../../docs/rfcs/RFC-0016-anthropic-provider.md).
- **Depends on:** `@hermes/model`, `@hermes/kernel`, `@hermes/tools-http`.

## Usage

```ts
import {
  AnthropicClient,
  AnthropicChatModel,
} from '@hermes/provider-anthropic';
import { FetchHttpClient, guarded } from '@hermes/tools-http';
import { ModelRegistry } from '@hermes/model-router';

const http = guarded(new FetchHttpClient(), {
  policy: { allowHosts: ['api.anthropic.com'] },
});
const claude = new AnthropicChatModel({
  client: new AnthropicClient({ http, apiKey: process.env.ANTHROPIC_API_KEY }),
  model: 'claude-sonnet-4-5',
  contextWindow: 200000,
});

registry.register(claude); // hand to the model router
await claude.chatWithTools(messages, tools);
```

## What it bridges

Anthropic's Messages API differs from OpenAI's, and this package hides it:

- **System prompt** is hoisted to a top-level `system` field.
- **Content is blocks** — tool calls become `tool_use` blocks, tool results
  become `tool_result` blocks on a user message, text is a `text` block.
- **Roles are coalesced** — adjacent same-role messages merge (Anthropic rejects
  two user messages in a row).
- **`max_tokens`** is required by Anthropic; a default (4096) is supplied.

Failures classify into `@hermes/model` `ModelError`s (auth, rate limit, `529`
overloaded → retryable unavailable, invalid, context-too-long) so the router's
fallback works.

Chat and tool-calling only — Anthropic has no embedding API; pair Claude with an
OpenAI/Ollama embedding provider. Streaming is not implemented until the
transport supports it.

## What needs a live key

Everything is verified against a fake HTTP client. A real `ANTHROPIC_API_KEY`
confirms the wire shape and a real round-trip. See RFC-0016 §5 and STATUS.md.
