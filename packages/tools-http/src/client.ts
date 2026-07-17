/**
 * The HTTP client port, and the guard that follows redirects safely.
 *
 * The port is one method — `request` — doing exactly one HTTP request and
 * **not following redirects**. That is deliberate: redirect-following is
 * security-relevant (a redirect can cross the SSRF boundary), so it does not
 * belong in the thin fetch wrapper. It belongs in {@link guarded}, which owns the
 * policy and re-checks *every hop*.
 *
 * ## Why the redirect loop is the interesting part
 *
 * A request to `https://api.allowed.com` that responds `302 Location:
 * http://169.254.169.254/` would, under a client that auto-followed, walk
 * straight from an allowed host to the cloud metadata endpoint — the allowlist
 * checked once, at the start, and bypassed by the server's own response. So the
 * guard checks the initial URL, makes a *single* request, and if the answer is a
 * redirect it checks the new URL against the same policy before making the next
 * single request. The boundary is enforced on every hop or it is not enforced.
 */

import { BlockedError, HttpError } from './errors.js';
import { checkUrl, type HostPolicy } from './policy.js';

export interface HttpRequest {
  readonly url: string;
  /** GET when unset. Uppercased by the client. */
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Request body, for POST/PUT/PATCH. */
  readonly body?: string;
  /** Kill the request after this long. The client's default when unset. */
  readonly timeoutMs?: number;
  /** Refuse a response body larger than this. The client's default when unset. */
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly statusText: string;
  /** Response headers, lower-cased keys. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The URL that actually answered — the last one, after any redirects. */
  readonly url: string;
  /** True when the body hit the size cap and was cut short. */
  readonly truncated: boolean;
  /** How many redirects were followed to get here. */
  readonly redirects: number;
}

/**
 * Makes one HTTP request and does not follow redirects.
 *
 * A 3xx is returned as a response with its `location` header, for {@link guarded}
 * to act on. Throws {@link HttpError} only when no response came back — a timeout,
 * an oversized body, a connection failure. A 4xx/5xx is a normal response.
 */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface GuardOptions {
  readonly policy: HostPolicy;
  /** Maximum redirects to follow before giving up. Default 5. */
  readonly maxRedirects?: number;
}

/**
 * Wrap a client so every URL — initial and every redirect — passes the policy.
 *
 * This is where SSRF protection actually happens. The wrapped client is asked for
 * one request at a time, and the guard decides whether to follow a redirect and
 * whether the target is allowed. A host that wants no protection at all passes an
 * empty policy `{}` with `blockPrivate: false`; a host that means it passes an
 * allowlist.
 */
export function guarded(client: HttpClient, options: GuardOptions): HttpClient {
  const maxRedirects = options.maxRedirects ?? 5;

  return {
    request: async (req) => {
      let url = req.url;
      let method = (req.method ?? 'GET').toUpperCase();
      let body = req.body;

      for (let redirects = 0; ; redirects += 1) {
        const verdict = checkUrl(url, options.policy);
        if (!verdict.ok) throw new BlockedError(url, verdict.reason);

        const response = await client.request({
          ...req,
          url,
          method,
          ...(body === undefined ? {} : { body }),
        });

        const location = response.headers['location'];
        if (!isRedirect(response.status) || location === undefined) {
          return { ...response, redirects };
        }

        if (redirects >= maxRedirects) {
          throw new HttpError(
            'TOO_MANY_REDIRECTS',
            req.url,
            `more than ${String(maxRedirects)} redirects`,
          );
        }

        // Resolve the Location relative to the URL that returned it, so a relative
        // redirect (`Location: /login`) is re-checked as the absolute URL it
        // actually points at — a relative redirect is still a redirect, and still
        // a way across the boundary.
        url = new URL(location, url).toString();

        // 303, and the historical treatment of 301/302, turn the follow-up into a
        // GET with no body. 307/308 preserve the method and body — that is their
        // entire reason to exist, and dropping the body would silently change what
        // the caller asked for.
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method !== 'HEAD')
        ) {
          method = 'GET';
          body = undefined;
        }
      }
    },
  };
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}
