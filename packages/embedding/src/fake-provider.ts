/**
 * A deterministic embedding provider — for tests, and a real implementation.
 *
 * It behaves like a real provider (declares models and capabilities, honours
 * batch sizes, reports usage, respects cancellation and timeout) while producing
 * **the same vector for the same text every time**, so a test can assert on exact
 * values without a network or a model. The vectors are a seeded PRNG over the
 * text, which gives stable, well-distributed, non-trivial numbers — not a constant
 * a bug could accidentally satisfy.
 *
 * Every failure mode a real provider has is scriptable through {@link failNext}:
 * rate limits (with or without a `retry-after`), timeouts, malformed responses
 * (wrong count, wrong width, `NaN`), and arbitrary errors — so the service's
 * batching, retry, ordering, and error handling are all exercised against
 * realistic behaviour that is nonetheless deterministic.
 */

import {
  EmbeddingCancelledError,
  EmbeddingError,
  EmbeddingTimeoutError,
  RateLimitedError,
  type EmbeddingErrorCode,
} from './errors.js';
import type { EmbeddingProvider } from './provider.js';
import { UnknownModelError } from './errors.js';
import { defaultSleep } from './sleep.js';
import type {
  EmbeddingBatch,
  EmbeddingBatchResponse,
  EmbeddingCapabilities,
  EmbeddingModel,
  ProviderInfo,
} from './types.js';

/** A scripted fault the fake applies to a single call, in order. */
export type FakeFault =
  | { readonly kind: 'rateLimit'; readonly retryAfterMs?: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'malformed'; readonly how: 'count' | 'width' | 'nan' }
  | {
      readonly kind: 'error';
      readonly code?: EmbeddingErrorCode;
      readonly retryable?: boolean;
    }
  /** An explicit success — consumes a fault slot but returns real vectors. */
  | { readonly kind: 'ok' };

export interface FakeEmbeddingOptions {
  readonly name?: string;
  /** The models to serve. Defaults to a single `fake-embed-3` at 8 dimensions. */
  readonly models?: readonly EmbeddingModel[];
  /** Simulated per-call latency in ms. With a shorter `timeoutMs`, the call times out. */
  readonly latencyMs?: number;
  /** Report token usage in responses (roughly 1 token per 4 chars). Default true. */
  readonly reportUsage?: boolean;
  /** Delay primitive, injectable for deterministic tests. Default a real timer. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_MODEL: EmbeddingModel = {
  name: 'fake-embed-3',
  provider: 'fake',
  dimensions: 8,
  capabilities: {
    maxBatchSize: 4,
    maxInputTokens: 8192,
    configurableDimensions: true,
    supportedDimensions: [8, 16, 32],
    normalizesByDefault: false,
    costPer1kTokens: 0.0001,
  },
};

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly info: ProviderInfo;
  /** Every batch it was asked to embed, in call order, for assertions. */
  readonly calls: EmbeddingBatch[] = [];

  readonly #models: readonly EmbeddingModel[];
  readonly #latencyMs: number;
  readonly #reportUsage: boolean;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #faults: FakeFault[] = [];

