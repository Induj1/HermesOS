/**
 * The OpenAI HTTP client — one POST, and the mapping from HTTP status to a
 * `@hermes/model` `ModelError`.
 *
 * Both the chat and the embeddings models POST JSON to an OpenAI-shaped endpoint
 * and read JSON back, over an injected `@hermes/tools-http` `HttpClient` — so they
 * inherit its timeout, size cap, and (through `guarded`) SSRF policy, and share
 * one place that turns a `401`/`429`/`400`/`5xx` into the *classified*, retryable-
 * or-not error the model router branches on. Keeping that mapping here, not in
 * each model, is why a rate limit and an invalid request are told apart the same
 * way for chat and for embeddings.
 *
 * This is deliberately compatible with any OpenAI-shaped API — Azure OpenAI,
 * Ollama's `/v1` endpoint, vLLM, together.ai — because they all speak this wire
 * format; the base URL and key are the only difference.
 */

import type { HttpClient } from '@hermes/tools-http';
import { HttpError } from '@hermes/tools-http';
import {
  AuthenticationFailedError,
  ContextTooLongError,
  InvalidRequestError,
  ModelError,
  ModelTimeoutError,
  ModelUnavailableError,
  RateLimitedError,
} from '@hermes/model';

export interface OpenAIClientOptions {
  readonly http: HttpClient;
  /** API key. Sent as `Authorization: Bearer …`. Optional for keyless local servers. */
  readonly apiKey?: string;
  /** API base. Default `https://api.openai.com/v1`. Point it at Azure/Ollama/etc. */
  readonly baseUrl?: string;
  /** Provider name used in errors and `ModelInfo`. Default `openai`. */
  readonly provider?: string;
  readonly userAgent?: string;
  /** Extra headers (e.g. an Azure `api-key`, an org id). */
  readonly headers?: Readonly<Record<string, string>>;
}

export class OpenAIClient {
  readonly provider: string;
  readonly #http: HttpClient;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(options: OpenAIClientOptions) {
    this.#http = options.http;
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    );
    this.provider = options.provider ?? 'openai';
    this.#userAgent = options.userAgent ?? 'hermes';
    this.#headers = options.headers ?? {};
  }

  /** POST a JSON body to a path and return the parsed JSON, or throw a ModelError. */
  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': this.#userAgent,
      ...this.#headers,
    };
    if (this.#apiKey !== undefined) headers['authorization'] = `Bearer ${this.#apiKey}`;

    let response;
    try {
      response = await this.#http.request({
        url: `${this.#baseUrl}${path.startsWith('/') ? path : `/${path}`}`,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      throw this.#fromTransport(err);
    }

    if (response.status < 200 || response.status >= 300) {
      throw this.#fromStatus(
        response.status,
        response.headers,
        safeJson(response.body),
      );
    }
    return safeJson(response.body) as T;
  }

  #fromTransport(err: unknown): ModelError {
    if (err instanceof HttpError) {
      if (err.code === 'TIMEOUT')
        return new ModelTimeoutError(this.provider, 'unknown', 0, { cause: err });
      return new ModelUnavailableError(this.provider, 'unknown', { cause: err });
    }
    throw err;
  }

  #fromStatus(
    status: number,
    headers: Readonly<Record<string, string>>,
    body: unknown,
  ): ModelError {
    const message = messageOf(body);
    const code = codeOf(body);
    if (status === 401 || status === 403)
      return new AuthenticationFailedError(this.provider, message);
    if (status === 429)
      return new RateLimitedError(this.provider, retryAfterMs(headers));
    if (status === 404)
      return new ModelUnavailableError(this.provider, message ?? 'unknown');
    if (status === 400 || status === 422) {
      if (code === 'context_length_exceeded')
        return new ContextTooLongError(this.provider);
      return new InvalidRequestError(this.provider, message ?? 'bad request');
    }
    if (status >= 500)
      return new ModelUnavailableError(
        this.provider,
        message ?? `server error ${String(status)}`,
      );
    return new ModelError(
      'MODEL_ERROR',
      this.provider,
      message ?? `unexpected status ${String(status)}`,
    );
  }
}

function retryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const value = headers['retry-after'];
  return value !== undefined && /^\d+$/.test(value.trim())
    ? Number(value.trim()) * 1000
    : undefined;
}

function errorObject(body: unknown): Record<string, unknown> | undefined {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error: unknown = body.error;
    if (typeof error === 'object' && error !== null)
      return error as Record<string, unknown>;
  }
  return undefined;
}

function messageOf(body: unknown): string | undefined {
  const message = errorObject(body)?.['message'];
  return typeof message === 'string' ? message : undefined;
}

function codeOf(body: unknown): string | undefined {
  const code = errorObject(body)?.['code'];
  return typeof code === 'string' ? code : undefined;
}

export function safeJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
