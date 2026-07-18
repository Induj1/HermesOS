/**
 * Authenticators — turn a credential into a principal, or a reason it failed.
 *
 * `Authenticator` is the port; the strategies below are the built-in adapters.
 * Two details matter for security:
 *
 * - **Constant-time comparison.** API-key verification compares the presented
 *   token against each known key in constant time (`constantTimeEqual`), so an
 *   attacker cannot recover a key byte-by-byte from response timing. A plain
 *   `Map.get` would leak through early-exit string comparison.
 * - **A uniform failure.** Every failure returns `{ ok: false, reason }` with a
 *   generic reason; the caller maps that to `401` without telling the client
 *   *why* (unknown key vs malformed), which would help an attacker probe.
 */

import type { Principal } from './principal.js';

export type AuthResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly reason: string };

/** Verifies a raw credential string (a bearer token, an API key). */
export interface Authenticator {
  authenticate(credential: string): Promise<AuthResult>;
}

/**
 * Compare two strings in time independent of where they first differ. Returns
 * false for different lengths (length is not itself secret). Best-effort in a JS
 * VM, but it removes the obvious byte-by-byte timing oracle.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies an opaque API key against a fixed set of `key → principal` entries,
 * comparing in constant time. The map is never exposed; only the resolved
 * principal is returned.
 */
export class ApiKeyAuthenticator implements Authenticator {
  readonly #entries: readonly (readonly [string, Principal])[];

  constructor(
    keys: Readonly<Record<string, Principal>> | ReadonlyMap<string, Principal>,
  ) {
    this.#entries =
      keys instanceof Map
        ? [...keys.entries()]
        : Object.entries(keys as Record<string, Principal>);
  }

  authenticate(credential: string): Promise<AuthResult> {
    let found: Principal | undefined;
    // Scan every entry (no early exit) so timing does not reveal a prefix match.
    for (const [key, principal] of this.#entries) {
      if (constantTimeEqual(credential, key)) found = principal;
    }
    return Promise.resolve(
      found === undefined
        ? { ok: false, reason: 'invalid credentials' }
        : { ok: true, principal: found },
    );
  }
}

/** Try each authenticator in order; the first success wins. */
export class ChainAuthenticator implements Authenticator {
  readonly #authenticators: readonly Authenticator[];

  constructor(authenticators: readonly Authenticator[]) {
    this.#authenticators = authenticators;
  }

  async authenticate(credential: string): Promise<AuthResult> {
    let lastReason = 'no authenticator accepted the credential';
    for (const authenticator of this.#authenticators) {
      const result = await authenticator.authenticate(credential);
      if (result.ok) return result;
      lastReason = result.reason;
    }
    return { ok: false, reason: lastReason };
  }
}
