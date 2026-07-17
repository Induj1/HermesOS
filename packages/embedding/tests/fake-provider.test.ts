/**
 * The deterministic fake provider — the substrate of the service tests, tested
 * itself so those tests can trust it.
 */

import { describe, expect, it, vi } from 'vitest';
import { FakeEmbeddingProvider } from '../src/fake-provider.js';
import type { EmbeddingBatch } from '../src/types.js';
import {
  EmbeddingCancelledError,
  EmbeddingTimeoutError,
  RateLimitedError,
  UnknownModelError,
} from '../src/errors.js';

const batch = (over: Partial<EmbeddingBatch> = {}): EmbeddingBatch => ({
  texts: ['hello'],
  model: 'fake-embed-3',
  dimensions: 8,
  normalize: false,
  metadata: undefined,
  signal: undefined,
  timeoutMs: undefined,
  offset: 0,
  ...over,
});

describe('capabilities and models', () => {
  it('serves a default model with capabilities', () => {
    const p = new FakeEmbeddingProvider();
    expect(p.models()).toHaveLength(1);
    expect(p.capabilities()).toMatchObject({
      maxBatchSize: 4,
      configurableDimensions: true,
    });
  });

  it('stamps the provider name onto its models', () => {
    const p = new FakeEmbeddingProvider({ name: 'test' });
    expect(p.info.name).toBe('test');
    expect(p.models()[0]?.provider).toBe('test');
  });

  it('throws UnknownModelError for a model it does not serve', () => {
    expect(() => new FakeEmbeddingProvider().capabilities('nope')).toThrow(
      UnknownModelError,
    );
  });
});

describe('deterministic vectors', () => {
  it('returns the same vector for the same text every time', async () => {
    const p = new FakeEmbeddingProvider();
    const a = await p.embed(batch({ texts: ['stable'] }));
    const b = await p.embed(batch({ texts: ['stable'] }));
    expect(a.embeddings[0]).toEqual(b.embeddings[0]);
    expect(a.embeddings[0]).toHaveLength(8);
  });

  it('returns different vectors for different texts', async () => {
    const p = new FakeEmbeddingProvider();
    const r = await p.embed(batch({ texts: ['a', 'b'] }));
    expect(r.embeddings[0]).not.toEqual(r.embeddings[1]);
  });

  it('honours the requested dimensions', async () => {
    const p = new FakeEmbeddingProvider();
    const r = await p.embed(batch({ texts: ['x'], dimensions: 16 }));
    expect(r.embeddings[0]).toHaveLength(16);
  });

  it('reports usage by default and can be told not to', async () => {
    expect((await new FakeEmbeddingProvider().embed(batch())).usage).toBeDefined();
    expect(
      (await new FakeEmbeddingProvider({ reportUsage: false }).embed(batch())).usage,
    ).toBeUndefined();
  });

  it('records every call for assertions', async () => {
    const p = new FakeEmbeddingProvider();
    await p.embed(batch({ texts: ['one'] }));
    await p.embed(batch({ texts: ['two'], offset: 1 }));
    expect(p.calls.map((c) => c.texts)).toEqual([['one'], ['two']]);
  });
});

describe('scripted faults', () => {
  it('rate-limits with a retry-after, then succeeds', async () => {
    const p = new FakeEmbeddingProvider().failNext({
      kind: 'rateLimit',
      retryAfterMs: 500,
    });
    const err = await p.embed(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(500);
    await expect(p.embed(batch())).resolves.toBeDefined();
  });

  it('applies a queued fault only once', async () => {
    const p = new FakeEmbeddingProvider().failNext({ kind: 'rateLimit' });
    await expect(p.embed(batch())).rejects.toBeInstanceOf(RateLimitedError);
    await expect(p.embed(batch())).resolves.toBeDefined();
  });

  it('applies faults in order for a count', async () => {
    const p = new FakeEmbeddingProvider().failNext(
      { kind: 'error', retryable: true },
      2,
    );
    await expect(p.embed(batch())).rejects.toMatchObject({ retryable: true });
    await expect(p.embed(batch())).rejects.toMatchObject({ retryable: true });
    await expect(p.embed(batch())).resolves.toBeDefined();
  });

  it('produces the three malformed shapes', async () => {
    const count = await new FakeEmbeddingProvider()
      .failNext({ kind: 'malformed', how: 'count' })
      .embed(batch({ texts: ['a', 'b'] }));
    expect(count.embeddings).toHaveLength(1);

    const width = await new FakeEmbeddingProvider()
      .failNext({ kind: 'malformed', how: 'width' })
      .embed(batch({ texts: ['a'] }));
    expect(width.embeddings[0]).toHaveLength(9);

    const nan = await new FakeEmbeddingProvider()
      .failNext({ kind: 'malformed', how: 'nan' })
      .embed(batch({ texts: ['a'] }));
    expect(Number.isNaN(nan.embeddings[0]?.[0])).toBe(true);
  });

  it('an error fault defaults to PROVIDER_ERROR and non-retryable', async () => {
    const p = new FakeEmbeddingProvider().failNext({ kind: 'error' });
    const err = await p.embed(batch()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR', retryable: false });
  });

  it('throws UnknownModelError when a batch names a model it does not serve', async () => {
    const p = new FakeEmbeddingProvider();
    await expect(p.embed(batch({ model: 'ghost' }))).rejects.toMatchObject({
      code: 'UNKNOWN_MODEL',
    });
  });

  it('an "ok" fault consumes a slot but succeeds', async () => {
    const p = new FakeEmbeddingProvider()
      .failNext({ kind: 'ok' })
      .failNext({ kind: 'rateLimit' });
    await expect(p.embed(batch())).resolves.toBeDefined();
    await expect(p.embed(batch())).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('latency, timeout, and cancellation', () => {
  it('sleeps for the configured latency', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const p = new FakeEmbeddingProvider({ latencyMs: 50, sleep });
    await p.embed(batch());
    expect(sleep).toHaveBeenCalledWith(50, undefined);
  });

  it('times out when latency exceeds the deadline', async () => {
    const p = new FakeEmbeddingProvider({
      latencyMs: 100,
      sleep: () => Promise.resolve(),
    });
    await expect(p.embed(batch({ timeoutMs: 10 }))).rejects.toBeInstanceOf(
      EmbeddingTimeoutError,
    );
  });

  it('honours an aborted signal', async () => {
    const p = new FakeEmbeddingProvider();
    await expect(
      p.embed(batch({ signal: AbortSignal.abort() })),
    ).rejects.toBeInstanceOf(EmbeddingCancelledError);
  });

  it('a scripted timeout fault throws a timeout, with or without a deadline', async () => {
    await expect(
      new FakeEmbeddingProvider()
        .failNext({ kind: 'timeout' })
        .embed(batch({ timeoutMs: 1000 })),
    ).rejects.toBeInstanceOf(EmbeddingTimeoutError);
    await expect(
      new FakeEmbeddingProvider().failNext({ kind: 'timeout' }).embed(batch()),
    ).rejects.toBeInstanceOf(EmbeddingTimeoutError);
  });

  it('an error fault can carry a specific code', async () => {
    const p = new FakeEmbeddingProvider().failNext({
      kind: 'error',
      code: 'AUTHENTICATION_FAILED',
    });
    await expect(p.embed(batch())).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
  });

  it('capabilities on a provider with no models throws for the default', () => {
    expect(() => new FakeEmbeddingProvider({ models: [] }).capabilities()).toThrow(
      UnknownModelError,
    );
  });
});
