/**
 * The GitHub REST client.
 *
 * It owns everything between "a caller wants `GET /repos/x/y`" and "here is the
 * parsed repository", and the parts that are easy to get wrong are the ones worth
 * naming: **authentication** (delegated to a {@link GitHubAuth} so a token can
 * refresh mid-session), **retries** (transient 5xx and network blips, with
 * backoff), **rate limiting** (GitHub's two throttles, surfaced as a concrete
 * retry-at instant), and **pagination** (following `Link` headers so a caller
 * iterates items, not pages).
 *
 * Transport is injected as an {@link HttpClient} from `@hermes/tools-http`, so the
 * client reuses that package's timeout, size cap, and — when wired through
 * `guarded` — its SSRF policy, and so the whole thing is testable against a fake
 * that never touches the network.
 */

import type { HttpClient, HttpResponse } from '@hermes/tools-http';
import { HttpError } from '@hermes/tools-http';
import { type GitHubAuth, unauthenticated } from './auth.js';
import {
  classifyStatus,
  GitHubError,
  messageFromBody,
  RateLimitError,
} from './errors.js';

export interface GitHubClientOptions {
  /** The transport. Wrap it in `guarded` if the base URL is ever caller-controlled. */
  readonly http: HttpClient;
  /** How requests are authorized. Defaults to unauthenticated (public, tightly limited). */
  readonly auth?: GitHubAuth;
  /** API base. Default `https://api.github.com`; set it for GitHub Enterprise. */
  readonly baseUrl?: string;
  /** Sent as `User-Agent`, which GitHub requires. Default `hermes`. */
  readonly userAgent?: string;
  /** Pinned `X-GitHub-Api-Version`. Default `2022-11-28`. */
  readonly apiVersion?: string;
  /** Retries for transient failures (5xx, network). Default 3. */
  readonly maxRetries?: number;
  /**
   * What to do when rate-limited. `throw` (default) surfaces a {@link RateLimitError}
   * immediately so the caller decides; `wait` sleeps until the reset — bounded by
   * {@link maxRateLimitWaitMs} — and retries.
   */
  readonly onRateLimit?: 'throw' | 'wait';
  /** Cap on a single rate-limit wait when `onRateLimit: 'wait'`. Default 60s. */
  readonly maxRateLimitWaitMs?: number;
  /** Clock, injectable for tests. Default `Date.now`. */
  readonly now?: () => number;
  /** Delay primitive, injectable for tests. Default a real cancellable timer. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RequestOptions {
  /** Query parameters. Arrays repeat the key; undefined values are dropped. */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** JSON request body. Serialized and sent with `Content-Type: application/json`. */
  readonly body?: unknown;
  /** Extra headers, merged over the defaults. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface PaginateOptions extends RequestOptions {
  /**
   * For endpoints that wrap their items in an object (`{ total_count, items }`,
   * `{ total_count, workflow_runs }`), the key the array lives under. Defaults to
   * `items`. Ignored when the endpoint returns a bare array.
   */
  readonly itemsKey?: string;
}

export interface GitHubResponse<T> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: T;
}

export class GitHubClient {
  readonly #http: HttpClient;
  readonly #auth: GitHubAuth;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #apiVersion: string;
  readonly #maxRetries: number;
  readonly #onRateLimit: 'throw' | 'wait';
  readonly #maxRateLimitWaitMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: GitHubClientOptions) {
    this.#http = options.http;
    this.#auth = options.auth ?? unauthenticated();
    this.#baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.#userAgent = options.userAgent ?? 'hermes';
    this.#apiVersion = options.apiVersion ?? '2022-11-28';
    this.#maxRetries = options.maxRetries ?? 3;
    this.#onRateLimit = options.onRateLimit ?? 'throw';
    this.#maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 60_000;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Make one logical request — retrying transient failures and, if configured,
   * waiting out a rate limit — and return the parsed body.
   *
   * A non-2xx that is not retryable becomes a {@link GitHubError} (or
   * {@link RateLimitError}); the raw GitHub error body is attached for debugging.
   */
  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<GitHubResponse<T>> {
    const response = await this.#raw(method, this.#url(path, options.query), options);
    return {
      status: response.status,
      headers: response.headers,
      data: parseBody(response) as T,
    };
  }

  /**
   * Iterate every item across every page of a list endpoint.
   *
   * Follows the `Link: rel="next"` header GitHub returns, so a caller writes
   * `for await (const issue of client.paginate(...))` and never sees a page
   * boundary. `per_page` defaults to 100 — the max — to minimise round-trips.
   */
  async *paginate<T>(
    path: string,
    options: PaginateOptions = {},
  ): AsyncGenerator<T, void, unknown> {
    let url = this.#url(path, { per_page: 100, ...options.query });
    const itemsKey = options.itemsKey ?? 'items';

    for (;;) {
      const response = await this.#raw('GET', url, options);
      const items = parseBody(response);
      if (Array.isArray(items)) {
        yield* items as T[];
      } else {
        // Some list endpoints wrap items in `{ total_count, items: [...] }`
        // (search) or a bespoke key (`workflow_runs`). Yield the inner array.
        const inner = extractItems(items, itemsKey);
        if (inner !== undefined) yield* inner as T[];
      }

      const next = parseNextLink(response.headers['link']);
      if (next === undefined) return;
      url = next;
    }
  }

