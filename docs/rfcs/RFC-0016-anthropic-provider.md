# RFC-0016: Anthropic Provider

| Field         | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| Status        | Implemented (verified against fakes; live calls need a key)  |
| Date          | 2026-07-18                                                   |
| Scope         | `packages/provider-anthropic` (`@hermes/provider-anthropic`) |
| Depends on    | `@hermes/model`, `@hermes/kernel`, `@hermes/tools-http`      |
| Supersedes    | —                                                            |
| Superseded by | —                                                            |

Design record for the Anthropic (Claude) provider: a
`ChatModel`/`ToolCallingModel` over the Messages API. It exists partly to prove
the provider pattern generalises — Anthropic's wire format is meaningfully
different from OpenAI's, and the same small surface (two translations + error
classification) still fits.

Covered by 35 tests in `packages/provider-anthropic/tests`.

---

## 1. What is different from OpenAI

The transport, error-classification shape, and `ModelError` vocabulary are
shared patterns (same injected `HttpClient`, same "rate limit retryable, invalid
request not"). The _mapping_ is where Anthropic diverges, and `chat.ts` bridges
three things:

1. **System prompt hoisted.** Anthropic takes `system` as a top-level field, not
   a `role: 'system'` message. System messages are collected out of the list and
   concatenated.
2. **Content is blocks.** A tool call is a `tool_use` block on an assistant
   message; a tool result is a `tool_result` block on a _user_ message; text is
   a `text` block. All content is normalised to a block array.
3. **Roles must alternate.** Adjacent messages that map to the same role
   (several tool results in a turn, a tool result followed by user text) are
   coalesced into one message, because Anthropic rejects two same-role messages
   in a row.

Plus one required field: Anthropic demands `max_tokens`, so a default (4096, or
a constructor override) is supplied when the caller gives none.

`toAnthropicMessages` is exported and unit-tested on its own, because that
transformation is the breakable part.

## 2. Error classification

`AnthropicClient` maps status → `ModelError`: `401/403` → auth, `429` → rate
limit (with `retry-after`), `404` → unavailable, **`529` (Anthropic
"overloaded") and `5xx`** → unavailable (retryable), `400/422` → invalid —
except a too-long-prompt message → `ContextTooLong` (not retryable). Transport
`TIMEOUT` → `ModelTimeout`; other transport faults → unavailable (retryable).
Same signal the router's fallback consumes.

## 3. Scope

Chat and tool-calling only — Anthropic offers no embedding API, so a mixed
deployment pairs Claude with an OpenAI/Ollama embedding provider. Streaming is
intentionally unimplemented (`supports.streaming: false`) until the transport
supports it (same as RFC-0015 §8).

## 4. Testing

Against `FakeHttpClient` with Messages-API-shaped responses: the full message
bridge (system hoisting, tool_use/tool_result blocks, role coalescing,
empty-text omission), request shaping (max_tokens default and override,
temperature, stop_sequences, extra, tools, every `tool_choice` form incl.
dropping `none`), response parsing (text concatenation, tool_use → tool calls,
stop-reason mapping, usage), and the full status/transport error mapping. Branch
coverage 98.2%.

## 5. What needs a live key

The wire mapping is complete and verified against the fake. A real
`ANTHROPIC_API_KEY` confirms the request shape and error bodies match live
Anthropic, and a real round-trip (including a multi-tool turn, where the role
coalescing matters most). Not a code gap — see STATUS.md.
