# RFC-0029: Authentication

| Field         | Value                            |
| ------------- | -------------------------------- |
| Status        | Implemented                      |
| Date          | 2026-07-18                       |
| Scope         | `packages/auth` (`@hermes/auth`) |
| Depends on    | — (zero dependencies)            |
| Supersedes    | —                                |
| Superseded by | —                                |

Design record for authentication: principals, credentials, and pluggable
authenticators.

Covered by 25 tests in `packages/auth/tests`.

---

## 1. Context

Before a request can be authorized (#27) it must be _authenticated_: the system
must know **who** is acting. This package draws that line cleanly — a credential
goes in, a `Principal` comes out — and nothing downstream ever touches the raw
credential again.

Zero dependencies. Authentication here is credential comparison and principal
resolution; it deliberately does not bundle a JWT library or an OAuth client.
Those are future `Authenticator` adapters (a signed-token verifier over injected
keys, an OAuth introspection client over the shared HTTP transport), added
without changing this core.

## 2. Principal

A `Principal` is the safe-to-log **result** of authentication: an `id`, a `kind`
(`user` / `service` / `anonymous`), the `scopes` it holds, and a small
string-attribute bag (tenant, email) for policies and audit. It carries **no
secret** — it is what you pass around and log, not the credential. `anonymous`
is the identity of an unauthenticated request, so downstream code always has a
principal to reason about rather than a `null`.

## 3. Authenticators

`Authenticator` is the port — `authenticate(credential) → AuthResult`
(`{ ok, principal }` or `{ ok: false, reason }`). Two built-in adapters:

- **`ApiKeyAuthenticator`** resolves an opaque key to a principal from a fixed
  `key → principal` set (a record or a `Map`). The set is never exposed; only
  the resolved principal is returned.
- **`ChainAuthenticator`** tries several authenticators in order — an API key or
  a signed token or an OAuth check — and the first success wins.

Two security decisions are baked in:

- **Constant-time comparison.** `ApiKeyAuthenticator` compares the presented key
  against each known key with `constantTimeEqual` and **does not early-exit on a
  match**, so response timing does not reveal how much of a key an attacker got
  right — the timing oracle a plain `Map.get`/`===` would leak.
- **Uniform failure.** Every failure is `{ ok: false, reason }` with a generic
  reason; the caller maps it to a single `401` without telling the client
  _unknown key_ vs _malformed_, which would help probing.

## 4. The HTTP boundary

`authenticateHeaders(authenticator, headers)` reads `Authorization`
(case-insensitively, as HTTP requires), requires a `Bearer <token>`
(`extractBearer`), and verifies it — returning an `AuthResult`, never throwing,
so a handler maps every outcome to a status without a try/catch. It takes a
plain header record (the shape `@hermes/rest` already uses), so this package has
**no REST dependency** and a service wires it as a one-line middleware that puts
`result.principal` on the request context for authorization.

## 5. Non-goals

- **No token issuance or sessions.** This verifies credentials; minting them
  (login, refresh) is a service concern layered on top.
- **No password hashing.** Opaque API keys and (future) signed tokens are the
  model; a password store is a different subsystem.
- **No crypto dependency.** The constant-time compare is pure. A signed-token
  verifier that needs real crypto will isolate it in an adapter (as
  `@hermes/tracing` and `@hermes/secrets` isolate their `node:` use).

## 6. Testing

25 tests: principal defaults and the anonymous/authenticated check;
`constantTimeEqual` (equal, differing, length-mismatch); `ApiKeyAuthenticator`
over both a record and a `Map`, hit and miss; the chain's first-success,
last-reason, and empty cases; and `extractBearer` plus `authenticateHeaders`
across valid, wrong-scheme, missing, case-variant, and unknown-token headers.
100% branch coverage.
