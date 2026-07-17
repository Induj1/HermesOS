/**
 * A deterministic, offline embedding provider.
 *
 * This is the classic hashing trick: tokenise, hash each token to a bucket and a
 * sign, sum, L2-normalise. It is not a language model and knows nothing about
 * meaning — "car" and "automobile" are as unrelated to it as "car" and "xylophone".
 *
 * It exists because the alternative is worse. Tests for retrieval, importance,
 * and pruning need vectors, and getting them from Ollama would make the suite
 * depend on a running server, a pulled model, and a GPU's mood — the tests would
 * be slow, flaky, and unrunnable in CI. `nomic-embed-text` also gives no
 * stability guarantee across versions, so a "similar texts rank higher"
 * assertion against it is a bet on a third party's weights.
 *
 * What this provider does guarantee is exactly what those tests need:
 *
 *   * **Deterministic** — same text, same vector, forever. No seed, no drift.
 *   * **Lexically meaningful** — texts sharing words have higher cosine
 *     similarity than texts that do not. Enough to prove that ranking *works*,
 *     which is the property under test; whether the ranking is *smart* is the
 *     embedding model's job, not this code's.
 *   * **Free** — no network, no process, microseconds per call.
 *
 * It is also a reasonable default for a first run of HermesOS with no Ollama
 * installed: retrieval degrades to something like fuzzy keyword matching rather
 * than failing. Do not mistake it for a production embedding — see RFC-0002 §7.
 */

import {
  assertValidEmbedding,
  type Embedding,
  type EmbeddingProvider,
} from './provider.js';

export interface HashEmbeddingOptions {
  /**
   * Vector width. Defaults to 768 to match `vector(768)` in migration 0004, so
   * that this provider exercises the same pgvector path a real model would.
   */
  readonly dimensions?: number;
  /** Stored in `memory_embedding.model`. Named so it is unmistakable in a table. */
  readonly model?: string;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  constructor(options: HashEmbeddingOptions = {}) {
    this.dimensions = options.dimensions ?? 768;
    if (!Number.isInteger(this.dimensions) || this.dimensions < 1) {
      throw new RangeError(
        `dimensions must be a positive integer, got ${String(options.dimensions)}`,
      );
    }
    // The width is part of the name because it is part of the vector space:
    // (memory_id, model) is a primary key, and two rows written by 64- and
    // 768-wide hash providers must not collide on it.
    this.model = options.model ?? `hash-${String(this.dimensions)}`;
  }

  /**
   * Returns a resolved promise rather than being `async`: this provider is pure
   * CPU and has nothing to await. It satisfies the async {@link EmbeddingProvider}
   * contract because real providers do await a network call, and narrowing the
   * interface to suit this one would break them.
   */
  embed(texts: readonly string[]): Promise<readonly Embedding[]> {
    return Promise.resolve(
      texts.map((text, index) => {
        const vector = this.#embedOne(text);
        assertValidEmbedding(this, vector, index);
        return vector;
      }),
    );
  }

  #embedOne(text: string): Embedding {
    const vector = new Array<number>(this.dimensions).fill(0);

    for (const token of tokenise(text)) {
      const hash = fnv1a(token);
      const bucket = hash % this.dimensions;
      // A sign drawn from a bit of the same hash, so that unrelated tokens can
      // cancel instead of only ever accumulating. Without it every vector points
      // into the same positive orthant and *everything* looks similar to
      // everything — cosine similarity would sit near 1.0 across the corpus and
      // ranking would be noise.
      const sign = hash >>> 31 === 0 ? 1 : -1;
      // Non-null: bucket is hash % dimensions, so it is in range. The assertion
      // is for noUncheckedIndexedAccess, not for doubt.
      vector[bucket] = (vector[bucket] ?? 0) + sign;
    }

    return normalise(vector);
  }
}

/**
 * Lowercase word tokens.
 *
 * Unicode-aware (`\p{L}\p{N}`) rather than `\w+`, which is ASCII-only and would
 * silently drop every non-English token — reducing those texts to the zero
 * vector and making them equidistant from everything.
 */
export function tokenise(text: string): readonly string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * FNV-1a, 32-bit.
 *
 * Chosen for being tiny, fast, dependency-free, and well-distributed over short
 * strings. Not a cryptographic hash and does not need to be — nothing here
 * depends on collisions being hard to find, only on them being rare.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // The FNV prime (16777619) via shifts: `hash * 16777619` overflows the
    // double's exact-integer range and loses low bits, which is precisely the
    // part of the hash that carries the entropy. Math.imul does it in int32.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Scale to unit length.
 *
 * With unit vectors, cosine similarity is a dot product and pgvector's `<=>`
 * (cosine distance) is `1 - dot`. Normalising at write time makes every
 * comparison downstream cheaper and, more importantly, makes them agree: an
 * un-normalised vector would rank differently under cosine than under the inner
 * product, and which one you got would depend on the index.
 *
 * The zero vector — a text with no tokens, e.g. "..." — cannot be normalised and
 * is returned as-is. Its cosine similarity to everything is 0, which is the
 * honest answer: an empty text is no more like one memory than another.
 */
export function normalise(vector: readonly number[]): readonly number[] {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  if (sumOfSquares === 0) return vector;
  const magnitude = Math.sqrt(sumOfSquares);
  return vector.map((value) => value / magnitude);
}
