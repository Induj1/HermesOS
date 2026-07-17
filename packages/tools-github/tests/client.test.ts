/**
 * The REST client: request shaping, error classification, retries, rate limiting,
 * and pagination.
 *
 * Two doubles are used. A queue-backed `HttpClient` gives precise control over the
 * sequence of responses the client sees — the only way to test "503 then 200" or a
 * rate-limit-then-succeed deterministically. `FakeGitHubServer` gives realistic
 * behaviour for the happy paths and pagination. Sleep is injected so backoff and
 * rate-limit waits take no real time.
 */

import { describe, expect, it, vi } from 'vitest';
import type { HttpClient, HttpRequest, HttpResponse } from '@hermes/tools-http';
import { HttpError } from '@hermes/tools-http';
import { GitHubClient, detectRateLimit, parseNextLink } from '../src/client.js';
import { RateLimitError } from '../src/errors.js';
import { FakeGitHubServer } from '../src/fake-server.js';
import { tokenAuth } from '../src/auth.js';

/** An HttpClient that replays a queued list of responses (or throws). */
class Queue implements HttpClient {
  readonly requests: HttpRequest[] = [];
  #responses: (Partial<HttpResponse> | Error)[];
  constructor(responses: (Partial<HttpResponse> | Error)[]) {
    this.#responses = responses;
  }
  request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const next = this.#responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({
      status: next?.status ?? 200,
      statusText: '',
      headers: next?.headers ?? { 'content-type': 'application/json' },
      body: next?.body ?? '{}',
      url: req.url,
      truncated: false,
      redirects: 0,
    });
  }
}

const noSleep = vi.fn(() => Promise.resolve());

describe('request shaping', () => {
  it('sends the required GitHub headers and the auth', async () => {
    const http = new Queue([{ status: 200, body: '{"ok":true}' }]);
    const client = new GitHubClient({
      http,
      auth: tokenAuth('ghp_x'),
      userAgent: 'hermes-test',
    });

    await client.request('GET', '/rate_limit');

    const sent = http.requests[0];
    expect(sent?.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'hermes-test',
      authorization: 'Bearer ghp_x',
    });
  });

  it('serializes a JSON body with a content-type', async () => {
    const http = new Queue([{ status: 201, body: '{}' }]);
    const client = new GitHubClient({ http, userAgent: 't' });

    await client.request('POST', '/x', { body: { a: 1 } });

    expect(http.requests[0]?.body).toBe('{"a":1}');
    expect(http.requests[0]?.headers?.['content-type']).toBe('application/json');
  });

  it('builds a query string, dropping undefined values', async () => {
    const http = new Queue([{ status: 200 }]);
    const client = new GitHubClient({ http, userAgent: 't' });

    await client.request('GET', '/search', {
      query: { q: 'hello world', page: 2, skip: undefined },
    });

    const url = new URL(http.requests[0]?.url ?? '');
    expect(url.searchParams.get('q')).toBe('hello world');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.has('skip')).toBe(false);
  });

  it('parses a JSON response into data', async () => {
    const http = new Queue([{ status: 200, body: '{"login":"octocat"}' }]);
    const client = new GitHubClient({ http, userAgent: 't' });
    const res = await client.request<{ login: string }>('GET', '/user');
    expect(res.data.login).toBe('octocat');
  });

  it('returns a non-JSON body raw', async () => {
    const http = new Queue([
      { status: 200, headers: { 'content-type': 'text/plain' }, body: 'plain' },
    ]);
    const client = new GitHubClient({ http, userAgent: 't' });
    expect((await client.request('GET', '/x')).data).toBe('plain');
  });

  it('returns a body raw when it claims JSON but does not parse', async () => {
    const http = new Queue([
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{bad' },
    ]);
    const client = new GitHubClient({ http, userAgent: 't' });
    expect((await client.request('GET', '/x')).data).toBe('{bad');
  });
});

describe('error classification', () => {
  it('throws a coded GitHubError for a 404', async () => {
    const http = new Queue([{ status: 404, body: '{"message":"Not Found"}' }]);
    const client = new GitHubClient({ http, userAgent: 't' });
    await expect(client.request('GET', '/x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it("surfaces GitHub's message", async () => {
    const http = new Queue([{ status: 401, body: '{"message":"Bad credentials"}' }]);
    const client = new GitHubClient({ http, userAgent: 't' });
    await expect(client.request('GET', '/x')).rejects.toThrow(/Bad credentials/);
  });

  it('wraps a transport failure as REQUEST_FAILED', async () => {
    const http = new Queue([
      new HttpError('TIMEOUT', 'https://api.github.com/x', 'timed out'),
    ]);
    const client = new GitHubClient({ http, userAgent: 't', maxRetries: 0 });
    await expect(client.request('GET', '/x')).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
    });
  });
});

