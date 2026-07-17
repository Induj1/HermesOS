/**
 * Test support: a fake website served over the HTTP layer.
 *
 * The fake browser fetches every page through an `HttpClient`, so a test site is
 * just a `FakeHttpClient` mapping URLs to HTML — which means navigation in these
 * tests is a real request through the real HTTP stack, redirects and all.
 */

import { FakeHttpClient, guarded, type HttpClient } from '@hermes/tools-http';
import { HttpError } from '@hermes/tools-http';

export interface Route {
  /** HTML (or any body) to serve. */
  readonly body?: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** Throw a network error instead of responding. */
  readonly fail?: boolean;
  /** Redirect here (sets a 302 Location). */
  readonly redirectTo?: string;
}

/**
 * Build an HttpClient serving the given routes, wrapped in `guarded` so redirects
 * are followed (and would be SSRF-checked) exactly as in production.
 */
export function site(routes: Record<string, Route | string>): HttpClient {
  const fake = new FakeHttpClient({
    handle: (req) => {
      const key = normalize(req.url);
      const route = routes[key] ?? routes[req.url];
      if (route === undefined)
        return { status: 404, body: `<h1>Not Found: ${key}</h1>`, headers: json() };
      const r = typeof route === 'string' ? { body: route } : route;
      if (r.fail === true)
        throw new HttpError('NETWORK_ERROR', req.url, 'connection refused');
      if (r.redirectTo !== undefined) {
        return { status: 302, headers: { location: r.redirectTo }, body: '' };
      }
      return {
        status: r.status ?? 200,
        headers: { ...json(), ...r.headers },
        body: r.body ?? '',
      };
    },
  });
  return guarded(fake, { policy: { blockPrivate: false } });
}

function json(): Record<string, string> {
  return { 'content-type': 'text/html; charset=utf-8' };
}

/** Drop a trailing slash for stable route keys. */
function normalize(url: string): string {
  return url.replace(/\/$/, '');
}
