/**
 * The HTTP boundary — pull a credential from request headers and authenticate.
 *
 * Kept framework-agnostic: `authenticateHeaders` takes a plain header record
 * (what `@hermes/rest` already models), so this package has no REST dependency
 * and a service wires it as one line of middleware. Header lookup is
 * case-insensitive, matching HTTP.
 */

import type { AuthResult, Authenticator } from './authenticator.js';

export type Headers = Readonly<Record<string, string | undefined>>;

/** Extract the token from an `Authorization: Bearer <token>` value. */
export function extractBearer(headerValue: string | undefined): string | undefined {
  if (headerValue === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(headerValue.trim());
  return match?.[1];
}

/** Read a header case-insensitively. */
function header(headers: Headers, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Authenticate a request from its headers: read `Authorization`, require a
 * bearer token, and verify it. A missing or non-bearer header fails uniformly
 * (`{ ok: false }`) rather than throwing, so the caller maps every outcome to a
 * status without branching on exceptions.
 */
export async function authenticateHeaders(
  authenticator: Authenticator,
  headers: Headers,
): Promise<AuthResult> {
  const token = extractBearer(header(headers, 'authorization'));
  if (token === undefined) return { ok: false, reason: 'missing bearer credentials' };
  return authenticator.authenticate(token);
}
