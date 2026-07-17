# RFC-0013: Embedding Service

| Field         | Value                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| Status        | Implemented (platform complete; live providers gated)                        |
| Date          | 2026-07-17                                                                   |
| Scope         | `packages/embedding` (`@hermes/embedding`)                                   |
| Depends on    | `@hermes/model` (contracts), `@hermes/kernel` (Logger), `@hermes/tools-http` |
| Supersedes    | —                                                                            |
| Superseded by | —                                                                            |

Design record for the embedding platform: a provider-independent service that
turns any backend implementing one small contract into a production embedder —
batched, retried, concurrency-bounded, order-preserving, normalized, and
cost-tracked. Every provider (OpenAI, Ollama, Voyage, Cohere, Gemini, Azure, a
local ONNX model) plugs in the same way.

Covered by 108 tests in `packages/embedding/tests`.

---

## 1. Context

The kernel excludes embeddings by rule (RFC-0001 §3), and `@hermes/model`
already declares a minimal `EmbeddingModel` — `embed(texts, signal)` returning
vectors — which `@hermes/memory` mirrors as its `EmbeddingProvider`. What is
missing is the _platform_ between "an HTTP call to an embedding endpoint" and "a
robust embedding capability an application can lean on": batching to the
provider's limit, bounded concurrency, retries with backoff, deterministic
ordering, normalization, and usage/cost accounting.

Doing that once, correctly, in a place every provider shares is the entire
point. Without it, each provider re-implements batching (and gets the edge cases
wrong), or each caller does (and a loop over a single-item endpoint becomes a
thousand requests). This subsystem is that shared place.

## 2. The organising principle

> **A provider turns one batch into vectors. The service turns any provider into
> a production embedder — batching, retries, concurrency, ordering, cost —
> uniformly.**

The {@link EmbeddingProvider} contract is deliberately tiny: declare your models
and capabilities, and embed one already-sized batch, honouring cancellation and
timeout. It does **not** batch, retry, normalize, or bound concurrency — because
those must behave identically for every backend, and the only way to guarantee
that is to implement them once, in the {@link EmbeddingService}, not N times in
N providers. Adding a vendor is implementing the small surface; the hard parts
come for free and behave the same.

## 3. The core types

- **`EmbeddingProvider`** — the backend contract: `models()`,
  `capabilities(model?)`, `embed(batch)`.
- **`EmbeddingModel`** — a model's identity (`name`, `provider`, `dimensions`)
  and its {@link EmbeddingCapabilities}. Structurally aligned with
  `@hermes/model`'s `EmbeddingModel` so the two interoperate (§7).
- **`EmbeddingCapabilities`** — `maxBatchSize`, `configurableDimensions` (+
  `supportedDimensions`), `normalizesByDefault`, `costPer1kTokens`,
  `maxInputTokens`. The service reads these to size batches, decide whether to
  normalize, validate widths, and price usage.
- **`EmbeddingRequest`** — `texts` plus optional `model`, `dimensions`,
  `normalize`, `metadata`, `signal`, `timeoutMs`.
- **`EmbeddingBatch`** — one provider call's worth: a slice of the request with
  `model`/`dimensions` resolved and an `offset` for order-preserving reassembly.
- **`EmbeddingResponse`** — vectors in input order, aggregated `usage`, computed
  `cost`, the `normalized` flag, echoed `metadata`, and the `batches` count.
- **`EmbeddingError`** — a stable `code`, a `provider`, and a `retryable` flag,
  the one thing the service (and a future router) branches on. Mirrors
  `@hermes/model`'s `ModelError` intent.

## 4. Batching strategy

The service splits a request's texts into contiguous batches of
`min(configured batchSize, capabilities.maxBatchSize)`, never exceeding the
provider maximum (a larger configured size is clamped and logged). Each batch
carries its `offset`; results are written back at `offset + i`, so the output
aligns to the input **regardless of which batch completed first** —
deterministic ordering is a property of the assembly, not of timing. An empty
request is a no-op: zero provider calls, an empty result.

## 5. Retry strategy

Each batch is retried independently, up to `retries` times, **only** on a
_retryable_ `EmbeddingError` — a rate limit, a timeout, a transient malformed
response. Backoff is exponential (`retryBaseMs * 2^attempt`), except a rate
limit with a `retry-after` waits exactly that long. A **non-retryable** failure
(a dimension mismatch, an invalid request, an auth failure) fails the whole
request at once — retrying it would fail identically and bill for it. The retry
`sleep` is injectable, so tests are instant and a deployment can supply jitter.

## 6. Concurrency, cancellation, and timeout

Batches run through a bounded pool of `maxConcurrency` workers pulling from a
shared cursor — a large request never opens more than N connections at once. A
shared `AbortController` links three cancellation sources: the caller's signal
(cancels everything), a batch's terminal failure (cancels its in-flight
siblings, so a doomed request stops promptly), and — via the provider — the
per-call `timeoutMs`, which rides down to each batch. Normalization (L2, applied
by the service when the provider is not `normalizesByDefault`), usage
aggregation, and cost computation happen uniformly during assembly.

