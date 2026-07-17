/**
 * @hermes/provider-http — the plumbing every model provider shares.
 *
 * A provider (OpenAI, Anthropic, Gemini, …) is two vendor-specific translations
 * plus a lot of identical HTTP work: POST JSON, map a transport failure to a
 * `ModelError`, and classify a non-2xx status into the *retryable-or-not* error
 * the router's fallback reads. That last part is the one that must be uniform —
 * a rate limit and an invalid request have to be told apart the same way for
 * every provider — so it lives here, once, rather than being re-derived (and
 * subtly diverging) in each client.
 *
 * This is composition, not inheritance: a provider client *calls* {@link postJson}
 * with its own headers and a {@link ClassifyFn}, keeping its public shape. The
 * per-vendor differences (auth header, an extra status like Anthropic's 529, how
 * "context too long" is detected) are the {@link statusClassifier} options and the
 * headers the caller passes — nothing here knows a vendor.
 */

import type { HttpClient } from '@hermes/tools-http';
import { HttpError } from '@hermes/tools-http';
import {
  AuthenticationFailedError,
  InvalidRequestError,
  ModelError,
  ModelTimeoutError,
  ModelUnavailableError,
  RateLimitedError,
} from '@hermes/model';

/** Turn a non-2xx response into a classified `ModelError`. */
export type ClassifyFn = (
  status: number,
  headers: Readonly<Record<string, string>>,
  body: unknown,
) => ModelError;

export interface PostJsonParams {
  readonly http: HttpClient;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly provider: string;
  readonly classify: ClassifyFn;
  readonly signal?: AbortSignal;
}

/**
 * POST a JSON body and return the parsed JSON, or throw a `ModelError`.
 *
 * A transport failure (timeout, connection reset, an SSRF block) is mapped to a
 * `ModelError` here — a `TIMEOUT` to a retryable `ModelTimeout`, anything else to
 * a retryable `ModelUnavailable`. A non-`HttpError` throw (a bug) is re-thrown
 * unchanged. A non-2xx status goes to the caller's `classify`.
 */
export async function postJson<T>(params: PostJsonParams): Promise<T> {
  let response;
  try {
    response = await params.http.request({
      url: params.url,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...params.headers },
      body: JSON.stringify(params.body),
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.code === 'TIMEOUT')
        throw new ModelTimeoutError(params.provider, 'unknown', 0, { cause: err });
      throw new ModelUnavailableError(params.provider, 'unknown', { cause: err });
    }
    throw err;
  }

  if (response.status < 200 || response.status >= 300) {
    throw params.classify(response.status, response.headers, safeJson(response.body));
  }
  return safeJson(response.body) as T;
}

export interface StatusClassifierOptions {
  /**
   * A vendor hook that runs *before* the default mapping. Return a `ModelError` to
   * override (e.g. detect "context too long"), or `undefined` to fall through.
   */
  readonly override?: (
    status: number,
    headers: Readonly<Record<string, string>>,
    body: unknown,
    message: string | undefined,
  ) => ModelError | undefined;
}

/**
 * Build a {@link ClassifyFn} with the standard status mapping.
 *
 * `401/403` → auth (not retryable), `429` → rate limit (with `retry-after`),
 * `404` → unavailable (retryable), `5xx` (incl. `529`) → unavailable (retryable),
 * `400/422` → invalid (not retryable), anything else → a generic `MODEL_ERROR`.
 * A vendor passes `override` for the few cases that are theirs (a specific
 * error code, a bespoke status).
 */
export function statusClassifier(
  provider: string,
  options: StatusClassifierOptions = {},
): ClassifyFn {
  return (status, headers, body) => {
    const message = messageOf(body);
    const overridden = options.override?.(status, headers, body, message);
    if (overridden !== undefined) return overridden;

    if (status === 401 || status === 403)
      return new AuthenticationFailedError(provider, message);
    if (status === 429) return new RateLimitedError(provider, retryAfterMs(headers));
    if (status === 404)
      return new ModelUnavailableError(provider, message ?? 'unknown');
    if (status >= 500)
      return new ModelUnavailableError(
        provider,
        message ?? `server error ${String(status)}`,
      );
    if (status === 400 || status === 422)
      return new InvalidRequestError(provider, message ?? 'bad request');
    return new ModelError(
      'MODEL_ERROR',
      provider,
      message ?? `unexpected status ${String(status)}`,
    );
  };
}

/** Parse `retry-after` (whole seconds) into milliseconds. */
export function retryAfterMs(
  headers: Readonly<Record<string, string>>,
): number | undefined {
  const value = headers['retry-after'];
  return value !== undefined && /^\d+$/.test(value.trim())
    ? Number(value.trim()) * 1000
    : undefined;
}

/** The `error` object of a provider error body, if present. */
export function errorObject(body: unknown): Record<string, unknown> | undefined {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error: unknown = body.error;
    if (typeof error === 'object' && error !== null)
      return error as Record<string, unknown>;
  }
  return undefined;
}

/** A human message from a provider error body: `{error:{message}}`, `{error}`, or `{message}`. */
export function messageOf(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null) {
    const error: unknown = 'error' in body ? body.error : undefined;
    if (typeof error === 'string') return error;
    const nested = errorObject(body)?.['message'];
    if (typeof nested === 'string') return nested;
    if ('message' in body) {
      const top: unknown = body.message;
      if (typeof top === 'string') return top;
    }
  }
  return undefined;
}

/** A machine code from a provider error body's `error.code`. */
export function codeOf(body: unknown): string | undefined {
  const code = errorObject(body)?.['code'];
  return typeof code === 'string' ? code : undefined;
}

/** Parse text as JSON; return it raw if it is not JSON, and `undefined` for empty. */
export function safeJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