  /** Collect a paginated endpoint into an array. Convenient when the set is small. */
  async list<T>(path: string, options: PaginateOptions = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this.paginate<T>(path, options)) out.push(item);
    return out;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  #url(path: string, query?: RequestOptions['query']): string {
    const base = path.startsWith('http')
      ? path
      : this.#baseUrl + (path.startsWith('/') ? path : `/${path}`);
    if (query === undefined) return base;
    const url = new URL(base);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * The single request loop both `request` and `paginate` run through: send,
   * and on a non-2xx decide whether to wait out a rate limit, back off and retry
   * a transient failure, or throw. Returns the raw 2xx response for the caller to
   * parse (as a body, or for its `Link` header).
   */
  async #raw(
    method: string,
    url: string,
    options: RequestOptions,
  ): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.#send(method, url, options);
      if (response.status >= 200 && response.status < 300) return response;

      const rateLimit = detectRateLimit(response, this.#now());
      if (rateLimit !== undefined) {
        const waitMs = rateLimit.retryAt - this.#now();
        if (
          this.#onRateLimit === 'wait' &&
          waitMs <= this.#maxRateLimitWaitMs &&
          attempt < this.#maxRetries
        ) {
          await this.#sleep(Math.max(0, waitMs), options.signal);
          continue;
        }
        throw new RateLimitError(rateLimit.message, rateLimit.retryAt, {
          status: response.status,
          response: parseBody(response),
        });
      }

      if (isRetryableStatus(response.status) && attempt < this.#maxRetries) {
        await this.#sleep(backoffMs(attempt), options.signal);
        continue;
      }

      const body = parseBody(response);
      throw new GitHubError(
        classifyStatus(response.status),
        messageFromBody(body, `GitHub request failed (${String(response.status)})`),
        {
          status: response.status,
          response: body,
        },
      );
    }
  }

  async #send(
    method: string,
    url: string,
    options: RequestOptions,
  ): Promise<HttpResponse> {
    const auth = await this.#auth.headers(options.signal);
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': this.#apiVersion,
      'user-agent': this.#userAgent,
      ...options.headers,
    };
    if (auth.authorization !== undefined) headers['authorization'] = auth.authorization;

    const hasBody = options.body !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';

    try {
      return await this.#http.request({
        url,
        method: method.toUpperCase(),
        headers,
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (err) {
      // A transport failure (timeout, connection reset) is retryable up a level;
      // re-throw as a GitHubError so the caller sees one error type. The retry
      // loop that called us decides whether to try again.
      if (err instanceof HttpError) {
        throw new GitHubError('REQUEST_FAILED', `transport failure: ${err.message}`, {
          cause: err,
        });
      }
      throw err;
    }
  }
}

// ── free functions (pure, unit-tested directly) ───────────────────────────────

function isRetryableStatus(status: number): boolean {
  // 5xx except 501 (not implemented — retrying will not help), plus 502/503/504.
  return status >= 500 && status !== 501;
}

function backoffMs(attempt: number): number {
  // 200ms, 400ms, 800ms, … — plain exponential. No jitter, because the delay is
  // injectable and tests need it deterministic; a real deployment can supply a
  // jittered `sleep`.
  return 200 * 2 ** attempt;
}

interface RateLimit {
  readonly retryAt: number;
  readonly message: string;
}

/**
 * Detect a rate-limit response and when it clears.
 *
 * GitHub has two throttles. The primary limit answers 403 (or 429) with
 * `x-ratelimit-remaining: 0` and a `x-ratelimit-reset` epoch-seconds timestamp.
 * The secondary (abuse) limit answers 403/429 with a `retry-after` in seconds.
 * Both are surfaced as an absolute `retryAt` in epoch ms.
 */
export function detectRateLimit(
  response: HttpResponse,
  nowMs: number,
): RateLimit | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;

  const retryAfter = response.headers['retry-after'];
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter.trim())) {
    return {
      retryAt: nowMs + Number(retryAfter.trim()) * 1000,
      message: 'secondary rate limit; retry after cooldown',
    };
  }

  const remaining = response.headers['x-ratelimit-remaining'];
  const reset = response.headers['x-ratelimit-reset'];
  if (remaining === '0' && reset !== undefined && /^\d+$/.test(reset.trim())) {
    return {
      retryAt: Number(reset.trim()) * 1000,
      message: 'primary rate limit exhausted',
    };
  }

  return undefined;
}

/** Parse the URL of the `rel="next"` entry from a GitHub `Link` header. */
export function parseNextLink(link: string | undefined): string | undefined {
  if (link === undefined) return undefined;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function parseBody(response: HttpResponse): unknown {
  const type = response.headers['content-type'] ?? '';
  if (response.body === '' || !type.includes('json')) return response.body;
  try {
    return JSON.parse(response.body);
  } catch {
    // A body that claims JSON but is not is returned raw rather than throwing —
    // the status has already told the caller whether the call succeeded.
    return response.body;
  }
}

function extractItems(body: unknown, key: string): unknown[] | undefined {
  if (typeof body === 'object' && body !== null && key in body) {
    const items = (body as Record<string, unknown>)[key];
    if (Array.isArray(items)) return items as unknown[];
  }
  return undefined;
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('aborted');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
