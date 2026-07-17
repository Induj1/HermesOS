# RFC-0014: Model Router

| Field         | Value                                                  |
| ------------- | ------------------------------------------------------ |
| Status        | Implemented                                            |
| Date          | 2026-07-18                                             |
| Scope         | `packages/model-router` (`@hermes/model-router`)       |
| Depends on    | `@hermes/model` (contracts), `@hermes/kernel` (Logger) |
| Supersedes    | —                                                      |
| Superseded by | —                                                      |

Design record for the model router: capability-based selection and fallback
across model providers, presented as a single `ChatModel`.

Covered by 44 tests in `packages/model-router/tests`.

---

## 1. Context

A deployment has more than one model — a cheap local Llama, a Claude, an OpenAI
— and the agent framework's reasoner wants _a_ `ChatModel`, not a decision tree.
Something must sit between them that picks a provider and, when it fails, tries
another. That is the router.

The contracts already carry everything it needs: `ModelInfo.supports` declares
what a model can do (so selection is by capability, not by matching model-name
prefixes that rot), and `ModelError.retryable` says whether a failure is worth
trying elsewhere (RFC — `@hermes/model`). The router is the consumer those two
fields were designed for.

## 2. The organising principle

> **Select by declared capability; fall back on a retryable failure, stop on a
> definitive one.**

{@link route} is the whole engine: walk ordered candidates, return the first
success, move on past a _retryable_ `ModelError`, and throw straight through on
a non-retryable one (or any non-`ModelError`) because it is the answer every
provider would give — retrying it across the chain just fails N times and bills
for it. An exhausted chain throws `AllFailedError` carrying every attempt; an
empty candidate set throws `NoCandidatesError`.

## 3. Selection

`selectCandidates(registry, criteria)` is a pure function producing the ordered
list to try. Criteria: an explicit `models` preference order (which _is_ the
fallback chain), required `features`, and a `provider` restriction. With no
`models` list, every registered model that passes the filters is returned in
**registration order** — so a deployment states its default preference simply by
the order it registers models (local first, API second).

## 4. The registry

`ModelRegistry` holds `Model`s (the common base, so chat and embedding models
coexist) keyed by name, with `byFeatures` and `byProvider` lookups.
Re-registering a name replaces it — a hot swap is a normal act, not an error.

## 5. RoutingChatModel

`RoutingChatModel` wraps the engine as a `ChatModel` / `ToolCallingModel`.
`chat` selects models declaring `chat`; `chatWithTools` selects those declaring
`tools` (both by capability _and_ by actual method presence, via `isChatModel` /
`isToolCallingModel` guards). Its synthetic `info.supports.tools` reflects
whether any tool-capable model is registered. A caller steers one call by
passing `options.extra.route` — a `RouteCriteria` merged over the defaults — so
pinning a request to one model needs no bespoke API. The caller's signal is
threaded to the chain; a failed attempt is logged through the injected `Logger`.

## 6. Testing

`FakeChatModel` is a scriptable, deterministic `ChatModel`/`ToolCallingModel`: a
script of outcomes (responses or errors) consumed in order, a fallback outcome,
and a call log — so a test stands up "rate-limited then works" or "permanently
down" with no network, and asserts exactly which models were tried and in what
order. Tests cover selection, fallback, stop-on-definitive, exhaustion,
no-candidates, cancellation, capability filtering (chat vs tools), per-call
override, and default criteria. Branch coverage 97.8%.

## 7. Extension points and non-goals

- Adding a provider is registering it; no caller changes. The provider packages
  (#16–19) each register the `ChatModel`/`EmbeddingModel` they implement.
- **No load balancing or weighting** yet — selection is deterministic preference
  order. A weighted or round-robin policy is a future `RouteCriteria` extension;
  the deterministic order is the right default and the only one that is testable
  without a clock or RNG.
- **No embedding routing** — the embedding platform (RFC-0013) already pools and
  retries; a `RoutingEmbeddingModel` would be a thin addition if a deployment
  runs several embedding providers, and slots onto the same `route` engine.
