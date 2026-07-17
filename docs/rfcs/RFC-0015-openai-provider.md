# RFC-0015: OpenAI Provider

| Field         | Value                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| Status        | Implemented (verified against fakes; live calls need a key)                  |
| Date          | 2026-07-18                                                                   |
| Scope         | `packages/provider-openai` (`@hermes/provider-openai`)                       |
| Depends on    | `@hermes/model`, `@hermes/kernel`, `@hermes/tools-http`, `@hermes/embedding` |
| Supersedes    | —                                                                            |
| Superseded by | —                                                                            |

Design record for the OpenAI provider: a `ChatModel`/`ToolCallingModel` and an
embedding provider over the OpenAI wire format. Because that format is the
de-facto standard, the same package serves **Azure OpenAI, Ollama's `/v1`
endpoint, vLLM, and other OpenAI-compatible servers** — this is also how the
Ollama provider (#16) is satisfied without a second HTTP client.

Covered by 45 tests in `packages/provider-openai/tests`.

---

## 1. Context

The router (RFC-0014) and the embedding platform (RFC-0013) are ready for
providers; this is the first. A provider's whole job is two translations —
Hermes types → a vendor's wire shape, and back — plus classifying the vendor's
failures into the `ModelError`s the router falls back on. Everything else
(transport, retries, batching) is already owned upstream, which is why the
package is small.

## 2. Reuse, not reinvention

- **Transport** is an injected `@hermes/tools-http` `HttpClient` (RFC-0009), so
  the provider inherits the timeout, size cap, and — through `guarded` — the
  SSRF policy, and never writes request/response plumbing.
- **Embeddings** extend the embedding platform's `HttpEmbeddingProvider`
  (RFC-0013), so batching, retries, and concurrency are the platform's; the
  provider supplies only `buildRequest`/`parseResponse`.
- **Errors** are `@hermes/model`'s `ModelError` family, classified once in
  `OpenAIClient` so chat and embeddings tell a rate limit from an invalid
  request identically.

No OpenAI-specific logic leaks into any shared layer — the vendor knowledge is
confined to this package's request/response mapping.

## 3. Chat mapping

`OpenAIChatModel` maps `ModelMessage[]` → OpenAI `messages` (including an
assistant message's `tool_calls` and a `tool` message's `tool_call_id`),
`ToolDefinition[]` → OpenAI `tools`, and `toolChoice` → OpenAI's `tool_choice`
shape. The response maps back: `choices[0].message.content`, `tool_calls`
(arguments arrive as a **JSON string**, parsed to `args`, kept raw if the model
emitted invalid JSON), `finish_reason` → `StopReason` (`length`, `tool_calls`,
`content_filter` → `filtered`, else `stop`), and `usage`. `options.extra` is
merged into the body verbatim — the escape hatch for `top_p` and friends the
contract deliberately does not name.

## 4. Error classification

`OpenAIClient` maps status → `ModelError`: `401/403` → `AuthenticationFailed`
(not retryable), `429` → `RateLimited` (with `retry-after`), `404` →
`ModelUnavailable` (retryable — another provider likely has it), `400/422` →
`InvalidRequest`, except `context_length_exceeded` → `ContextTooLong` (not
retryable — the same prompt is too long everywhere), `5xx` → `ModelUnavailable`
(retryable). Transport `TIMEOUT` → `ModelTimeout`; other transport faults →
`ModelUnavailable` (retryable). This is exactly the signal the router's fallback
consumes.

## 5. Embeddings

`OpenAIEmbeddingProvider` serves `text-embedding-3-small`/`-large` (configurable
dimensions, normalized by default, priced), builds
`{ model, input, dimensions }`, and **sorts the response by each item's
`index`** so alignment never depends on the server preserving request order.
Registered with an `EmbeddingService`, it gets the platform's batching and
retries for free.

## 6. OpenAI-compatible servers

`baseUrl`, `apiKey`, `provider`, and extra `headers` are all configurable, and
the key is optional — so the same package points at Azure (an `api-key` header),
Ollama's `http://localhost:11434/v1` (no key), or vLLM. RFC — the Ollama
provider (#16) is this package with a different base URL for its
OpenAI-compatible endpoint; a separate package is only warranted if Ollama's
_native_ API (richer model management, `/api/embeddings`) is needed.

## 7. Testing

Everything runs against `@hermes/tools-http`'s `FakeHttpClient` with
OpenAI-shaped responses: request shaping (messages, tools, tool_choice, options,
extra), response parsing (content, tool calls incl. malformed args, stop
reasons, usage), the full status- and transport-error mapping, and embeddings
end to end through the `EmbeddingService` (including index-sorting and a retried
429). Branch coverage 95.2%.

## 8. What needs a live key

The wire mapping is complete and verified against the fake. What needs a real
`OPENAI_API_KEY` (or an Azure/compatible endpoint) to confirm: that the request
shape and error bodies match live OpenAI, and a real chat/embedding round-trip.
Not a code gap — a `FetchHttpClient` and a key. Streaming is intentionally not
implemented (`supports.streaming: false`): the current transport buffers the
body, so true token streaming waits on a streaming transport (§ future work).
