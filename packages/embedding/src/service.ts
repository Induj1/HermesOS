/**
 * The embedding service — the platform layer over a provider.
 *
 * A provider turns one batch into vectors. Everything that makes that safe and
 * efficient at scale lives here, once, so it is identical for every backend:
 *
 * - **Batching.** A request's texts are split into batches sized to the provider's
 *   `maxBatchSize` (or a smaller configured size). One 10,000-text request becomes
 *   the fewest provider calls that respect the limit.
 * - **Concurrency.** Batches run through a bounded pool, so a large request does
 *   not open a thousand simultaneous connections — `maxConcurrency` at a time.
 * - **Retries.** Each batch retries on a *retryable* failure (rate limit, timeout,
 *   transient corruption) with exponential backoff, honouring a `retry-after`.
 *   A non-retryable failure fails the whole request at once.
 * - **Deterministic ordering.** Results are reassembled by each batch's `offset`,
 *   so the output aligns to the input regardless of which batch finished first.
 * - **Cancellation & timeout.** The caller's signal cancels every batch; a batch
 *   failure cancels its in-flight siblings; the per-call timeout rides down to the
 *   provider.
 * - **Normalization, usage, and cost.** Applied and aggregated uniformly.
 *
 * The service depends only on the {@link EmbeddingProvider} contract and the
 * kernel's `Logger` — no transport, no vendor.
 */

import { noopLogger, type Logger } from '@hermes/kernel';
import {
  EmbeddingCancelledError,
  InvalidRequestError,
  isRetryable,
  RateLimitedError,
  toError,
} from './errors.js';
import { assertBatch, l2normalize } from './normalize.js';
import { type EmbeddingProvider, resolveModel } from './provider.js';
import { defaultSleep } from './sleep.js';
import type {
  Embedding,
  EmbeddingBatch,
  EmbeddingCapabilities,
  EmbeddingModel,
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingUsage,
} from './types.js';

