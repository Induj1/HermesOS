# @hermes/embedding

A provider-independent embedding platform — batching, retries, concurrency,
ordering, normalization, and cost, over any backend.

- **Design record:** [RFC-0013](../../docs/rfcs/RFC-0013-embedding-service.md).
- **Depends on:** `@hermes/model` (contracts), `@hermes/kernel` (Logger),
  `@hermes/tools-http` (transport for the HTTP provider base).

## The idea

A provider turns **one batch** of texts into vectors. The `EmbeddingService`
turns **any provider** into a production embedder — everything that makes
embedding safe and efficient at scale lives in the service, once, so it behaves
identically for OpenAI, Ollama, Voyage, Cohere, Gemini, Azure, or a local model.

## Usage

```ts
import { EmbeddingService, FakeEmbeddingProvider } from '@hermes/embedding';

const service = new EmbeddingService(new FakeEmbeddingProvider(), {
  maxConcurrency: 8, // batches in flight at once
  retries: 3, // per-batch retries on a retryable failure
});

const { embeddings, usage, cost, batches } = await service.embed({
  texts: manyTexts, // split into batches automatically
  normalize: true, // unit vectors (applied by the service if the provider doesn't)
  metadata: { requestId: 'r-1' }, // echoed back on the response
});
```

`embeddings` align to `texts` in input order regardless of which batch finished
first. `service.embedOne(text)` is the single-item convenience — don't call it
in a loop.

## What the service handles

- **Batching** — texts split into batches of `min(configured, maxBatchSize)`,
  never exceeding the provider's limit.
- **Concurrency** — a bounded pool (`maxConcurrency`), so a huge request never
  opens unbounded connections.
- **Retries** — per batch, only on a _retryable_ error (rate limit, timeout,
  transient corruption), with exponential backoff and `retry-after` honoured.
- **Ordering** — deterministic, by each batch's offset.
- **Cancellation & timeout** — the caller's signal cancels every batch, a batch
  failure cancels its siblings, and `timeoutMs` rides down to the provider.
- **Normalization, usage, cost** — applied and aggregated uniformly.

## Capability discovery

```ts
const caps = service.capabilities(); // maxBatchSize, configurableDimensions, cost, …
const models = service.models();
await service.embed({ texts, dimensions: 256 }); // validated against supportedDimensions
```

## Writing a provider

Implement `EmbeddingProvider` (declare models/capabilities, embed one batch), or
extend `HttpEmbeddingProvider` and supply just the vendor-specific parts:

```ts
import {
  HttpEmbeddingProvider,
  type HttpEmbeddingRequest,
} from '@hermes/embedding';

class OpenAIEmbeddings extends HttpEmbeddingProvider {
  protected buildRequest(batch): HttpEmbeddingRequest {
    return {
      path: '/embeddings',
      body: {
        model: batch.model,
        input: batch.texts,
        dimensions: batch.dimensions,
      },
    };
  }
  protected parseResponse(body, batch) {
    const data = (body as { data: { embedding: number[] }[] }).data;
    if (!Array.isArray(data)) this.malformed('no data array');
    return {
      model: batch.model,
      dimensions: batch.dimensions,
      embeddings: data.map((d) => d.embedding),
      normalized: true,
    };
  }
}
```

The base owns auth headers, transport (via an injected `@hermes/tools-http`
client — wrap it in `guarded` for SSRF protection), and status-to-error mapping.

## Compatibility with `@hermes/model`

```ts
import { toModelEmbedding } from '@hermes/embedding';
const embedder = toModelEmbedding(service); // a @hermes/model EmbeddingModel
// hand `embedder` to MemoryService or a model router — they get the full pipeline
```

## Testing with the fake

`FakeEmbeddingProvider` is deterministic (same text → same vector) and scripts
every failure mode:

```ts
const provider = new FakeEmbeddingProvider({ latencyMs: 50 });
provider.failNext({ kind: 'rateLimit', retryAfterMs: 500 }); // then succeed
provider.failNext({ kind: 'malformed', how: 'nan' });
```

## What needs a live provider

The platform is complete and tested against the fake. Concrete providers
(#16–18) implement `HttpEmbeddingProvider` and need a key or a local server to
verify against the real wire format — a provider is `buildRequest` +
`parseResponse` plus credentials. See RFC-0013 §12 and STATUS.md.
