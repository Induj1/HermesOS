/**
 * Embedding providers and cosine similarity.
 *
 * The Ollama tests stub `fetch` rather than talking to a real server. That is
 * the point of it being injectable: the failure modes worth testing — a short
 * batch, a NaN, a 500, a timeout — are precisely the ones that are hard to
 * provoke on demand from a healthy server, and impossible in CI.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  fnv1a,
  HashEmbeddingProvider,
  normalise,
  tokenise,
} from '../src/embedding/hash-embedding-provider.js';
import { OllamaEmbeddingProvider } from '../src/embedding/ollama-embedding-provider.js';
import { assertValidEmbedding, embedOne } from '../src/embedding/provider.js';
import { cosineSimilarity } from '../src/retrieval/semantic-index.js';
import { DimensionMismatchError, EmbeddingFailedError } from '../src/errors.js';

describe('tokenise', () => {
  it('lowercases and splits on non-word characters', () => {
    expect(tokenise('Hello, World! 42')).toEqual(['hello', 'world', '42']);
  });

  it('keeps non-ASCII letters', () => {
    // \w+ would drop these entirely, reducing the text to a zero vector and
    // making it equidistant from everything. That is why the pattern is
    // Unicode-aware.
    expect(tokenise('café Ω 日本語')).toEqual(['café', 'ω', '日本語']);
  });

  it('returns nothing for text with no word characters', () => {
    expect(tokenise('... !!! ---')).toEqual([]);
  });
});

describe('fnv1a', () => {
  it('is deterministic', () => {
    expect(fnv1a('hermes')).toBe(fnv1a('hermes'));
  });

  it('distinguishes similar strings', () => {
    expect(fnv1a('hermes')).not.toBe(fnv1a('hermess'));
    expect(fnv1a('ab')).not.toBe(fnv1a('ba'));
  });

  it('stays within uint32', () => {
    for (const input of ['', 'a', 'hermes', 'x'.repeat(1000)]) {
      const hash = fnv1a(input);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('normalise', () => {
  it('scales to unit length', () => {
    const unit = normalise([3, 4]);
    expect(unit).toEqual([0.6, 0.8]);
  });

  it('returns the zero vector unchanged rather than dividing by zero', () => {
    // A text with no tokens ("..."). NaN here would survive every minSimilarity
    // filter, since NaN < x is false.
    expect(normalise([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('is -1 for opposed vectors', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
  });

  it('ignores magnitude', () => {
    expect(cosineSimilarity([1, 1], [50, 50])).toBeCloseTo(1, 10);
  });

  it('stays within [-1,1] despite floating-point error', () => {
    // Without the clamp, an identical pair can land at 1.0000000000000002 and
    // escape the range everything downstream assumes.
    const vector = Array.from({ length: 500 }, (_, i) => Math.sin(i) * 1e6);
    const similarity = cosineSimilarity(vector, vector);
    expect(similarity).toBeLessThanOrEqual(1);
    expect(similarity).toBeGreaterThanOrEqual(-1);
    expect(similarity).toBeCloseTo(1, 10);
  });

  it('returns 0 when either vector is zero', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });

  it('throws on mismatched widths rather than comparing garbage', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(RangeError);
  });
});

describe('HashEmbeddingProvider', () => {
  const provider = new HashEmbeddingProvider({ dimensions: 128 });

  it('names itself with its width, so two widths cannot collide on the PK', () => {
    // (memory_id, model) is a primary key. If a 64- and a 768-wide provider
    // shared a name, their vectors would overwrite each other.
    expect(new HashEmbeddingProvider({ dimensions: 64 }).model).toBe('hash-64');
    expect(new HashEmbeddingProvider({ dimensions: 768 }).model).toBe('hash-768');
  });

  it('defaults to 768, matching the pgvector column', () => {
    expect(new HashEmbeddingProvider().dimensions).toBe(768);
  });

  it('rejects a nonsense width at construction', () => {
    expect(() => new HashEmbeddingProvider({ dimensions: 0 })).toThrow(RangeError);
    expect(() => new HashEmbeddingProvider({ dimensions: -1 })).toThrow(RangeError);
    expect(() => new HashEmbeddingProvider({ dimensions: 1.5 })).toThrow(RangeError);
  });

  it('returns one vector per input, in order', async () => {
    const vectors = await provider.embed(['alpha', 'beta', 'gamma']);
    expect(vectors).toHaveLength(3);
    const [alpha] = await provider.embed(['alpha']);
    expect(vectors[0]).toEqual(alpha);
  });

  it('produces vectors of the declared width', async () => {
    const [vector] = await provider.embed(['anything at all']);
    expect(vector).toHaveLength(128);
  });

  it('is deterministic across calls and instances', async () => {
    // The property the whole test suite leans on. If this breaks, every
    // retrieval assertion becomes a coin flip.
    const [first] = await provider.embed(['the cat sat on the mat']);
    const [second] = await new HashEmbeddingProvider({ dimensions: 128 }).embed([
      'the cat sat on the mat',
    ]);
    expect(first).toEqual(second);
  });

  it('returns unit vectors', async () => {
    const [vector] = await provider.embed(['the cat sat on the mat']);
    const magnitude = Math.sqrt((vector ?? []).reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('handles an empty batch', async () => {
    expect(await provider.embed([])).toEqual([]);
  });

  it('embeds a text with no tokens as the zero vector', async () => {
    const [vector] = await provider.embed(['...']);
    expect(vector?.every((value) => value === 0)).toBe(true);
  });

  it('ranks a text sharing words above one that shares none', async () => {
    // The only semantic claim this provider makes, and the reason it is usable
    // as a stand-in for a real model in retrieval tests. It knows nothing about
    // meaning — only about overlap.
    const [query, related, unrelated] = await provider.embed([
      'the dentist appointment is on tuesday',
      'the dentist appointment was moved',
      'ships sail across the wide ocean',
    ]);

    const toRelated = cosineSimilarity(query ?? [], related ?? []);
    const toUnrelated = cosineSimilarity(query ?? [], unrelated ?? []);
    expect(toRelated).toBeGreaterThan(toUnrelated);
  });

  it('does not make everything similar to everything', async () => {
    // What the sign bit buys. Without it every vector lands in the positive
    // orthant, cosine sits near 1.0 across the corpus, and ranking is noise —
    // which would look like "retrieval works" in a test that only checked
    // ordering on one pair.
    const wide = new HashEmbeddingProvider({ dimensions: 768 });
    const [a, b] = await wide.embed([
      'quantum chromodynamics lattice gauge theory',
      'strawberry rhubarb crumble with custard',
    ]);
    expect(Math.abs(cosineSimilarity(a ?? [], b ?? []))).toBeLessThan(0.3);
  });
});

describe('embedOne', () => {
  it('returns the single vector', async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 32 });
    const vector = await embedOne(provider, 'hello');
    expect(vector).toHaveLength(32);
  });

  it('throws when a provider returns nothing', async () => {
    const empty = {
      model: 'broken',
      dimensions: 8,
      embed: async (): Promise<readonly (readonly number[])[]> => Promise.resolve([]),
    };
    await expect(embedOne(empty, 'hello')).rejects.toThrow(EmbeddingFailedError);
  });
});

describe('assertValidEmbedding', () => {
  const provider = {
    model: 'test',
    dimensions: 3,
    embed: async () => Promise.resolve([]),
  };

  it('accepts a well-formed vector', () => {
    expect(() => {
      assertValidEmbedding(provider, [1, 2, 3]);
    }).not.toThrow();
  });

  it('rejects a wrong-width vector', () => {
    expect(() => {
      assertValidEmbedding(provider, [1, 2]);
    }).toThrow(DimensionMismatchError);
  });

  it('rejects NaN and Infinity', () => {
    // Postgres accepts NaN into a real[] quite happily, and it then poisons
    // every cosine similarity computed against it. This is the only place it can
    // be caught.
    expect(() => {
      assertValidEmbedding(provider, [1, NaN, 3]);
    }).toThrow(EmbeddingFailedError);
    expect(() => {
      assertValidEmbedding(provider, [1, Infinity, 3]);
    }).toThrow(EmbeddingFailedError);
  });
});

describe('OllamaEmbeddingProvider', () => {
  const ok = (embeddings: readonly (readonly number[])[]): typeof globalThis.fetch =>
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

  it('defaults to nomic-embed-text at 768 dimensions', () => {
    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    expect(provider.model).toBe('nomic-embed-text');
    expect(provider.dimensions).toBe(768);
  });

  it('posts the batch to /api/embed and returns the vectors', async () => {
    const fetchStub = ok([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      dimensions: 3,
      fetch: fetchStub,
    });

    const vectors = await provider.embed(['a', 'b']);

    expect(vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(fetchStub).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'nomic-embed-text', input: ['a', 'b'] }),
      }),
    );
  });

  it('strips a trailing slash from the base URL', async () => {
    const fetchStub = ok([[1, 0, 0]]);
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434///',
      dimensions: 3,
      fetch: fetchStub,
    });

    await provider.embed(['a']);

    expect(fetchStub).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.anything(),
    );
  });

  it('does not call the server for an empty batch', async () => {
    const fetchStub = ok([]);
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      fetch: fetchStub,
    });

    expect(await provider.embed([])).toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects a short batch instead of misaligning vectors with texts', async () => {
    // The most dangerous response to get wrong: two vectors for three texts
    // would pair vector[1] with text[2], silently embedding every subsequent
    // memory as its neighbour. Nothing downstream can detect that.
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      dimensions: 3,
      fetch: ok([
        [1, 0, 0],
        [0, 1, 0],
      ]),
    });

    await expect(provider.embed(['a', 'b', 'c'])).rejects.toThrow(
      /expected 3 vectors, got 2/,
    );
  });

  it('rejects a wrong-width vector', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      dimensions: 768,
      fetch: ok([[1, 0, 0]]),
    });
    await expect(provider.embed(['a'])).rejects.toThrow(DimensionMismatchError);
  });

  it('reports a missing embeddings field', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'model not found' }), { status: 200 }),
        ),
    });
    await expect(provider.embed(['a'])).rejects.toThrow(/model not found/);
  });

  it('reports a non-2xx with its status and body', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      fetch: vi
        .fn()
        .mockResolvedValue(new Response('model "nope" not found', { status: 404 })),
    });
    await expect(provider.embed(['a'])).rejects.toThrow(/404.*not found/s);
  });

  it('reports invalid JSON', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      fetch: vi
        .fn()
        .mockResolvedValue(new Response('<html>502</html>', { status: 200 }))
        .mockName('fetch'),
    });
    await expect(provider.embed(['a'])).rejects.toThrow(/not valid JSON/);
  });

  it('explains a connection failure in terms someone can act on', async () => {
    // The error someone actually sees when Ollama is not running. "TypeError:
    // fetch failed" tells them nothing; this names the URL and the two likely
    // causes.
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    });

    await expect(provider.embed(['a'])).rejects.toThrow(
      /Is Ollama running, and has "nomic-embed-text" been pulled\?/,
    );
  });

  it('honours a caller abort', async () => {
    // The kernel's cancellation is cooperative (RFC-0001 §11.1): a provider that
    // ignores its signal holds a task slot past mission cancellation.
    const controller = new AbortController();
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })) as unknown as typeof globalThis.fetch,
    });

    const pending = provider.embed(['a'], controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(EmbeddingFailedError);
  });

  it('gives up after its timeout', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      timeoutMs: 20,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Timed out', 'TimeoutError'));
          });
        })) as unknown as typeof globalThis.fetch,
    });

    await expect(provider.embed(['a'])).rejects.toThrow(/no response within 20ms/);
  });
});
