# @hermes/memory

Persistence and recall for HermesOS. The kernel refuses to know what a database
or an embedding is (RFC-0001 §3); this service is where both live. It depends
only on the kernel's public interfaces (`Clock`, `Logger`, `Plugin`, the event
catalogue) — the dependency runs one way, and the kernel has never heard of it.

- **Design record:** [RFC-0002](../../docs/rfcs/RFC-0002-memory.md).
- **Depends on:** `@hermes/kernel`, `pg` (the Postgres client).

It answers three questions:

- **What was said?** — conversation memory: verbatim, ordered, durable.
- **What is worth keeping?** — memory records: scored, embedded, prunable.
- **What happened?** — mission persistence: the kernel's event stream, landed.

## Usage

```ts
import { MemoryService, memoryPlugin } from '@hermes/memory';

// Register with a kernel runtime, or use the service directly:
runtime.use(memoryPlugin({ database, embeddingProvider }));
```

## What it provides

- **`MemoryService`** — the facade over conversations, records, and recall.
- **`memoryPlugin`** — wires the service into a kernel `Runtime`.
- **Repositories** — `ConversationRepository`, `MemoryRepository`,
  `MissionRepository` over `PgDatabase` (parameterized SQL throughout).
- **Embeddings** — an `EmbeddingProvider` port with a deterministic
  `HashEmbeddingProvider` (tests) and an `OllamaEmbeddingProvider`.
- **Retrieval** — `SemanticIndex` with `PgVectorIndex` (pgvector), a
  `BruteForceIndex` fallback, a `HybridRetriever`, and `cosineSimilarity`.

## Live verification

Storing and querying real vectors needs a Postgres 17 instance with the
extensions in `infrastructure/postgres/init/` (`just db-init`). See
[LIVE_VERIFICATION.md](../../LIVE_VERIFICATION.md).
