/**
 * The memory adapter, and the one type claim that spans two packages.
 *
 * The adapter's whole job is narrowing: `MemoryService` can write, and
 * `MemoryAdapter` cannot. Most of what follows is about the *other* thing it
 * does — deciding what an unknown memory kind means — because that one has a
 * direction, and the wrong direction fails open.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider, MemoryService } from '@hermes/memory';
import type { EmbeddingModel } from '@hermes/model';
import { memoryAdapter } from '../src/adapters/memory-adapter.js';

/** Just enough MemoryService to adapt. The adapter only ever calls `recall`. */
function fakeService(recall = vi.fn().mockResolvedValue([])): {
  service: MemoryService;
  recall: ReturnType<typeof vi.fn>;
} {
  return { service: { recall } as unknown as MemoryService, recall };
}

describe('memoryAdapter', () => {
  // The enforcement, in one assertion: a reasoner holding this cannot write,
  // because there is no method to call.
  it('offers recall and nothing else', () => {
    const { service } = fakeService();

    const adapter = memoryAdapter(service);

    expect(Object.keys(adapter)).toEqual(['recall']);
    expect(adapter).not.toHaveProperty('remember');
    expect(adapter).not.toHaveProperty('forget');
    expect(adapter).not.toHaveProperty('db');
  });

  it('passes the subject and query through', async () => {
    const { service, recall } = fakeService();

    await memoryAdapter(service).recall('ada', 'coffee?');

    expect(recall).toHaveBeenCalledWith('ada', 'coffee?', {});
  });

  it('passes the limits through', async () => {
    const { service, recall } = fakeService();

    await memoryAdapter(service).recall('ada', 'coffee?', {
      limit: 3,
      minSimilarity: 0.5,
    });

    expect(recall).toHaveBeenCalledWith('ada', 'coffee?', {
      limit: 3,
      minSimilarity: 0.5,
    });
  });

  it('returns what memory returned', async () => {
    const found = [
      { memory: { content: 'Ada prefers dark roast' }, score: 1, similarity: 1 },
    ];
    const { service } = fakeService(vi.fn().mockResolvedValue(found));

    expect(await memoryAdapter(service).recall('ada', 'coffee?')).toBe(found);
  });

  describe('memory kinds', () => {
    it('passes real kinds through', async () => {
      const { service, recall } = fakeService();

      await memoryAdapter(service).recall('ada', 'x', {
        kinds: ['fact', 'preference'],
      });

      expect(recall).toHaveBeenCalledWith('ada', 'x', {
        kinds: ['fact', 'preference'],
      });
    });

    // A model asking for a kind that does not exist should get the memories it
    // *can* have, not an error it cannot act on.
    it('drops an unknown kind rather than rejecting the call', async () => {
      const { service, recall } = fakeService();

      await memoryAdapter(service).recall('ada', 'x', {
        kinds: ['preference', 'vibe'],
      });

      expect(recall).toHaveBeenCalledWith('ada', 'x', { kinds: ['preference'] });
    });

    // The one with a direction. Memory reads an empty `kinds` as "no filter"
    // (RFC-0002 §9.7), so passing the emptied list down would widen the request
    // from "only vibes" to "every kind there is" — a filter that fails open, and
    // exactly how an agent would see memories a host used `kinds` to hide.
    it('returns nothing when every requested kind is unknown', async () => {
      const { service, recall } = fakeService();

      const found = await memoryAdapter(service).recall('ada', 'x', {
        kinds: ['vibe'],
      });

      expect(found).toEqual([]);
      // It never asked. Asking with an empty filter is what would have failed open.
      expect(recall).not.toHaveBeenCalled();
    });

    it('does not filter when the caller named no kinds', async () => {
      const { service, recall } = fakeService();

      await memoryAdapter(service).recall('ada', 'x');

      expect(recall).toHaveBeenCalledWith('ada', 'x', {});
    });
  });
});

/**
 * The claim `@hermes/model`'s `EmbeddingModel` makes about itself.
 *
 * It says it is a strict superset of `@hermes/memory`'s `EmbeddingProvider`, so
 * one object satisfies both and a host wires the same embedder into memory and
 * into a model router with no adapter. That claim spans two packages, and this is
 * the only place both are visible — `@hermes/model` has no dependencies and
 * cannot see memory at all.
 *
 * The assertions are compile-time: if either interface drifts, `pnpm typecheck`
 * fails here rather than a host discovering it at a call site.
 */
describe('EmbeddingModel is an EmbeddingProvider', () => {
  it('satisfies the memory service interface without an adapter', () => {
    const model: EmbeddingModel = {
      info: {
        name: 'nomic-embed-text',
        provider: 'ollama',
        supports: { chat: false, tools: false, streaming: false },
      },
      model: 'nomic-embed-text',
      dimensions: 768,
      embed: (texts) => Promise.resolve(texts.map(() => [0.1, 0.2])),
    };

    // The assignment is the test. It does not compile if the shapes diverge.
    const provider: EmbeddingProvider = model;

    expect(provider.model).toBe('nomic-embed-text');
    expect(provider.dimensions).toBe(768);
  });

  it('embeds through the memory-facing type', async () => {
    const model: EmbeddingModel = {
      info: {
        name: 'e',
        provider: 'fake',
        supports: { chat: false, tools: false, streaming: false },
      },
      model: 'e',
      dimensions: 2,
      embed: (texts) => Promise.resolve(texts.map((_, index) => [index, index])),
    };
    const provider: EmbeddingProvider = model;

    expect(await provider.embed(['a', 'b'])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  // The reverse must not hold: a bare embedder has no ModelInfo, so a router has
  // nothing to route on. If this ever started compiling, `info` would have gone
  // optional and the router's whole premise with it.
  it('does not hold in reverse, because a provider has no ModelInfo', () => {
    const provider: EmbeddingProvider = {
      model: 'e',
      dimensions: 2,
      embed: (texts) => Promise.resolve(texts.map(() => [0, 0])),
    };

    // @ts-expect-error an EmbeddingProvider is not an EmbeddingModel: no `info`.
    const model: EmbeddingModel = provider;

    expect(model.model).toBe('e');
  });
});