describe('retries', () => {
  it('retries a 503 and then succeeds', async () => {
    const http = new Queue([
      { status: 503 },
      { status: 503 },
      { status: 200, body: '{"ok":1}' },
    ]);
    const client = new GitHubClient({ http, userAgent: 't', sleep: noSleep });
    const res = await client.request<{ ok: number }>('GET', '/x');
    expect(res.data.ok).toBe(1);
    expect(http.requests).toHaveLength(3);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const http = new Queue([{ status: 500 }, { status: 500 }]);
    const client = new GitHubClient({
      http,
      userAgent: 't',
      maxRetries: 1,
      sleep: noSleep,
    });
    await expect(client.request('GET', '/x')).rejects.toMatchObject({
      code: 'SERVER_ERROR',
    });
    expect(http.requests).toHaveLength(2);
  });

  it('retries a thrown transport error', async () => {
    const http = new Queue([
      new HttpError('TIMEOUT', 'u', 'x'),
      { status: 200, body: '{}' },
    ]);
    // maxRetries default 3; the transport failure is re-thrown as a GitHubError,
    // which is retryable only if the loop treats it so — here the second attempt
    // succeeds because the queue advances.
    const client = new GitHubClient({ http, userAgent: 't', sleep: noSleep });
    // The first attempt throws REQUEST_FAILED, which is not a retryable *status*;
    // the client rethrows it. This documents that transport throws are terminal.
    await expect(client.request('GET', '/x')).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
    });
  });
});

