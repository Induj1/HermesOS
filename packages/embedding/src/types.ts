/**
 * The embedding platform's vocabulary — what a request is, what a response is,
 * and what a provider can do.
 *
 * These types are provider-independent by construction: nothing here names
 * OpenAI, Ollama, or a wire format. A provider *declares* its shape through
 * {@link EmbeddingCapabilities} and answers {@link EmbeddingRequest}s with
 * {@link EmbeddingResponse}s, and every future backend fits the same three
 * shapes. The one hard rule the platform enforces on top of them —
 * order-preservation — is why {@link EmbeddingBatch} carries an `offset`.
 */

/** A dense vector. Always `dimensions` long. */
export type Embedding = readonly number[];

/**
 * A model a provider serves, with its identity and capabilities.
 *
 * `name` is the vector-space identity — memory stores it in a primary key, so two
 * models producing incomparable vectors must never share a name. This mirrors
 * `@hermes/model`'s `EmbeddingModel`, deliberately, so the two interoperate
 * (see `compat.ts`).
 */
export interface EmbeddingModel {
  readonly name: string;
  /** Who serves it: `openai`, `ollama`, `voyage`, `fake`, … */
  readonly provider: string;
  /** The default vector width. A provider that supports variable dimensions still has a default. */
  readonly dimensions: number;
  readonly capabilities: EmbeddingCapabilities;
}

/**
 * What a model can do — declared, not inferred.
 *
 * The platform reads this to size batches, decide whether to normalize itself,
 * validate dimensions, and price usage. A caller reads it to discover a provider's
 * limits before sending a 10,000-item batch that would be rejected.
 */
export interface EmbeddingCapabilities {
  /** The most texts the provider accepts in one call. The service never exceeds it. */
  readonly maxBatchSize: number;
  /** Advisory per-text token ceiling, where the provider states one. */
  readonly maxInputTokens?: number;
  /** Whether the `dimensions` request field is honoured (Matryoshka-style truncation). */
  readonly configurableDimensions: boolean;
  /** The discrete dimensions offered, when the provider only allows a fixed set. */
  readonly supportedDimensions?: readonly number[];
  /** Whether returned vectors are already unit-length; lets the service skip normalizing. */
  readonly normalizesByDefault: boolean;
  /** USD per 1,000 tokens, for cost metadata. Absent when the provider is free or unpriced. */
  readonly costPer1kTokens?: number;
}

/** Identity of a provider (which may serve several models). */
export interface ProviderInfo {
  readonly name: string;
}

/**
 * A request to embed one or more texts.
 *
 * Everything but `texts` is optional. `model` selects among a provider's models
 * (the service resolves a default when absent); `dimensions` requests a width
 * (only where the provider supports it); `normalize` asks for unit vectors (the
 * service will normalize itself if the provider does not); `metadata` rides
 * through to the response untouched, for a caller's own bookkeeping.
 */
export interface EmbeddingRequest {
  readonly texts: readonly string[];
  readonly model?: string;
  readonly dimensions?: number;
  readonly normalize?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /** Per-call timeout in ms, propagated to the provider. */
  readonly timeoutMs?: number;
}

/**
 * A single provider call's worth of a request — one batch, already sized to the
 * provider's `maxBatchSize` by the service, with `model` and `dimensions`
 * resolved. This is what a provider actually implements against.
 */
export interface EmbeddingBatch {
  readonly texts: readonly string[];
  readonly model: string;
  readonly dimensions: number;
  readonly normalize: boolean;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  /**
   * Where this batch's texts began in the original request. The service uses it
   * to reassemble results in input order regardless of which batch finished first.
   */
  readonly offset: number;
}

/** What a provider (or the service) reports about token consumption. */
export interface EmbeddingUsage {
  /** Tokens across all input texts, where the provider reports them. */
  readonly promptTokens?: number;
  /** Total billable tokens. Usually equals `promptTokens` for embeddings. */
  readonly totalTokens?: number;
}

/** Computed cost, present only when the model declares a price. */
export interface EmbeddingCost {
  readonly usd: number;
  readonly per1kTokens: number;
}

/**
 * A provider's answer to one {@link EmbeddingBatch}: one vector per input text,
 * in the same order. `usage` is present when the provider reports it.
 */
export interface EmbeddingBatchResponse {
  readonly model: string;
  readonly dimensions: number;
  readonly embeddings: readonly Embedding[];
  readonly usage?: EmbeddingUsage;
  /** Whether the provider's own vectors are already unit-length. */
  readonly normalized?: boolean;
}

/**
 * The platform's answer to an {@link EmbeddingRequest}: vectors aligned to the
 * input texts, plus aggregated usage, computed cost, and the metadata echoed
 * back.
 */
export interface EmbeddingResponse {
  readonly model: string;
  readonly dimensions: number;
  /** One vector per input text, in input order. */
  readonly embeddings: readonly Embedding[];
  readonly usage: EmbeddingUsage | undefined;
  readonly cost: EmbeddingCost | undefined;
  /** Whether the returned vectors are unit-length (provider-native or service-applied). */
  readonly normalized: boolean;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  /** How many provider calls served this request. Observability for batching. */
  readonly batches: number;
}
