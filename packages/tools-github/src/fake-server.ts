/**
 * A fake GitHub, as an `HttpClient`.
 *
 * This is the counterpart to the other packages' fakes, scaled up to a whole API:
 * an in-memory GitHub that implements the transport port, so the client and the
 * resource facade can be driven end to end — auth headers, pagination, rate
 * limits, 404s, a real create-then-read round-trip — without a token or a network.
 * It is the substrate of the contract tests.
 *
 * It is faithful where fidelity is the point: it enforces the `User-Agent` GitHub
 * requires, paginates with real `Link` headers, wraps Actions runs in their
 * bespoke envelope, and can be told to rate-limit or fail transiently so the
 * client's retry and back-off logic is exercised against realistic responses.
 * What it is *not* is a validator of GitHub's every rule — it models the
 * behaviours the client depends on, and no more.
 */

import type { HttpClient, HttpRequest, HttpResponse } from '@hermes/tools-http';
import { createHmac } from 'node:crypto';

interface RepoState {
  repo: Record<string, unknown>;
  branches: Record<string, unknown>[];
  issues: Record<string, unknown>[];
  pulls: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  releases: Record<string, unknown>[];
}

export interface FakeGitHubOptions {
  /** A secret used by {@link signWebhook}, so a test can produce valid deliveries. */
  readonly webhookSecret?: string;
  /** A canned GraphQL responder, keyed on the query string. */
  readonly graphql?: (
    query: string,
    variables: unknown,
  ) => { data?: unknown; errors?: unknown };
}

/** A queued response that pre-empts routing — for retry and rate-limit tests. */
interface Forced {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export class FakeGitHubServer implements HttpClient {
  /** Every request received, in order, for assertions on argv/auth/body. */
  readonly requests: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | undefined;
  }[] = [];

  readonly #repos = new Map<string, RepoState>();
  readonly #forced: Forced[] = [];
  readonly #options: FakeGitHubOptions;
  #issueSeq = 1000;

  constructor(options: FakeGitHubOptions = {}) {
    this.#options = options;
  }

