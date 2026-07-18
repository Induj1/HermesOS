/**
 * Authorization — decide whether a principal may perform an action.
 *
 * Two layers, smallest first:
 *
 * - `authorizeScopes(principal, required)` — the direct check: does the
 *   principal hold every required scope? Most call sites need only this.
 * - `PolicyAuthorizer` — an ordered rule set for when a decision depends on more
 *   than scopes (the resource, the principal's tenant, the action). It is
 *   **default-deny** and **deny-override**: nothing is allowed unless a rule
 *   says so, and any matching `deny` rule beats every `allow` — the two
 *   properties that keep an authorization bug failing *closed*.
 */

import type { Principal } from '@hermes/auth';
import { hasAllScopes } from './scope.js';

export interface AuthzDecision {
  readonly allowed: boolean;
  /** Why — the deciding rule, or why nothing allowed it. */
  readonly reason: string;
}

/** The direct scope check: allowed iff the principal holds every required scope. */
export function authorizeScopes(
  principal: Principal,
  required: readonly string[],
): AuthzDecision {
  if (hasAllScopes(principal.scopes, required)) {
    return { allowed: true, reason: 'principal holds the required scopes' };
  }
  const missing = required.filter((s) => !hasAllScopes(principal.scopes, [s]));
  return { allowed: false, reason: `missing scope(s): ${missing.join(', ')}` };
}

export type Effect = 'allow' | 'deny';

/** What a policy rule sees when it decides. */
export interface AccessContext {
  readonly principal: Principal;
  /** The operation, e.g. `missions:write`. */
  readonly action: string;
  /** The target, if any (an id, a path). */
  readonly resource?: string;
}

export interface PolicyRule {
  readonly effect: Effect;
  /** A human description, used as the decision reason. */
  readonly description: string;
  matches(context: AccessContext): boolean;
}

export class PolicyAuthorizer {
  readonly #rules: readonly PolicyRule[];

  constructor(rules: readonly PolicyRule[]) {
    this.#rules = rules;
  }

  /**
   * Evaluate every rule. A matching `deny` wins outright (deny-override); absent
   * any deny, a matching `allow` permits; if nothing matches, the default is
   * deny (fail closed).
   */
  authorize(context: AccessContext): AuthzDecision {
    let allow: PolicyRule | undefined;
    for (const rule of this.#rules) {
      if (!rule.matches(context)) continue;
      if (rule.effect === 'deny') {
        return { allowed: false, reason: rule.description };
      }
      allow ??= rule;
    }
    return allow === undefined
      ? { allowed: false, reason: 'no matching allow rule (default deny)' }
      : { allowed: true, reason: allow.description };
  }
}

/** An allow rule from a predicate. */
export function allow(
  matches: (context: AccessContext) => boolean,
  description = 'allow',
): PolicyRule {
  return { effect: 'allow', description, matches };
}

/** A deny rule from a predicate. */
export function deny(
  matches: (context: AccessContext) => boolean,
  description = 'deny',
): PolicyRule {
  return { effect: 'deny', description, matches };
}

/** Allow when the principal holds a scope covering the action. */
export function allowWhenScoped(
  description = 'principal is scoped for the action',
): PolicyRule {
  return allow((ctx) => hasAllScopes(ctx.principal.scopes, [ctx.action]), description);
}

/** Deny the anonymous principal outright. */
export function denyAnonymous(description = 'anonymous is not permitted'): PolicyRule {
  return deny((ctx) => ctx.principal.kind === 'anonymous', description);
}