  constructor(options: FakeEmbeddingOptions = {}) {
    const name = options.name ?? 'fake';
    this.info = { name };
    this.#models = (options.models ?? [DEFAULT_MODEL]).map((m) => ({
      ...m,
      provider: name,
    }));
    this.#latencyMs = options.latencyMs ?? 0;
    this.#reportUsage = options.reportUsage ?? true;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Queue `count` copies of a fault to apply to the next calls, in order. */
  failNext(fault: FakeFault, count = 1): this {
    for (let i = 0; i < count; i += 1) this.#faults.push(fault);
    return this;
  }

  models(): readonly EmbeddingModel[] {
    return this.#models;
  }

  capabilities(model?: string): EmbeddingCapabilities {
    return this.#resolve(model).capabilities;
  }

  async embed(batch: EmbeddingBatch): Promise<EmbeddingBatchResponse> {
    this.calls.push(batch);
    const model = this.#resolve(batch.model);

    if (batch.signal?.aborted === true)
      throw new EmbeddingCancelledError(this.info.name);

    // Latency, and the timeout that a too-short deadline imposes on it.
    if (this.#latencyMs > 0) {
      if (batch.timeoutMs !== undefined && this.#latencyMs > batch.timeoutMs) {
        throw new EmbeddingTimeoutError(this.info.name, batch.timeoutMs);
      }
      await this.#sleep(this.#latencyMs, batch.signal);
    }

    const fault = this.#faults.shift();
    if (fault !== undefined && fault.kind !== 'ok') {
      return this.#applyFault(fault, batch, model);
    }

    const dimensions = batch.dimensions;
    const embeddings = batch.texts.map((text) =>
      vectorFor(`${model.name}:${text}`, dimensions),
    );
    return {
      model: model.name,
      dimensions,
      embeddings,
      normalized: false,
      ...(this.#reportUsage ? { usage: usageFor(batch.texts) } : {}),
    };
  }

  #applyFault(
    fault: Exclude<FakeFault, { kind: 'ok' }>,
    batch: EmbeddingBatch,
    model: EmbeddingModel,
  ): EmbeddingBatchResponse {
    switch (fault.kind) {
      case 'rateLimit':
        throw new RateLimitedError(this.info.name, fault.retryAfterMs);
      case 'timeout':
        throw new EmbeddingTimeoutError(this.info.name, batch.timeoutMs ?? 0);
      case 'error':
        throw new EmbeddingError(
          fault.code ?? 'PROVIDER_ERROR',
          this.info.name,
          'scripted failure',
          {
            retryable: fault.retryable ?? false,
          },
        );
      case 'malformed':
        return this.#malformed(fault.how, batch, model);
    }
  }

  #malformed(
    how: 'count' | 'width' | 'nan',
    batch: EmbeddingBatch,
    model: EmbeddingModel,
  ): EmbeddingBatchResponse {
    const dimensions = batch.dimensions;
    if (how === 'count') {
      // One fewer vector than texts.
      const embeddings = batch.texts
        .slice(1)
        .map((text) => vectorFor(`${model.name}:${text}`, dimensions));
      return { model: model.name, dimensions, embeddings, normalized: false };
    }
    if (how === 'width') {
      const embeddings = batch.texts.map((text) =>
        vectorFor(`${model.name}:${text}`, dimensions + 1),
      );
      return { model: model.name, dimensions, embeddings, normalized: false };
    }
    // 'nan': a finite vector with one poisoned value.
    const embeddings = batch.texts.map((text) => {
      const v = vectorFor(`${model.name}:${text}`, dimensions);
      return [Number.NaN, ...v.slice(1)];
    });
    return { model: model.name, dimensions, embeddings, normalized: false };
  }

  #resolve(model?: string): EmbeddingModel {
    if (model === undefined) {
      const first = this.#models[0];
      if (first === undefined) throw new UnknownModelError(this.info.name, '(default)');
      return first;
    }
    const found = this.#models.find((m) => m.name === model);
    if (found === undefined) throw new UnknownModelError(this.info.name, model);
    return found;
  }
}

/** A deterministic, well-distributed vector for a string, of the given width. */
function vectorFor(seedText: string, dimensions: number): number[] {
  const rand = mulberry32(hash(seedText));
  const out = new Array<number>(dimensions);
  for (let i = 0; i < dimensions; i += 1) out[i] = rand() * 2 - 1;
  return out;
}

/** ~1 token per 4 characters, the usual rough rule, summed over the batch. */
function usageFor(texts: readonly string[]): {
  promptTokens: number;
  totalTokens: number;
} {
  let tokens = 0;
  for (const text of texts) tokens += Math.max(1, Math.ceil(text.length / 4));
  return { promptTokens: tokens, totalTokens: tokens };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
