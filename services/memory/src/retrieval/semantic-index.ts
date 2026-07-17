/**
 * The semantic retrieval seam.
 *
 * One interface, two implementations, chosen at runtime by probing the database:
 *
 *   * {@link PgVectorIndex} — an HNSW index and a `<=>` operator do the work in
 *     Postgres. What you want, and what a production deployment gets.
 *   * {@link BruteForceIndex} — every vector for the subject is read and cosine
 *     is computed in Node. What you get where the extension is not installed,
 *     which today includes the native Homebrew Postgres that HermesOS develops
 *     against.
 *
 * The seam exists because of that split, and the split is not a temporary
 * embarrassment — it is the reason the schema is pgvector-*ready* rather than
 * pgvector-dependent (RFC-0002 §6). Both implementations read the same
 * `memory_embedding.embedding` column, return the same type, and are covered by
 * the same tests. Installing pgvector changes which one is constructed and
 * nothing else.
 */

import type { Embedding } from '../embedding/provider.js';
import type { MemoryKind, ScoredMemory, Subject } from '../model.js';

export interface SemanticQuery {
  /** Scopes the search. Never optional: subjects are the isolation boundary. */
  readonly subject: Subject;
  readonly embedding: Embedding;
  /**
   * The model that produced `embedding`.
   *
   * Required, and the most important field here. `memory_embedding` is keyed by
   * (memory_id, model) precisely because vectors from different models occupy
   * unrelated spaces — comparing a nomic-embed-text vector to an OpenAI one
   * returns a number, and the number is meaningless. Every query filters on this.
   */
  readonly model: string;
  readonly limit?: number;
  readonly kinds?: readonly MemoryKind[];
  /**
   * Drop results below this cosine similarity, in [-1,1].
   *
   * Without it, a search over four memories returns all four, ranked — including
   * the ones about nothing to do with the query. A retriever that always returns
   * something is a retriever that pads a model's context with noise.
   */
  readonly minSimilarity?: number;
  /** Include memories whose `expires_at` has passed. Default false. */
  readonly includeExpired?: boolean;
}

export interface SemanticIndex {
  /**
   * How this index does its work. Not decoration: a host logs it at startup, and
   * "why is recall slow" is answered by this field more often than by anything
   * else.
   */
  readonly kind: 'pgvector' | 'brute-force';
  /**
   * Nearest memories, most similar first.
   *
   * `ScoredMemory.similarity` is cosine similarity in [-1,1] — 1 identical, 0
   * unrelated, -1 opposed. `score` is the same value here; blending it with
   * importance and recency is `HybridRetriever`'s job, not the index's.
   */
  search(query: SemanticQuery, signal?: AbortSignal): Promise<readonly ScoredMemory[]>;
}

export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Cosine similarity between two vectors.
 *
 * Shared by `BruteForceIndex` and by tests. Not used on the pgvector path, where
 * `<=>` computes it in the database — the two must agree, which is what
 * `retrieval.test.ts` checks when both are available.
 */
export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `Cannot compare vectors of different widths: ${String(a.length)} vs ${String(b.length)}`,
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    // The `?? 0` never fires: the loop bound is a.length and the widths were
    // checked equal above, so both indexes are in range. It is here because
    // noUncheckedIndexedAccess types these as `number | undefined` and the
    // alternatives are worse — a non-null assertion is banned by lint, and a
    // bounds check per element would cost more than the coalesce in what is the
    // hot loop of the brute-force path, run once per stored vector.
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  // A zero vector has no direction, so its angle to anything is undefined. 0 is
  // the honest answer — "unrelated" — and it keeps the caller from having to
  // handle NaN, which would compare false against every threshold and silently
  // survive a minSimilarity filter.
  if (normA === 0 || normB === 0) return 0;

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Floating-point error can put an identical pair at 1.0000000000000002, which
  // then fails an `expect(sim).toBeLessThanOrEqual(1)` and, worse, escapes [-1,1]
  // for anything downstream that assumes the range.
  return Math.min(1, Math.max(-1, similarity));
}
