# RFC-0030: Authorization

| Field         | Value                              |
| ------------- | ---------------------------------- |
| Status        | Implemented                        |
| Date          | 2026-07-18                         |
| Scope         | `packages/authz` (`@hermes/authz`) |
| Depends on    | `@hermes/auth` (`Principal`)       |
| Supersedes    | —                                  |
| Superseded by | —                                  |

Design record for authorization: wildcard scope matching and a deny-override
policy engine over principals.

Covered by 20 tests in `packages/authz/tests`.

---

## 1. Context

Authentication (#26) answers _who_; authorization answers _may they_. This
package takes a `Principal` (with its scopes) and a requested action and returns
an allow/deny decision with a reason. It depends only on `@hermes/auth` for the
`Principal` type — no transport, no storage — so it is a pure decision function,
which is exactly what an authorization layer must be to be auditable and
testable.

## 2. Scopes and wildcard matching

Scopes are colon-delimited (`missions:read`, `admin:users:write`). A **trailing
`*`** covers any remaining segments — `missions:*` grants `missions:read` and
`missions:read:own`, and a bare `*` grants everything — while everything else is
exact (`missions:read` never grants `missions:write`).

The wildcard is deliberately **trailing-only and prefix-based**. A `*` in the
middle (`admin:*:read`) is treated as a literal, not a wildcard, because a
mid-string wildcard is far easier to over-grant with by accident, and "you can
only widen a scope by opening up its tail" is a rule an operator can reason
about at a glance. `hasScope` / `hasAllScopes` lift the match over a principal's
scope list.

## 3. Two layers

- **`authorizeScopes(principal, required)`** — the direct check most call sites
  need: allowed iff the principal holds every required scope, and on failure the
  reason **names the missing scopes** (so a `403` can say what was lacking
  without leaking the whole policy).
- **`PolicyAuthorizer`** — an ordered rule set for when the decision depends on
  more than scopes: the resource, the principal's tenant, the specific action.
  Rules are `allow`/`deny` predicates over an `AccessContext` (`principal`,
  `action`, optional `resource`).

## 4. Default-deny and deny-override

Two properties make the engine fail **closed**, which is the only safe default
for authorization:

- **Default-deny.** If no rule matches, the decision is deny. Access is never
  granted by omission.
- **Deny-override.** A matching `deny` rule beats every `allow`, **regardless of
  rule order**. The evaluation returns on the first matching deny and otherwise
  remembers the first matching allow — so adding a `deny` rule can only ever
  remove access, never accidentally be shadowed by an earlier allow.

That combination means an authorization _bug_ (a missing rule, a mis-ordered
list) denies rather than grants — a locked-out user is a bug report, a wrongly
granted one is an incident. Ready-made rules (`denyAnonymous`,
`allowWhenScoped`) cover the common cases; `allow`/`deny` take arbitrary
predicates for the rest.

## 5. Non-goals

- **No role storage.** Scopes live on the `Principal` (resolved at
  authentication). A role→scopes expansion is a thin map a service applies when
  it builds the principal, not state this package owns.
- **No policy language/DSL.** Rules are TypeScript predicates — typed, testable,
  and debuggable — not a string language needing its own parser and audit.
- **No resource fetching.** A rule receives the `resource` identifier; loading
  the resource to inspect it is the caller's job, kept out so the engine stays a
  pure function.

## 6. Testing

20 tests: scope matching (exact, trailing wildcard, bare `*`, over-long prefix,
mid-string non-wildcard) and `hasScope`/`hasAllScopes` including the empty
requirement; `authorizeScopes` allow and the missing-scope reason; and the
`PolicyAuthorizer`'s allow, default-deny, deny-override in **both** rule orders,
`denyAnonymous`, a bare allow, and the empty rule set. 100% branch coverage.
