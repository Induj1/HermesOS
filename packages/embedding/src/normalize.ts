/**
 * Vector normalization and validation — pure functions, so tested directly.
 *
 * Normalization lives in the platform, not the provider, on purpose: whether a
 * caller gets unit vectors should not depend on which backend answered. A
 * provider that returns unit vectors natively declares `normalizesByDefault`; for
 * every other provider the service applies {@link l2normalize} itself, so
 * `normalize: true` means the same thing everywhere.
 *
 * Validation ({@link assertVector}) is the platform's guard against a provider
 * poisoning a vector store: a wrong-width vector, or one containing `NaN` /
 * `Infinity`, is caught here — naming the provider — rather than three layers down
 * as a database constraint violation, or never, as a silently broken cosine
 * similarity.
 */

import { DimensionMismatchError, MalformedResponseError } from './errors.js';
import type { Embedding } from './types.js';

/**
 * Scale a vector to unit length (L2 norm 1).
 *
 * A zero vector is returned unchanged rather than divided by zero — it has no
 * direction to preserve, and `0/0 = NaN` would turn a legitimately empty
 * embedding into a poisoned one.
 */
export function l2normalize(vector: Embedding): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return [...vector];
  return vector.map((value) => value / norm);
}

/**
 * Assert a single vector is the promised width and free of non-finite values.
 *
 * `NaN`/`Infinity` are checked because a store (Postgres `real[]`, a FAISS index)
 * accepts them and only misbehaves later, when every similarity against the bad
 * vector comes back garbage. Better to reject at the seam.
 */
export function assertVector(
  provider: string,
  expected: number,
  vector: Embedding,
  index = 0,
): void {
  if (vector.length !== expected) {
    throw new DimensionMismatchError(provider, expected, vector.length);
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new MalformedResponseError(
        provider,
        `vector at index ${String(index)} contains a non-finite value (${String(value)})`,
        { retryable: false },
      );
    }
  }
}

/**
 * Validate a batch of vectors: the right count, each the right width and finite.
 *
 * A wrong *count* is a malformed response (the provider dropped or added a row);
 * a wrong *width* is a dimension mismatch. The two are different failures a caller
 * treats differently, so they get different codes.
 */
export function assertBatch(
  provider: string,
  expected: number,
  vectors: readonly Embedding[],
  expectedCount: number,
): void {
  if (vectors.length !== expectedCount) {
    throw new MalformedResponseError(
      provider,
      `expected ${String(expectedCount)} vectors, received ${String(vectors.length)}`,
    );
  }
  for (let i = 0; i < vectors.length; i += 1) {
    const vector = vectors[i];
    if (vector === undefined) {
      throw new MalformedResponseError(
        provider,
        `vector at index ${String(i)} is missing`,
      );
    }
    assertVector(provider, expected, vector, i);
  }
}