## 7. Capability negotiation and provider compatibility

A caller reads `service.capabilities(model?)` and `service.models()` to discover
limits (batch size, configurable dimensions, cost) _before_ sending work. The
service validates a requested `dimensions` against `supportedDimensions` and
rejects one a model does not support, rather than letting the provider fail
later.

Compatibility runs two ways. A backend implements `EmbeddingProvider` (or
extends {@link HttpEmbeddingProvider}, §8). And the whole service presents
_outward_ as a `@hermes/model` `EmbeddingModel` via {@link toModelEmbedding} —
so `MemoryService` and a future model router consume the batched, retried,
cost-tracked platform through the minimal interface they already understand,
with no knowledge of this package. The dependency points inward: this package
depends on the contracts, not the reverse.

## 8. Extension points for future providers

`HttpEmbeddingProvider` is the base real providers build on. It owns the shared
HTTP shape over an injected `@hermes/tools-http` `HttpClient` — auth header,
request/response plumbing, and status-to-error mapping (`401/403` → auth, `429`
→ rate limit with `retry-after`, `400/422` → invalid, `5xx` → retryable provider
error, transport `TIMEOUT` → timeout, other transport faults → retryable) — so a
concrete provider supplies only two vendor-specific methods:
`buildRequest(batch)` and `parseResponse(body, batch)`. Because the transport is
injected, wrapping it in `guarded` gives a provider SSRF protection for free,
and every provider inherits the HTTP layer's timeout and size caps rather than
re-implementing them.

An OpenAI provider is ~20 lines on this base; the tests include exactly such a
subclass (`DemoProvider`) exercised against a fake HTTP client.

## 9. The fake provider

`FakeEmbeddingProvider` is deterministic: the same text yields the same vector
every time (a seeded PRNG, not a constant a bug could satisfy), at a
configurable width, with configurable latency and usage reporting. Every failure
mode is scriptable via `failNext`: rate limits (with/without `retry-after`),
timeouts, malformed responses (wrong count, wrong width, `NaN`), and arbitrary
errors — so the service's batching, retry, ordering, and error handling are
exercised against realistic behaviour that stays deterministic. It honours
cancellation and simulates a timeout when latency exceeds the deadline. Almost
every test runs against it.

## 10. Performance characteristics

- **Batching** collapses a large request into the fewest provider calls that
  respect `maxBatchSize`.
- **Bounded concurrency** overlaps those calls up to `maxConcurrency` without
  unbounded fan-out.
- **Connection reuse** comes from the injected `HttpClient` (a real provider
  passes a keep-alive client); the platform adds no per-call transport.
- **Memory** stays proportional to the result: batches are sliced views, results
  written into one pre-sized array, no intermediate copies of the whole corpus.
- **Streaming preparation**: the batch/offset model already produces results
  incrementally per batch; a future streaming API can yield per batch without
  changing the provider contract.

## 11. Testing

Deterministic, against the fake unless noted: batching and clamping, input-order
preservation, concurrency bound, retries (retryable vs not, backoff,
`retry-after`, exhaustion), cancellation (pre-aborted and sibling-cancel),
timeout propagation and surfacing, usage aggregation and cost, normalization
(service-applied, provider-native, not-requested), capability negotiation and
dimension validation, model selection and defaults, metadata propagation, the
pure normalization/error units, the `@hermes/model` adapter, and the
`HttpEmbeddingProvider` base against a fake HTTP client
(status/transport/malformed mapping).

Branch coverage is 96.4%, above the enforced 95% floor.

## 12. What needs a live provider

The platform is complete and verified against the fake. What remains needs a
real provider's credentials or a local server:

- **Concrete providers** (#16–18: Ollama, Anthropic/OpenAI-style) implementing
  `HttpEmbeddingProvider` — their `buildRequest`/`parseResponse` verified
  against the real wire format, and the auth, rate-limit headers, and error
  bodies confirmed against the live API.
- **Compatibility** confirmed end to end: a real provider behind the service,
  behind `toModelEmbedding`, behind `MemoryService`, storing real vectors.

Neither is a gap in the platform. A provider is `buildRequest` + `parseResponse`
plus a key — see STATUS.md.

## 13. Known limitations

- **No token counting.** `maxInputTokens` is advisory; the platform does not
  tokenize (that is model-specific) and does not pre-split an over-long text. A
  provider that rejects an over-length input surfaces it as `INVALID_REQUEST`.
- **Normalization is L2 only.** The one normalization anyone asks an embedding
  platform for; other schemes are a caller's to apply.
- **Cost is `costPer1kTokens × totalTokens`.** Tiered or per-request pricing is
  not modelled; a provider with such pricing leaves `costPer1kTokens` unset and
  reports its own cost out of band.
