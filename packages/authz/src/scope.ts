/**
 * Scope matching — does a granted scope cover a required one?
 *
 * Scopes are colon-delimited (`missions:read`, `admin:users:write`). A trailing
 * `*` segment is a wildcard that covers any remaining segments, so `missions:*`
 * grants `missions:read` and `missions:read:own`, and a bare `*` grants
 * everything. Matching is exact otherwise — `missions:read` never grants
 * `missions:write`. The rule is intentionally small and prefix-based, so a
 * granted scope can only *widen* by trailing wildcard, never by a wildcard in
 * the middle (which would be far easier to over-grant with by accident).
 */

/** Whether `granted` covers `required`. */
export function scopeMatches(granted: string, required: string): boolean {
  if (granted === required) return true;

  const grantedParts = granted.split(':');
  const last = grantedParts[grantedParts.length - 1];
  if (last !== '*') return false;

  // A trailing '*' matches any remaining segments, so the non-'*' prefix must
  // match the required scope's leading segments.
  const prefix = grantedParts.slice(0, -1);
  const requiredParts = required.split(':');
  if (prefix.length > requiredParts.length) return false;
  return prefix.every((segment, i) => segment === requiredParts[i]);
}

/** Whether any of `scopes` covers `required`. */
export function hasScope(scopes: readonly string[], required: string): boolean {
  return scopes.some((granted) => scopeMatches(granted, required));
}

/** Whether `scopes` covers every one of `required`. */
export function hasAllScopes(
  scopes: readonly string[],
  required: readonly string[],
): boolean {
  return required.every((one) => hasScope(scopes, one));
}
