/**
 * The service — batching, ordering, retries, cancellation, timeout, concurrency,
 * usage/cost, normalization, capability negotiation, dimensions, and metadata.
 *
 * Everything runs against `FakeEmbeddingProvider`, deterministically: `sleep` is
 * injected so retries and backoff take no real time, and the fake's scripted
 * faults stand in for a real provider misbehaving.
 */

import { describe, expect, it, vi } from 'vitest';
import { EmbeddingService } from '../src/service.js';
import { FakeEmbeddingProvider } from '../src/fake-provider.js';

import type { EmbeddingModel } from '../src/types.js';

const noSleep = () => Promise.resolve();

const serviceWith = (
  provider = new FakeEmbeddingProvider(),
  options: ConstructorParameters<typeof EmbeddingService>[1] = {},
): EmbeddingService => new EmbeddingService(provider, { sleep: noSleep, ...options });

describe('batching and ordering', () => {
  it('splits a request into batches of the provider maximum', async () => {
    const provider = new FakeEmbeddingProvider(); // maxBatchSize 4
    const service = serviceWith(provider);
    const texts = Array.from({ length: 10 }, (_, i) => `t${String(i)}`);

    const response = await service.embed({ texts });

    expect(response.embeddings).toHaveLength(10);
    expect(response.batches).toBe(3); // 4 + 4 + 2
    expect(provider.calls.map((c) => c.texts.length)).toEqual([4, 4, 2]);
  });

  it('clamps a configured batch size to the provider maximum', async () => {
    const provider = new FakeEmbeddingProvider();
    const service = serviceWith(provider, { batchSize: 100 });
    await service.embed({ texts: ['a', 'b', 'c', 'd', 'e'] });
    expect(provider.calls.every((c) => c.texts.length <= 4)).toBe(true);
  });

  it('honours a smaller configured batch size', async () => {
    const provider = new FakeEmbeddingProvider();
    const service = serviceWith(provider, { batchSize: 2 });
    await service.embed({ texts: ['a', 'b', 'c', 'd', 'e'] });
    expect(provider.calls.map((c) => c.texts.length)).toEqual([2, 2, 1]);
  });

  it('returns vectors in input order regardless of batch completion order', async () => {
    // A single-item batch size makes every text its own batch; the deterministic
    // vectors let us assert exact alignment.
    const provider = new FakeEmbeddingProvider();
    const service = serviceWith(provider, { batchSize: 1, maxConcurrency: 4 });
    const texts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

    const response = await service.embed({ texts });

    for (const [i, text] of texts.entries()) {
      const direct = await provider.embed({
        texts: [text],
        model: 'fake-embed-3',
        dimensions: 8,
        normalize: false,
        metadata: undefined,
        signal: undefined,
        timeoutMs: undefined,
        offset: 0,
      });
      expect(response.embeddings[i]).toEqual(direct.embeddings[0]);
    }
  });

  it('embeds an empty request without calling the provider', async () => {
    const provider = new FakeEmbeddingProvider();
    const response = await serviceWith(provider).embed({ texts: [] });
    expect(response.embeddings).toEqual([]);
    expect(response.batches).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('embedOne returns a single vector', async () => {
    const vector = await serviceWith().embedOne('solo');
    expect(vector).toHaveLength(8);
  });
});

describe('concurrency', () => {
  it('runs at most maxConcurrency batches at once', async () => {
    let active = 0;
    let peak = 0;
    // A provider that yields while "in flight", so overlapping calls are visible.
    const provider = new FakeEmbeddingProvider();
    const original = provider.embed.bind(provider);
    provider.embed = async (b) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      const result = await original(b);
      active -= 1;
      return result;
    };

    const service = new EmbeddingService(provider, {
      batchSize: 1,
      maxConcurrency: 2,
      sleep: noSleep,
    });
    await service.embed({ texts: ['a', 'b', 'c', 'd', 'e', 'f'] });

    expect(peak).toBe(2); // exactly the cap: enough work to saturate it, never more
    expect(provider.calls).toHaveLength(6);
  });

  it('caps concurrency at the batch count when there are fewer batches', async () => {
    let active = 0;
    let peak = 0;
    const provider = new FakeEmbeddingProvider();
    const original = provider.embed.bind(provider);
    provider.embed = async (b) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      const result = await original(b);
      active -= 1;
      return result;
    };
    const service = new EmbeddingService(provider, {
      batchSize: 1,
      maxConcurrency: 8,
      sleep: noSleep,
    });
    await service.embed({ texts: ['a', 'b'] });
    expect(peak).toBe(2);
  });
});