  /** Seed a repository the routes can then read and mutate. */
  seedRepo(owner: string, repo: string, overrides: Partial<RepoState> = {}): void {
    this.#repos.set(key(owner, repo), {
      repo: {
        id: 1,
        name: repo,
        full_name: `${owner}/${repo}`,
        private: false,
        default_branch: 'main',
        html_url: `https://github.com/${owner}/${repo}`,
        ...overrides.repo,
      },
      branches: overrides.branches ?? [{ name: 'main' }],
      issues: overrides.issues ?? [],
      pulls: overrides.pulls ?? [],
      runs: overrides.runs ?? [],
      releases: overrides.releases ?? [],
    });
  }

  /**
   * Force the next `count` requests to get this response, before routing. Use it
   * to make the client see a 503 then success, or a rate limit, deterministically.
   */
  forceNext(response: Forced, count = 1): void {
    for (let i = 0; i < count; i += 1) this.#forced.push(response);
  }

  /** Produce a valid `X-Hub-Signature-256` for a body, for webhook tests. */
  signWebhook(rawBody: string): string {
    const secret = this.#options.webhookSecret ?? '';
    return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  }

  request(req: HttpRequest): Promise<HttpResponse> {
    const method = (req.method ?? 'GET').toUpperCase();
    this.requests.push({
      method,
      url: req.url,
      headers: { ...req.headers },
      body: req.body,
    });

    const forced = this.#forced.shift();
    if (forced !== undefined) {
      return Promise.resolve(
        this.#respond(req.url, forced.status, forced.body, forced.headers),
      );
    }

    // GitHub rejects any request without a User-Agent — model that, because a
    // client that forgot it would pass every mock test and fail live.
    if ((req.headers?.['user-agent'] ?? '') === '') {
      return Promise.resolve(
        this.#json(req.url, 403, { message: 'User-Agent is required' }),
      );
    }

    return Promise.resolve(this.#route(method, req));
  }

  // ── routing ───────────────────────────────────────────────────────────────

  #route(method: string, req: HttpRequest): HttpResponse {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = parseJson(req.body);

    if (method === 'POST' && path === '/graphql') return this.#graphql(req.url, body);
    if (
      method === 'POST' &&
      /^\/app\/installations\/[^/]+\/access_tokens$/.test(path)
    ) {
      return this.#json(req.url, 201, {
        token: 'ghs_fake_installation_token',
        expires_at: '2099-01-01T00:00:00Z',
      });
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoMatch === null) return this.#json(req.url, 404, { message: 'Not Found' });

    const [, owner = '', repo = '', rest = ''] = repoMatch;
    const state = this.#repos.get(key(owner, repo));
    if (state === undefined) return this.#json(req.url, 404, { message: 'Not Found' });

    // /repos/:o/:r
    if (rest === '' || rest === '/') {
      return method === 'GET'
        ? this.#json(req.url, 200, state.repo)
        : this.#json(req.url, 404, { message: 'Not Found' });
    }

    if (rest === '/branches' && method === 'GET')
      return this.#page(req.url, state.branches);

    if (rest === '/issues' && method === 'GET') {
      const wanted = url.searchParams.get('state') ?? 'open';
      const filtered =
        wanted === 'all'
          ? state.issues
          : state.issues.filter((i) => i['state'] === wanted);
      return this.#page(req.url, filtered);
    }
    if (rest === '/issues' && method === 'POST') {
      const issue = {
        number: this.#issueSeq++,
        title: body?.['title'],
        body: body?.['body'] ?? null,
        state: 'open',
        html_url: `${String(state.repo['html_url'])}/issues/x`,
      };
      state.issues.push(issue);
      return this.#json(req.url, 201, issue);
    }
    const issueGet = /^\/issues\/(\d+)$/.exec(rest);
    if (issueGet !== null && method === 'GET') {
      const found = state.issues.find((i) => String(i['number']) === issueGet[1]);
      return found
        ? this.#json(req.url, 200, found)
        : this.#json(req.url, 404, { message: 'Not Found' });
    }
    const commentPost = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (commentPost !== null && method === 'POST') {
      return this.#json(req.url, 201, { id: 42, body: body?.['body'] });
    }

    if (rest === '/pulls' && method === 'GET') {
      const wanted = url.searchParams.get('state') ?? 'open';
      const filtered =
        wanted === 'all'
          ? state.pulls
          : state.pulls.filter((p) => p['state'] === wanted);
      return this.#page(req.url, filtered);
    }
    if (rest === '/pulls' && method === 'POST') {
      const pull = {
        number: this.#issueSeq++,
        title: body?.['title'],
        state: 'open',
        merged: false,
        head: { ref: body?.['head'], sha: 'deadbeef' },
        base: { ref: body?.['base'] },
        html_url: `${String(state.repo['html_url'])}/pull/x`,
      };
      state.pulls.push(pull);
      return this.#json(req.url, 201, pull);
    }
    const pullGet = /^\/pulls\/(\d+)$/.exec(rest);
    if (pullGet !== null && method === 'GET') {
      const found = state.pulls.find((p) => String(p['number']) === pullGet[1]);
      return found
        ? this.#json(req.url, 200, found)
        : this.#json(req.url, 404, { message: 'Not Found' });
    }
    const pullMerge = /^\/pulls\/(\d+)\/merge$/.exec(rest);
    if (pullMerge !== null && method === 'PUT') {
      const found = state.pulls.find((p) => String(p['number']) === pullMerge[1]);
      if (found === undefined)
        return this.#json(req.url, 404, { message: 'Not Found' });
      found['merged'] = true;
      found['state'] = 'closed';
      return this.#json(req.url, 200, {
        merged: true,
        sha: 'mergedsha',
        message: 'Pull Request successfully merged',
      });
    }

    if (rest === '/actions/runs' && method === 'GET') {
      return this.#page(req.url, state.runs, 'workflow_runs');
    }
    if (/^\/actions\/workflows\/[^/]+\/dispatches$/.test(rest) && method === 'POST') {
      return this.#respond(req.url, 204, '');
    }

    if (rest === '/releases' && method === 'GET')
      return this.#page(req.url, state.releases);
    if (rest === '/releases' && method === 'POST') {
      const release = {
        id: 7,
        tag_name: body?.['tag_name'],
        name: body?.['name'] ?? null,
        draft: body?.['draft'] ?? false,
        prerelease: body?.['prerelease'] ?? false,
        html_url: `${String(state.repo['html_url'])}/releases/x`,
      };
      state.releases.push(release);
      return this.#json(req.url, 201, release);
    }

    return this.#json(req.url, 404, { message: 'Not Found' });
  }

  #graphql(url: string, body: Record<string, unknown> | undefined): HttpResponse {
    const raw = body?.['query'];
    const query = typeof raw === 'string' ? raw : '';
    const responder = this.#options.graphql;
    const result = responder ? responder(query, body?.['variables']) : { data: {} };
    return this.#json(url, 200, result);
  }

  // ── pagination and response helpers ─────────────────────────────────────────

  /**
   * Slice `items` by the `page`/`per_page` query and answer with a `Link` header
   * pointing at the next page when there is one — the real GitHub contract the
   * client's pagination reads.
   */
  #page(url: string, items: readonly unknown[], wrapKey?: string): HttpResponse {
    const parsed = new URL(url);
    const perPage = clampInt(parsed.searchParams.get('per_page'), 30);
    const page = clampInt(parsed.searchParams.get('page'), 1);
    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    const hasNext = start + perPage < items.length;

    const headers: Record<string, string> = {};
    if (hasNext) {
      const nextUrl = new URL(url);
      nextUrl.searchParams.set('page', String(page + 1));
      nextUrl.searchParams.set('per_page', String(perPage));
      headers['link'] = `<${nextUrl.toString()}>; rel="next"`;
    }
    const payload =
      wrapKey === undefined ? slice : { total_count: items.length, [wrapKey]: slice };
    return this.#json(url, 200, payload, headers);
  }

  #json(
    url: string,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): HttpResponse {
    return this.#respond(url, status, body, {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    });
  }

  #respond(
    url: string,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): HttpResponse {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      status,
      statusText: '',
      headers: lower(headers),
      body: text,
      url,
      truncated: false,
      redirects: 0,
    };
  }
}

function key(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function parseJson(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined || body === '') return undefined;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function clampInt(value: string | null, fallback: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  return Math.max(1, Number(value));
}

function lower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}
