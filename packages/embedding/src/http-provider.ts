/**
 * A base class for HTTP-backed providers — the extension point real providers
 * build on.
 *
 * OpenAI, Voyage, Cohere, Gemini, Azure OpenAI, and a self-hosted Ollama or ONNX
 * server are all "POST texts to an endpoint, read vectors back". That shared shape
 * lives here, over an injected `@hermes/tools-http` `HttpClient` — so a provider
 * inherits the HTTP layer's timeout, response-size cap, and (through `guarded`)
 * SSRF policy, and never re-implements request/response plumbing or status-to-error
 * mapping. A concrete provider supplies only the two things that are genuinely
 * vendor-specific: how to shape the request body, and how to read the response.
 *
 * Note what it does *not* do: no batching, no retries, no concurrency. Those are
 * the {@link EmbeddingService}'s, so they are identical for every provider. This
 * class embeds exactly one batch per call.
 */

import type { HttpClient } from '@hermes/tools-http';
import { HttpError } from '@hermes/tools-http';
import {
  AuthenticationFailedError,
  EmbeddingError,
  EmbeddingTimeoutError,
  InvalidRequestError,
  MalformedResponseError,
  RateLimitedError,
} from './errors.js';
import { type EmbeddingProvider, resolveModel } from './provider.js';
import type {
  EmbeddingBatch,
  EmbeddingBatchResponse,
  EmbeddingCapabilities,
  EmbeddingModel,
  ProviderInfo,
} from './types.js';

/** What a concrete provider produces from a batch: where to POST, and what. */
export interface HttpEmbeddingRequest {
  /** Path (joined to the base URL) or an absolute URL. */
  readonly path: string;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpEmbeddingProviderOptions {
  readonly http: HttpClient;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly EmbeddingModel[];
  /** Produce the `Authorization` header value (e.g. `Bearer sk-…`). May be async. */
  readonly authorization?: () => string | undefined | Promise<string | undefined>;
  readonly userAgent?: string;
}

export abstract class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly info: ProviderInfo;
  readonly #http: HttpClient;
  readonly #baseUrl: string;
  readonly #models: readonly EmbeddingModel[];
  readonly #authorization: HttpEmbeddingProviderOptions['authorization'];
  readonly #userAgent: string;

  constructor(options: HttpEmbeddingProviderOptions) {
    this.info = { name: options.name };
    this.#http = options.http;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#models = options.models;
    this.#authorization = options.authorization;
    this.#userAgent = options.userAgent ?? 'hermes';
  }

  models(): readonly EmbeddingModel[] {
    return this.#models;
  }

  capabilities(model?: string): EmbeddingCapabilities {
    return resolveModel(this, model).capabilities;
  }

  /** Shape the request body for a batch. Vendor-specific. */
  protected abstract buildRequest(batch: EmbeddingBatch): HttpEmbeddingRequest;

  /** Read vectors (and usage) out of the parsed response body. Vendor-specific. */
  protected abstract parseResponse(
    body: unknown,
    batch: EmbeddingBatch,
  ): EmbeddingBatchResponse;

  async embed(batch: EmbeddingBatch): Promise<EmbeddingBatchResponse> {
    const { path, body, headers } = this.buildRequest(batch);
    const url = path.startsWith('http')
      ? path
      : `${this.#baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    const authorization = await this.#authorization?.();
    const requestHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': this.#userAgent,
      ...headers,
    };
    if (authorization !== undefined) requestHeaders['authorization'] = authorization;

    let response;
    try {
      response = await this.#http.request({
        url,
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        ...(batch.timeoutMs === undefined ? {} : { timeoutMs: batch.timeoutMs }),
        ...(batch.signal === undefined ? {} : { signal: batch.signal }),
      });
    } catch (err) {
      throw this.#fromTransportError(err);
    }

    if (response.status < 200 || response.status >= 300) {
      throw this.#fromStatus(
        response.status,
        response.headers,
        safeJson(response.body),
      );
    }

    return this.parseResponse(safeJson(response.body), batch);
  }

  #fromTransportError(err: unknown): EmbeddingError {
    if (err instanceof HttpError) {
      if (err.code === 'TIMEOUT')
        return new EmbeddingTimeoutError(this.info.name, 0, { cause: err });
      // A blocked host, a connection failure, an oversized body — retryable at the
      // service level (a transient network fault often clears).
      return new EmbeddingError(
        'PROVIDER_ERROR',
        this.info.name,
        `transport failure: ${err.message}`,
        {
          cause: err,
          retryable: true,
        },
      );
    }
    throw err;
  }

  #fromStatus(
    status: number,
    headers: Readonly<Record<string, string>>,
    body: unknown,
  ): EmbeddingError {
    const message = messageFromBody(body);
    if (status === 401 || status === 403)
      return new AuthenticationFailedError(this.info.name, message);
    if (status === 429)
      return new RateLimitedError(this.info.name, retryAfterMs(headers));
    if (status === 400 || status === 422)
      return new InvalidRequestError(this.info.name, message ?? 'bad request');
    if (status >= 500) {
      return new EmbeddingError(
        'PROVIDER_ERROR',
        this.info.name,
        message ?? `server error (${String(status)})`,
        {
          retryable: true,
        },
      );
    }
    return new EmbeddingError(
      'PROVIDER_ERROR',
      this.info.name,
      message ?? `unexpected status ${String(status)}`,
    );
  }

  /** For a subclass's `parseResponse` to raise a shaped malformed-response error. */
  protected malformed(message: string): never {
    throw new MalformedResponseError(this.info.name, message);
  }
}

function retryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const value = headers['retry-after'];
  if (value !== undefined && /^\d+$/.test(value.trim()))
    return Number(value.trim()) * 1000;
  return undefined;
}

function messageFromBody(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const error = record['error'];
    if (typeof error === 'string') return error;
    if (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as Record<string, unknown>)['message'] === 'string'
    ) {
      return (error as { message: string }).message;
    }
    if (typeof record['message'] === 'string') return record['message'];
  }
  return undefined;
}

function safeJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