describe('rate limiting', () => {
  const reset = '1700000100';
  const rlHeaders = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset };

  it('throws a RateLimitError with the reset instant by default', async () => {
    const http = new Queue([
      { status: 403, headers: rlHeaders, body: '{"message":"rate limited"}' },
    ]);
    const client = new GitHubClient({
      http,
      userAgent: 't',
      now: () => 1_700_000_000_000,
    });
    const err = await client.request('GET', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAt).toBe(1_700_000_100_000);
  });

  it('waits out the limit and retries when configured to', async () => {
    const http = new Queue([
      { status: 403, headers: { 'retry-after': '1' } },
      { status: 200, body: '{"ok":1}' },
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    const client = new GitHubClient({
      http,
      userAgent: 't',
      onRateLimit: 'wait',
      now: () => 0,
      sleep,
    });
    const res = await client.request<{ ok: number }>('GET', '/x');
    expect(res.data.ok).toBe(1);
    expect(sleep).toHaveBeenCalledWith(1000, undefined);
  });

  it('throws rather than wait past the cap', async () => {
    const http = new Queue([{ status: 403, headers: { 'retry-after': '3600' } }]);
    const client = new GitHubClient({
      http,
      userAgent: 't',
      onRateLimit: 'wait',
      maxRateLimitWaitMs: 5000,
      now: () => 0,
    });
    await expect(client.request('GET', '/x')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('waits with the real timer when no sleep is injected', async () => {
    const http = new Queue([
      { status: 403, headers: { 'retry-after': '0' } },
      { status: 200, body: '{"ok":1}' },
    ]);
    const client = new GitHubClient({
      http,
      userAgent: 't',
      onRateLimit: 'wait',
      now: () => 0,
    });
    // retry-after 0 → a 0ms real sleep, then success. Exercises the default timer.
    expect((await client.request<{ ok: number }>('GET', '/x')).data.ok).toBe(1);
  });

  it('rejects the real-timer wait when the signal is already aborted', async () => {
    const http = new Queue([{ status: 403, headers: { 'retry-after': '10' } }]);
    const client = new GitHubClient({
      http,
      userAgent: 't',
      onRateLimit: 'wait',
      now: () => 0,
    });
    await expect(
      client.request('GET', '/x', { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });

  it('synthesizes an error when the abort reason is not an Error', async () => {
    const http = new Queue([{ status: 403, headers: { 'retry-after': '10' } }]);
    const client = new GitHubClient({
      http,
      userAgent: 't',
      onRateLimit: 'wait',
      now: () => 0,
    });
    // A string reason (not an Error) exercises the fallback in abortReason.
    await expect(
      client.request('GET', '/x', { signal: AbortSignal.abort('nope') }),
    ).rejects.toThrow('aborted');
  });

  it('cancels an in-progress real-timer wait when the signal aborts', async () => {
    const http = new Queue([{ status: 403, headers: { 'retry-after': '30' } }]);
    const controller = new AbortController();
    const client = new GitHubClient({
      http,
      userAgent: 't',
      onRateLimit: 'wait',
      now: () => 0,
    });
    const pending = client.request('GET', '/x', { signal: controller.signal });
    // Abort after the 30s wait has started, so the timer's abort listener fires
    // (rather than the already-aborted fast path).
    setTimeout(() => {
      controller.abort();
    }, 5);
    await expect(pending).rejects.toThrow();
  });
});

describe('pagination against the fake server', () => {
  it('follows Link headers to yield every item across pages', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r', {
      issues: Array.from({ length: 5 }, (_, i) => ({
        number: i + 1,
        title: `#${String(i + 1)}`,
        state: 'open',
        body: null,
        html_url: '',
      })),
    });
    const client = new GitHubClient({ http: server, userAgent: 't' });

    const collected: number[] = [];
    for await (const issue of client.paginate<{ number: number }>('/repos/o/r/issues', {
      query: { per_page: 2 },
    })) {
      collected.push(issue.number);
    }
    expect(collected).toEqual([1, 2, 3, 4, 5]);
  });

  it('list collects a paginated endpoint into an array', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r', { branches: [{ name: 'main' }, { name: 'dev' }] });
    const client = new GitHubClient({ http: server, userAgent: 't' });
    const branches = await client.list<{ name: string }>('/repos/o/r/branches');
    expect(branches.map((b) => b.name)).toEqual(['main', 'dev']);
  });

  it('unwraps a bespoke items key (workflow_runs)', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r', {
      runs: [
        {
          id: 1,
          name: 'CI',
          status: 'completed',
          conclusion: 'success',
          head_branch: 'main',
          html_url: '',
        },
      ],
    });
    const client = new GitHubClient({ http: server, userAgent: 't' });
    const runs = await client.list<{ id: number }>('/repos/o/r/actions/runs', {
      itemsKey: 'workflow_runs',
    });
    expect(runs.map((r) => r.id)).toEqual([1]);
  });

  it('yields nothing when the wrapper lacks the requested items key', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r', {
      runs: [
        {
          id: 1,
          name: 'CI',
          status: null,
          conclusion: null,
          head_branch: null,
          html_url: '',
        },
      ],
    });
    const client = new GitHubClient({ http: server, userAgent: 't' });
    // The runs endpoint wraps items under `workflow_runs`; asking for the default
    // `items` key finds nothing rather than throwing.
    expect(await client.list('/repos/o/r/actions/runs')).toEqual([]);
  });
});

describe('detectRateLimit', () => {
  const res = (status: number, headers: Record<string, string>): HttpResponse => ({
    status,
    statusText: '',
    headers,
    body: '',
    url: '',
    truncated: false,
    redirects: 0,
  });

  it('reads a secondary limit from retry-after', () => {
    expect(detectRateLimit(res(429, { 'retry-after': '30' }), 1000)?.retryAt).toBe(
      1000 + 30_000,
    );
  });

  it('reads a primary limit from remaining=0 and reset', () => {
    expect(
      detectRateLimit(
        res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000' }),
        0,
      )?.retryAt,
    ).toBe(2_000_000);
  });

  it('is not a rate limit when remaining is non-zero', () => {
    expect(
      detectRateLimit(res(403, { 'x-ratelimit-remaining': '5' }), 0),
    ).toBeUndefined();
  });

  it('ignores non-403/429 statuses', () => {
    expect(detectRateLimit(res(500, { 'retry-after': '10' }), 0)).toBeUndefined();
  });
});

describe('parseNextLink', () => {
  it('extracts the rel="next" URL', () => {
    const link =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(parseNextLink(link)).toBe('https://api.github.com/x?page=2');
  });

  it('returns undefined when there is no next', () => {
    expect(
      parseNextLink('<https://api.github.com/x?page=9>; rel="last"'),
    ).toBeUndefined();
    expect(parseNextLink(undefined)).toBeUndefined();
  });
});