export interface EmbeddingServiceOptions {
  /** Desired batch size. Clamped down to the provider's `maxBatchSize`. */
  readonly batchSize?: number;
  /** Batches in flight at once. Default 4. */
  readonly maxConcurrency?: number;
  /** Retries per batch on a retryable failure. Default 2 (so up to 3 attempts). */
  readonly retries?: number;
  /** Base backoff in ms; doubles each attempt. Default 200. */
  readonly retryBaseMs?: number;
  /** Model used when a request names none and the provider serves several. */
  readonly defaultModel?: string;
  readonly logger?: Logger;
  /** Delay primitive, injectable for deterministic tests. Default a real cancellable timer. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** One batch's outcome, carried with its offset for ordered reassembly. */
interface BatchResult {
  readonly offset: number;
  readonly embeddings: readonly Embedding[];
  readonly usage: EmbeddingUsage | undefined;
}

export class EmbeddingService {
  readonly #provider: EmbeddingProvider;
  readonly #batchSize: number | undefined;
  readonly #concurrency: number;
  readonly #retries: number;
  readonly #retryBaseMs: number;
  readonly #defaultModel: string | undefined;
  readonly #logger: Logger;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(provider: EmbeddingProvider, options: EmbeddingServiceOptions = {}) {
    this.#provider = provider;
    this.#batchSize = options.batchSize;
    this.#concurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.#retries = Math.max(0, options.retries ?? 2);
    this.#retryBaseMs = options.retryBaseMs ?? 200;
    this.#defaultModel = options.defaultModel;
    this.#logger = (options.logger ?? noopLogger).child({
      component: 'embedding',
      provider: provider.info.name,
    });
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** The models the underlying provider serves. */
  models(): readonly EmbeddingModel[] {
    return this.#provider.models();
  }

  /** Capabilities of a model (or the default). */
  capabilities(model?: string): EmbeddingCapabilities {
    return this.#provider.capabilities(model ?? this.#defaultModel);
  }

  /** Embed a single text. Sugar over {@link embed}; do not call it in a loop. */
  async embedOne(
    text: string,
    options: Omit<EmbeddingRequest, 'texts'> = {},
  ): Promise<Embedding> {
    const response = await this.embed({ ...options, texts: [text] });
    const vector = response.embeddings[0];
    if (vector === undefined) {
      throw new InvalidRequestError(
        this.#provider.info.name,
        'the provider returned no vector',
      );
    }
    return vector;
  }

  /**
   * Embed a request: batch, run concurrently with retries, and return vectors in
   * input order with aggregated usage and computed cost.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const providerName = this.#provider.info.name;
    if (request.signal?.aborted === true)
      throw new EmbeddingCancelledError(providerName);

    const model = resolveModel(this.#provider, request.model ?? this.#defaultModel);
    const capabilities = this.#provider.capabilities(model.name);
    const dimensions = this.#resolveDimensions(request, model, capabilities);
    const normalize = request.normalize ?? false;

    // An empty request is a no-op — no provider call, an empty result. Cheaper
    // and kinder than sending a zero-item batch a provider might reject.
    if (request.texts.length === 0) {
      return {
        model: model.name,
        dimensions,
        embeddings: [],
        usage: undefined,
        cost: undefined,
        normalized: normalize || capabilities.normalizesByDefault,
        metadata: request.metadata,
        batches: 0,
      };
    }

    const batchSize = Math.max(
      1,
      Math.min(this.#batchSize ?? capabilities.maxBatchSize, capabilities.maxBatchSize),
    );
    if (this.#batchSize !== undefined && this.#batchSize > capabilities.maxBatchSize) {
      this.#logger.warn('requested batch size exceeds provider maximum; clamping', {
        requested: this.#batchSize,
        maximum: capabilities.maxBatchSize,
      });
    }

    // A shared controller so a batch failure (or the caller's signal) cancels the
    // in-flight siblings rather than leaving them running against a doomed request.
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(request.signal?.reason);
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const batches = this.#split(
      request,
      model.name,
      dimensions,
      normalize,
      controller.signal,
      batchSize,
    );

    try {
      const results = await this.#runBatches(
        batches,
        dimensions,
        normalize,
        capabilities,
      );
      return this.#assemble(
        request,
        model.name,
        dimensions,
        normalize,
        capabilities,
        results,
      );
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  #resolveDimensions(
    request: EmbeddingRequest,
    model: EmbeddingModel,
    caps: EmbeddingCapabilities,
  ): number {
    if (request.dimensions === undefined) return model.dimensions;
    if (!caps.configurableDimensions) {
      throw new InvalidRequestError(
        this.#provider.info.name,
        `model "${model.name}" does not support configurable dimensions`,
      );
    }
    if (
      caps.supportedDimensions !== undefined &&
      !caps.supportedDimensions.includes(request.dimensions)
    ) {
      throw new InvalidRequestError(
        this.#provider.info.name,
        `model "${model.name}" does not support ${String(request.dimensions)} dimensions`,
      );
    }
    return request.dimensions;
  }

  #split(
    request: EmbeddingRequest,
    model: string,
    dimensions: number,
    normalize: boolean,
    signal: AbortSignal,
    batchSize: number,
  ): EmbeddingBatch[] {
    const batches: EmbeddingBatch[] = [];
    for (let offset = 0; offset < request.texts.length; offset += batchSize) {
      batches.push({
        texts: request.texts.slice(offset, offset + batchSize),
        model,
        dimensions,
        normalize,
        metadata: request.metadata,
        signal,
        timeoutMs: request.timeoutMs,
        offset,
      });
    }
    return batches;
  }

  /** Run all batches through a bounded pool; the first failure aborts the rest. */
  async #runBatches(
    batches: readonly EmbeddingBatch[],
    dimensions: number,
    normalize: boolean,
    caps: EmbeddingCapabilities,
  ): Promise<BatchResult[]> {
    const results = new Array<BatchResult>(batches.length);
    let cursor = 0;
    let failure: unknown;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure !== undefined) return;
        const index = cursor;
        cursor += 1;
        if (index >= batches.length) return;
        const batch = batches[index];
        if (batch === undefined) return;
        try {
          results[index] = await this.#embedBatchWithRetries(
            batch,
            dimensions,
            normalize,
            caps,
          );
        } catch (err) {
          failure = err;
          return;
        }
      }
    };

    const workers = Math.min(this.#concurrency, batches.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (failure !== undefined) throw toError(failure);
    return results;
  }

  /** Embed one batch, retrying retryable failures with backoff. */
  async #embedBatchWithRetries(
    batch: EmbeddingBatch,
    dimensions: number,
    normalize: boolean,
    caps: EmbeddingCapabilities,
  ): Promise<BatchResult> {
    const providerName = this.#provider.info.name;
    for (let attempt = 0; ; attempt += 1) {
      if (batch.signal?.aborted === true)
        throw new EmbeddingCancelledError(providerName);
      try {
        const response = await this.#provider.embed(batch);
        assertBatch(providerName, dimensions, response.embeddings, batch.texts.length);

        const alreadyUnit = caps.normalizesByDefault || response.normalized === true;
        const embeddings =
          normalize && !alreadyUnit
            ? response.embeddings.map(l2normalize)
            : response.embeddings;
        return { offset: batch.offset, embeddings, usage: response.usage };
      } catch (err) {
        if (!isRetryable(err) || attempt >= this.#retries) throw err;
        const waitMs =
          err instanceof RateLimitedError && err.retryAfterMs !== undefined
            ? err.retryAfterMs
            : this.#retryBaseMs * 2 ** attempt;
        this.#logger.debug('retrying batch after a retryable failure', {
          attempt: attempt + 1,
          waitMs,
        });
        await this.#sleep(waitMs, batch.signal);
      }
    }
  }

  #assemble(
    request: EmbeddingRequest,
    model: string,
    dimensions: number,
    normalize: boolean,
    caps: EmbeddingCapabilities,
    results: readonly BatchResult[],
  ): EmbeddingResponse {
    const embeddings: Embedding[] = new Array<Embedding>(request.texts.length);
    let promptTokens = 0;
    let totalTokens = 0;
    let sawUsage = false;

    for (const result of results) {
      for (let i = 0; i < result.embeddings.length; i += 1) {
        const vector = result.embeddings[i];
        if (vector !== undefined) embeddings[result.offset + i] = vector;
      }
      if (result.usage !== undefined) {
        sawUsage = true;
        promptTokens += result.usage.promptTokens ?? 0;
        totalTokens += result.usage.totalTokens ?? result.usage.promptTokens ?? 0;
      }
    }

    const usage: EmbeddingUsage | undefined = sawUsage
      ? { promptTokens, totalTokens }
      : undefined;
    const cost =
      caps.costPer1kTokens !== undefined && usage?.totalTokens !== undefined
        ? {
            usd: (caps.costPer1kTokens * usage.totalTokens) / 1000,
            per1kTokens: caps.costPer1kTokens,
          }
        : undefined;

    return {
      model,
      dimensions,
      embeddings,
      usage,
      cost,
      normalized: normalize || caps.normalizesByDefault,
      metadata: request.metadata,
      batches: results.length,
    };
  }
}
