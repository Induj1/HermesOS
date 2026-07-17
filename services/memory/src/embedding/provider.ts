/**
 * The embedding seam.
 *
 * The kernel forbids itself embeddings outright (RFC-0001 §3: "AI, models,
 * prompts, embeddings. Not deferred; excluded"). This service does need them —
 * but it needs the *capability*, not a vendor. Everything here is written
 * against {@link EmbeddingProvider}, so swapping Ollama for OpenAI, or for a
 * local ONNX model, is one object at a composition root.
 *
 * The interface is batch-first (`embed(texts)`, not `embed(text)`) because every
 * real provider is: a single-item method invites a caller to loop, and a loop
 * over an HTTP embedding endpoint is the difference between one request and a
 * thousand. A one-shot convenience is provided as a free function instead, so
 * the cheap path is not the default one.
 */

import { DimensionMismatchError, EmbeddingFailedError } from '../errors.js';

/** A dense vector. Always `dimensions` long; never normalised by contract. */
export type Embedding = readonly number[];

export interface EmbeddingProvider {
  /**
   * Model identifier, stored verbatim in `memory_embedding.model`.
   *
   * It is part of that table's primary key, so this string decides what counts
   * as the same vector space. Two providers that produce incomparable vectors
   * must never share a name.
   */
  readonly model: string;
  /** Vector width. Constant for the life of the provider. */
  readonly dimensions: number;
  /**
   * Embed a batch, returning one vector per input, in order.
   *
   * Implementations must honour `signal` — the kernel's cancellation is
   * cooperative (RFC-0001 §11.1) and a provider that ignores it will hold a task
   * slot past mission cancellation.
   */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly Embedding[]>;
}

/** Embed one text. Sugar over {@link EmbeddingProvider.embed}; do not call in a loop. */
export async function embedOne(
  provider: EmbeddingProvider,
  text: string,
  signal?: AbortSignal,
): Promise<Embedding> {
  const [vector] = await provider.embed([text], signal);
  if (!vector) {
    throw new EmbeddingFailedError(provider.model, 'provider returned no vector');
  }
  return vector;
}

/**
 * Check a provider's output before it reaches the database.
 *
 * The `memory_embedding_dimensions_match` constraint would catch a wrong-width
 * vector too, but as a constraint violation from three layers down. Checking
 * here names the provider that produced it, and catches NaN — which Postgres
 * accepts into a `real[]` quite happily and which poisons every cosine
 * similarity computed against it afterwards.
 */
export function assertValidEmbedding(
  provider: EmbeddingProvider,
  vector: Embedding,
  index = 0,
): void {
  if (vector.length !== provider.dimensions) {
    throw new DimensionMismatchError(
      `Provider "${provider.model}" returned a bad vector at index ${String(index)}`,
      provider.dimensions,
      vector.length,
    );
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new EmbeddingFailedError(
        provider.model,
        `vector at index ${String(index)} contains a non-finite value (${String(value)})`,
      );
    }
  }
}
