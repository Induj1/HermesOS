/**
 * @hermes/authz — Authorization: scope matching and a deny-override policy engine.
 *
 * ```ts
 * // Direct scope check — most call sites:
 * const decision = authorizeScopes(principal, ['missions:write']);
 * if (!decision.allowed) return forbidden(decision.reason);
 *
 * // Policy engine — when the decision needs the resource/tenant/action:
 * const authorizer = new PolicyAuthorizer([
 *   denyAnonymous(),
 *   deny((c) => c.resource === 'system', 'system is read-only'),
 *   allowWhenScoped(),
 * ]);
 * authorizer.authorize({ principal, action: 'missions:write', resource: 'm-1' });
 * ```
 *
 * Wildcard scopes: `missions:*` covers `missions:read`; `*` covers everything.
 * The engine is default-deny and deny-override, so a policy bug fails closed.
 */

export { hasAllScopes, hasScope, scopeMatches } from './scope.js';

export {
  PolicyAuthorizer,
  allow,
  allowWhenScoped,
  authorizeScopes,
  deny,
  denyAnonymous,
  type AccessContext,
  type AuthzDecision,
  type Effect,
  type PolicyRule,
} from './authorizer.js';
