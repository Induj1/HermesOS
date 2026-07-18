# @hermes/authz

Authorization — wildcard scope matching and a deny-override policy engine over
principals.

- **Design record:** [RFC-0030](../../docs/rfcs/RFC-0030-authz.md).
- **Depends on:** `@hermes/auth` (the `Principal` type).

## Usage

```ts
import {
  PolicyAuthorizer,
  allowWhenScoped,
  authorizeScopes,
  deny,
  denyAnonymous,
} from '@hermes/authz';

// Direct scope check — most call sites:
const decision = authorizeScopes(principal, ['missions:write']);
if (!decision.allowed) return forbidden(decision.reason); // names what's missing

// Policy engine — when the decision needs the resource/tenant/action:
const authorizer = new PolicyAuthorizer([
  denyAnonymous(),
  deny((c) => c.resource === 'system', 'system is read-only'),
  allowWhenScoped(),
]);
authorizer.authorize({ principal, action: 'missions:write', resource: 'm-1' });
```

## Concepts

- **Wildcard scopes.** `missions:*` covers `missions:read` and
  `missions:read:own`; `*` covers everything; wildcards are trailing-only.
- **Two layers.** `authorizeScopes` (direct, names missing scopes) and
  `PolicyAuthorizer` (ordered `allow`/`deny` rules over an `AccessContext`).
- **Fails closed.** Default-deny (no match → deny) and deny-override (any
  matching `deny` beats every `allow`, regardless of order), so a policy bug
  removes access rather than granting it.
- **Pure.** Depends only on the `Principal` type — no transport, no storage; a
  decision is a pure function, so it's fully testable and auditable.
