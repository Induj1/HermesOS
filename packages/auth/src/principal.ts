/**
 * Principals — the authenticated identity every downstream check reasons about.
 *
 * A `Principal` is who a request is acting as: a user, a machine/service, or the
 * `anonymous` identity for an unauthenticated request. It carries the `scopes`
 * granted to it — the input to authorization (#27) — and a small bag of string
 * `attributes` (a tenant id, an email) for policies and audit. It deliberately
 * holds no secret: it is the *result* of authentication, safe to log and pass
 * around, not the credential.
 */

export type PrincipalKind = 'user' | 'service' | 'anonymous';

export interface Principal {
  /** A stable identifier for the identity (user id, service name). */
  readonly id: string;
  readonly kind: PrincipalKind;
  /** Coarse permissions this identity holds; the input to authorization. */
  readonly scopes: readonly string[];
  /** Extra string context (tenant, email, …) for policies and audit. */
  readonly attributes: Readonly<Record<string, string>>;
}

/** The unauthenticated identity. */
export const anonymous: Principal = {
  id: 'anonymous',
  kind: 'anonymous',
  scopes: [],
  attributes: {},
};

export interface PrincipalOptions {
  readonly kind?: PrincipalKind;
  readonly scopes?: readonly string[];
  readonly attributes?: Readonly<Record<string, string>>;
}

/** Build a principal, defaulting to a scopeless `user`. */
export function principal(id: string, options: PrincipalOptions = {}): Principal {
  return {
    id,
    kind: options.kind ?? 'user',
    scopes: options.scopes ?? [],
    attributes: options.attributes ?? {},
  };
}

/** Whether a principal is authenticated (anything but `anonymous`). */
export function isAuthenticated(p: Principal): boolean {
  return p.kind !== 'anonymous';
}