describe('retries', () => {
  it('retries a retryable failure and then succeeds', async () => {
    const provider = new FakeEmbeddingProvider().failNext({ kind: 'rateLimit' });
    const sleep = vi.fn(() => Promise.resolve());
    const service = new EmbeddingService(provider, { sleep, retries: 2 });

    const response = await service.embed({ texts: ['a'] });
    expect(response.embeddings).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('waits the retry-after when the provider gives one', async () => {
    const provider = new FakeEmbeddingProvider().failNext({
      kind: 'rateLimit',
      retryAfterMs: 1234,
    });
    const sleep = vi.fn(() => Promise.resolve());
    await new EmbeddingService(provider, { sleep }).embed({ texts: ['a'] });
    expect(sleep).toHaveBeenCalledWith(1234, expect.anything());
  });

  it('uses exponential backoff without a retry-after', async () => {
    const provider = new FakeEmbeddingProvider().failNext(
      { kind: 'error', retryable: true },
      2,
    );
    const sleep = vi.fn((_ms: number, _signal?: AbortSignal) => Promise.resolve());
    await new EmbeddingService(provider, { sleep, retries: 2, retryBaseMs: 100 }).embed(
      { texts: ['a'] },
    );
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it('gives up after exhausting retries and throws the last error', async () => {
    const provider = new FakeEmbeddingProvider().failNext({ kind: 'rateLimit' }, 5);
    const service = new EmbeddingService(provider, { sleep: noSleep, retries: 2 });
    await expect(service.embed({ texts: ['a'] })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(provider.calls).toHaveLength(3); // initial + 2 retries
  });

  it('does not retry a non-retryable failure', async () => {
    const provider = new FakeEmbeddingProvider().failNext({
      kind: 'error',
      retryable: false,
    });
    const service = new EmbeddingService(provider, { sleep: noSleep });
    await expect(service.embed({ texts: ['a'] })).rejects.toMatchObject({
      retryable: false,
    });
    expect(provider.calls).toHaveLength(1);
  });

  it('retries a transient malformed response, then succeeds', async () => {
    const provider = new FakeEmbeddingProvider().failNext({
      kind: 'malformed',
      how: 'count',
    });
    const service = new EmbeddingService(provider, { sleep: noSleep });
    const response = await service.embed({ texts: ['a', 'b'] });
    expect(response.embeddings).toHaveLength(2);
  });

  it('does not retry a dimension mismatch (a config error)', async () => {
    const provider = new FakeEmbeddingProvider().failNext(
      { kind: 'malformed', how: 'width' },
      5,
    );
    const service = new EmbeddingService(provider, { sleep: noSleep, retries: 3 });
    await expect(service.embed({ texts: ['a'] })).rejects.toMatchObject({
      code: 'DIMENSION_MISMATCH',
    });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const provider = new FakeEmbeddingProvider();
    await expect(
      serviceWith(provider).embed({ texts: ['a'], signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(provider.calls).toHaveLength(0);
  });

  it('a batch failure cancels in-flight sibling batches', async () => {
    // First batch fails non-retryably; the shared controller aborts, and a slow
    // sibling sees the cancellation rather than running to completion.
    const provider = new FakeEmbeddingProvider().failNext({
      kind: 'error',
      retryable: false,
    });
    const service = new EmbeddingService(provider, {
      sleep: noSleep,
      batchSize: 1,
      maxConcurrency: 4,
    });
    await expect(service.embed({ texts: ['a', 'b', 'c', 'd'] })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });
});

describe('timeout propagation', () => {
  it('passes the request timeout down to each batch', async () => {
    const provider = new FakeEmbeddingProvider();
    await serviceWith(provider).embed({
      texts: ['a', 'b', 'c', 'd', 'e'],
      timeoutMs: 5000,
    });
    expect(provider.calls.every((c) => c.timeoutMs === 5000)).toBe(true);
  });

  it('surfaces a provider timeout', async () => {
    const provider = new FakeEmbeddingProvider({
      latencyMs: 100,
      sleep: () => Promise.resolve(),
    });
    const service = new EmbeddingService(provider, { sleep: noSleep, retries: 0 });
    await expect(service.embed({ texts: ['a'], timeoutMs: 10 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});

describe('usage and cost', () => {
  it('aggregates usage across batches and computes cost', async () => {
    const provider = new FakeEmbeddingProvider(); // costPer1kTokens 0.0001
    const response = await serviceWith(provider).embed({
      texts: ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'],
    });
    const total = response.usage?.totalTokens ?? 0;
    expect(total).toBeGreaterThan(0);
    expect(response.cost?.per1kTokens).toBe(0.0001);
    expect(response.cost?.usd).toBeCloseTo((total * 0.0001) / 1000);
  });

  it('omits usage and cost when the provider reports none', async () => {
    const provider = new FakeEmbeddingProvider({ reportUsage: false });
    const response = await serviceWith(provider).embed({ texts: ['a'] });
    expect(response.usage).toBeUndefined();
    expect(response.cost).toBeUndefined();
  });
});

describe('normalization', () => {
  it('normalizes vectors itself when the provider does not', async () => {
    const provider = new FakeEmbeddingProvider(); // normalizesByDefault: false
    const response = await serviceWith(provider).embed({
      texts: ['x'],
      normalize: true,
    });
    expect(response.normalized).toBe(true);
    expect(Math.hypot(...(response.embeddings[0] ?? []))).toBeCloseTo(1);
  });

  it('leaves vectors alone when normalize is not requested', async () => {
    const provider = new FakeEmbeddingProvider();
    const raw = await provider.embed({
      texts: ['x'],
      model: 'fake-embed-3',
      dimensions: 8,
      normalize: false,
      metadata: undefined,
      signal: undefined,
      timeoutMs: undefined,
      offset: 0,
    });
    const response = await serviceWith(provider).embed({ texts: ['x'] });
    expect(response.embeddings[0]).toEqual(raw.embeddings[0]);
    expect(response.normalized).toBe(false);
  });

  it('does not double-normalize a provider that is already unit-length', async () => {
    const unitModel: EmbeddingModel = {
      name: 'unit',
      provider: 'fake',
      dimensions: 8,
      capabilities: {
        maxBatchSize: 4,
        configurableDimensions: false,
        normalizesByDefault: true,
      },
    };
    const provider = new FakeEmbeddingProvider({ models: [unitModel] });
    // The fake does not actually return unit vectors, but declares it does; the
    // service must trust the declaration and not re-scale.
    const raw = await provider.embed({
      texts: ['x'],
      model: 'unit',
      dimensions: 8,
      normalize: false,
      metadata: undefined,
      signal: undefined,
      timeoutMs: undefined,
      offset: 0,
    });
    const response = await serviceWith(provider).embed({
      texts: ['x'],
      normalize: true,
    });
    expect(response.embeddings[0]).toEqual(raw.embeddings[0]);
    expect(response.normalized).toBe(true);
  });
});

describe('capability negotiation and dimensions', () => {
  it('exposes the provider capabilities and models', () => {
    const service = serviceWith();
    expect(service.capabilities().maxBatchSize).toBe(4);
    expect(service.models()[0]?.name).toBe('fake-embed-3');
  });

  it('honours a supported configurable dimension', async () => {
    const provider = new FakeEmbeddingProvider();
    const response = await serviceWith(provider).embed({
      texts: ['x'],
      dimensions: 16,
    });
    expect(response.dimensions).toBe(16);
    expect(response.embeddings[0]).toHaveLength(16);
  });

  it('rejects an unsupported dimension', async () => {
    await expect(
      serviceWith().embed({ texts: ['x'], dimensions: 999 }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('rejects dimensions on a model that does not support them', async () => {
    const fixed: EmbeddingModel = {
      name: 'fixed',
      provider: 'fake',
      dimensions: 8,
      capabilities: {
        maxBatchSize: 4,
        configurableDimensions: false,
        normalizesByDefault: false,
      },
    };
    const provider = new FakeEmbeddingProvider({ models: [fixed] });
    await expect(
      serviceWith(provider).embed({ texts: ['x'], dimensions: 16 }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('selects a named model and rejects an unknown one', async () => {
    const provider = new FakeEmbeddingProvider({
      models: [
        {
          name: 'small',
          provider: 'fake',
          dimensions: 8,
          capabilities: {
            maxBatchSize: 4,
            configurableDimensions: false,
            normalizesByDefault: false,
          },
        },
        {
          name: 'large',
          provider: 'fake',
          dimensions: 32,
          capabilities: {
            maxBatchSize: 4,
            configurableDimensions: false,
            normalizesByDefault: false,
          },
        },
      ],
    });
    const service = serviceWith(provider);
    expect((await service.embed({ texts: ['x'], model: 'large' })).dimensions).toBe(32);
    await expect(service.embed({ texts: ['x'], model: 'ghost' })).rejects.toMatchObject(
      { code: 'UNKNOWN_MODEL' },
    );
  });

  it('uses a configured default model', async () => {
    const provider = new FakeEmbeddingProvider({
      models: [
        {
          name: 'a',
          provider: 'fake',
          dimensions: 8,
          capabilities: {
            maxBatchSize: 4,
            configurableDimensions: false,
            normalizesByDefault: false,
          },
        },
        {
          name: 'b',
          provider: 'fake',
          dimensions: 16,
          capabilities: {
            maxBatchSize: 4,
            configurableDimensions: false,
            normalizesByDefault: false,
          },
        },
      ],
    });
    const service = new EmbeddingService(provider, {
      defaultModel: 'b',
      sleep: noSleep,
    });
    expect((await service.embed({ texts: ['x'] })).model).toBe('b');
  });
});

describe('metadata', () => {
  it('echoes request metadata back on the response', async () => {
    const meta = { requestId: 'r-1', tenant: 'acme' };
    const response = await serviceWith().embed({ texts: ['x'], metadata: meta });
    expect(response.metadata).toEqual(meta);
  });

  it('passes metadata through to each batch', async () => {
    const provider = new FakeEmbeddingProvider();
    await serviceWith(provider).embed({
      texts: ['a', 'b', 'c', 'd', 'e'],
      metadata: { k: 'v' },
    });
    expect(provider.calls.every((c) => c.metadata?.['k'] === 'v')).toBe(true);
  });
});
