/**
 * GitHub authentication — an abstraction, not a token.
 *
 * The client never holds a credential directly. It holds a {@link GitHubAuth},
 * whose one job is to produce the `Authorization` header for a request. That
 * indirection is what lets the same client work with a personal access token, a
 * GitHub App installation token, or — the case that makes the abstraction earn
 * its keep — an installation token that *expires hourly and must be refreshed*,
 * without the client knowing which it is talking to.
 *
 * Three implementations ship:
 *
 * - {@link tokenAuth} — a static token (PAT or a fixed installation token). The
 *   common case.
 * - {@link appAuth} — a GitHub App: mint a short-lived JWT from the app's private
 *   key, exchange it for an installation token, and cache that until it nears
 *   expiry. This is the one that needs a real credential to run live.
 * - {@link unauthenticated} — no header at all, for public read-only calls (which
 *   GitHub rate-limits far more tightly, but permits).
 */

export interface AuthHeader {
  /** The `Authorization` value, or undefined for an unauthenticated call. */
  readonly authorization: string | undefined;
}

/**
 * Produces the authorization for a request, possibly refreshing a token first.
 *
 * `headers()` is async because a real credential — an App installation token —
 * may need a network round-trip to refresh. A static token resolves immediately.
 * The signal lets a refresh be cancelled with the request that triggered it.
 */
export interface GitHubAuth {
  headers(signal?: AbortSignal): Promise<AuthHeader>;
}

/**
 * A static token: a personal access token, or a fixed installation token.
 *
 * GitHub accepts both `token <pat>` and `Bearer <token>`; `Bearer` is the modern
 * form and works for every token type, so that is what is sent.
 */
export function tokenAuth(token: string): GitHubAuth {
  if (token === '') {
    throw new Error('tokenAuth requires a non-empty token');
  }
  const header: AuthHeader = { authorization: `Bearer ${token}` };
  return { headers: () => Promise.resolve(header) };
}

/** No authorization header. Public, unauthenticated, tightly rate-limited. */
export function unauthenticated(): GitHubAuth {
  const header: AuthHeader = { authorization: undefined };
  return { headers: () => Promise.resolve(header) };
}

/**
 * How an installation token is obtained and when it expires.
 *
 * The token exchange itself is GitHub App-specific and credential-bound (it signs
 * a JWT with the app's RSA private key and POSTs to
 * `/app/installations/{id}/access_tokens`), so it is injected rather than baked
 * in: {@link appAuth} takes a `mint` callback that returns a token and its expiry.
 * That keeps the *caching and refresh logic* — the part worth testing — free of
 * any real credential, and lets the actual JWT signing live in one small,
 * separately-verified place (`app-jwt.ts`).
 */
export interface InstallationToken {
  readonly token: string;
  /** Epoch milliseconds at which the token stops working. */
  readonly expiresAt: number;
}

export interface AppAuthOptions {
  /** Obtain a fresh installation token. Called on first use and after expiry. */
  readonly mint: (signal?: AbortSignal) => Promise<InstallationToken>;
  /** The clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Refresh this many ms *before* the token actually expires, so a request is
   * never sent with a token that dies mid-flight. Default 60s.
   */
  readonly refreshSkewMs?: number;
}

/**
 * A GitHub App installation: mints an installation token and refreshes it before
 * it expires.
 *
 * The refresh is guarded against a stampede — if ten requests arrive at once with
 * an expired token, they share a single in-flight `mint` rather than each firing
 * their own, because GitHub rate-limits token creation and ten simultaneous mints
 * is both wasteful and a way to get throttled.
 */
export function appAuth(options: AppAuthOptions): GitHubAuth {
  const now = options.now ?? (() => Date.now());
  const skew = options.refreshSkewMs ?? 60_000;

  let cached: InstallationToken | undefined;
  let inFlight: Promise<InstallationToken> | undefined;

  const fresh = (token: InstallationToken): boolean => now() < token.expiresAt - skew;

  return {
    headers: async (signal) => {
      if (cached !== undefined && fresh(cached)) {
        return { authorization: `Bearer ${cached.token}` };
      }
      // Share one refresh across concurrent callers.
      inFlight ??= options.mint(signal).finally(() => {
        inFlight = undefined;
      });
      cached = await inFlight;
      return { authorization: `Bearer ${cached.token}` };
    },
  };
}
