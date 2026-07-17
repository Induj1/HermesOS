/**
 * The Anthropic HTTP client — one POST to `/v1/messages`, and status → `ModelError`.
 *
 * Same shape and responsibilities as the OpenAI client, over the same injected
 * `@hermes/tools-http` transport, but for Anthropic's headers (`x-api-key`,
 * `anthropic-version`) and its error envelope. The classification is what the
 * router's fallback reads, so it must tell a rate limit (retry elsewhere) from an
 * invalid request (wrong everywhere) the same way every provider does.
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

/** The Anthropic Messages API version pinned in the header. */
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicClientOptions {
  readonly http: HttpClient;
  readonly apiKey?: string;
  /** API base. Default `https://api.anthropic.com/v1`. */
  readonly baseUrl?: string;
  readonly provider?: string;
  readonly userAgent?: string;
  /** Pinned API version. Default `2023-06-01`. */
  readonly version?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class AnthropicClient {
  readonly provider: string;
  readonly #http: HttpClient;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #version: string;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(options: AnthropicClientOptions) {
    this.#http = options.http;
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(
      /\/+$/,
      '',
    );
    this.provider = options.provider ?? 'anthropic';
    this.#userAgent = options.userAgent ?? 'hermes';
    this.#version = options.version ?? ANTHROPIC_VERSION;
    this.#headers = options.headers ?? {};
  }

  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': this.#userAgent,
      'anthropic-version': this.#version,
      ...this.#headers,
    };
    if (this.#apiKey !== undefined) headers['x-api-key'] = this.#apiKey;

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
    if (status === 401 || status === 403)
      return new AuthenticationFailedError(this.provider, message);
    if (status === 429)
      return new RateLimitedError(this.provider, retryAfterMs(headers));
    if (status === 404)
      return new ModelUnavailableError(this.provider, message ?? 'unknown');
    // 529 is Anthropic's "overloaded" — a capacity signal, retryable elsewhere.
    if (status === 529 || status >= 500)
      return new ModelUnavailableError(
        this.provider,
        message ?? `server error ${String(status)}`,
      );
    if (status === 400 || status === 422) {
      if (
        message !== undefined &&
        /prompt is too long|maximum.*tokens|context/i.test(message)
      ) {
        return new ContextTooLongError(this.provider);
      }
      return new InvalidRequestError(this.provider, message ?? 'bad request');
    }
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

function messageOf(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error: unknown = body.error;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message: unknown = error.message;
      if (typeof message === 'string') return message;
    }
  }
  return undefined;
}

export function safeJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
