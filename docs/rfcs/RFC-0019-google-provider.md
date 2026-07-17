# RFC-0019: Google Gemini Provider

| Field         | Value                                                          |
| ------------- | -------------------------------------------------------------- |
| Status        | Implemented (verified against fakes; live calls need a key)    |
| Date          | 2026-07-18                                                     |
| Scope         | `packages/provider-google` (`@hermes/provider-google`)         |
| Depends on    | `@hermes/model`, `@hermes/tools-http`, `@hermes/provider-http` |
| Supersedes    | —                                                              |
| Superseded by | —                                                              |

Design record for the Google Gemini provider: a `ChatModel`/`ToolCallingModel`
over the `generateContent` API, on the shared provider-http base. Third distinct
wire format, same small surface.

Covered by 24 tests in `packages/provider-google/tests`.

---

## 1. What is different

Client transport, JSON, and status classification are `@hermes/provider-http`'s
(shared, so error handling is uniform for the router). The bridge in `chat.ts`
is where Gemini diverges — a third shape after OpenAI's and Anthropic's:

- **Roles are `user` and `model`** (not `assistant`), and the system prompt is a
  hoisted `systemInstruction`. Like Anthropic, system messages are collected out
  and adjacent same-role messages are coalesced (Gemini rejects two `user` turns
  in a row).
- **Content is `parts`.** Text is `{ text }`; a tool call is
  `{ functionCall: { name, args } }` on a `model` message; a tool result is
  `{ functionResponse: { name, response } }` on a `user` message.
- **Tool results match by function name, not call id.** Gemini's
  `functionResponse` keys on the function's name. A Hermes tool result carries a
  `toolCallId`, so a caller passes the function name as the message `name`
  (`toolResult(id, content, name)`); the id is the fallback so nothing is
  silently dropped.

Tools go under `tools[0].functionDeclarations`; options under
`generationConfig`; `toolChoice` maps to a `functionCallingConfig.mode`
(`AUTO`/`ANY`/`NONE`, plus `allowedFunctionNames` for a named choice). The key
is an `x-goog-api-key` **header** — deliberately not the `?key=` query
parameter, so it never lands in a URL or a log line.

`toGoogleContents` is exported and tested on its own — the breakable part.

## 2. Scope

Chat and tool-calling. Gemini's embedding API (`embedContent`) is a separate
shape not exposed here; pair Gemini with an OpenAI/Ollama embedding provider.
Streaming is unimplemented until the transport supports it.

## 3. Testing

Against `FakeHttpClient` with generateContent-shaped responses: the message
bridge (system hoist, functionCall/functionResponse incl. the name-vs-id
fallback, role coalescing, empty-text omission), request shaping
(generationConfig, tools, every tool_choice mode, extra), response parsing
(text, functionCall → tool calls, finish-reason mapping incl. tool-call
detection, usage), and the client's header/classifier wiring (incl. the
context-length override). Branch coverage 97.7%.

## 4. What needs a live key

The wire mapping is complete and verified against the fake. A real
`GEMINI_API_KEY` confirms the request shape and error bodies match live Gemini
and a real (multi-tool) round-trip. Not a code gap — see STATUS.md.
