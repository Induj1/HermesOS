# RFC-0011: GitHub Integration

| Field         | Value                                                      |
| ------------- | ---------------------------------------------------------- |
| Status        | Implemented (client complete; live calls credential-gated) |
| Date          | 2026-07-17                                                 |
| Scope         | `packages/tools-github` (`@hermes/tools-github`)           |
| Depends on    | RFC-0009 (HTTP tools — the transport port)                 |
| Supersedes    | —                                                          |
| Superseded by | —                                                          |

Design record for the GitHub integration: a REST client, a GraphQL client, an
authentication abstraction spanning personal tokens and GitHub Apps, webhook
verification, a typed resource facade, and a fake GitHub server that makes the
whole thing testable without a credential.

This is the first credential-gated subsystem, and the RFC is explicit about the
line: **everything is implemented and verified against a fake GitHub; only a
live round-trip to real GitHub is unverified, and it is unverified because it
needs a token this build does not have.** §9 states exactly what that means.

Covered by 98 tests in `packages/tools-github/tests`.

---

## 1. Context

An autonomous engineer that uses git (RFC-0010) needs GitHub: to open and review
pull requests, triage issues, watch CI, cut releases, and react to webhooks.
That is a broad API surface with several cross-cutting concerns — auth,
pagination, retries, rate limits — that are wrong to solve per-call and right to
solve once, in a client.

The constraint that shaped the work: it had to be **buildable and verifiable
without a GitHub token**. A client you cannot test until you have credentials is
a client you discover is broken at the worst time. So the design injects its
transport and its clock, and ships a fake GitHub server faithful enough that the
client is exercised end to end offline.

## 2. The organising principle

> **The transport is injected, so GitHub is just a policy on top of an
> `HttpClient` — and a fake GitHub is just another `HttpClient`.**

The client holds an {@link HttpClient} from `@hermes/tools-http` (RFC-0009). It
therefore inherits that package's timeout, response-size cap, and — when wired
through `guarded` — its SSRF policy, for free. More importantly, the seam that
lets a real `FetchHttpClient` talk to `api.github.com` is the same seam that
lets a `FakeGitHubServer` answer from memory. Every test in the package runs
against that fake; nothing in the suite opens a socket.

## 3. Authentication is an abstraction, not a token

The client never holds a credential. It holds a {@link GitHubAuth}, whose one
job is to produce the `Authorization` header — possibly refreshing it first.
Three implementations:

- **`tokenAuth`** — a static PAT or fixed installation token. The common case.
- **`unauthenticated`** — no header, for public reads (tightly rate-limited but
  permitted).
- **`appAuth`** — a GitHub App. An App has no token; it has an RSA private key,
  signs a short-lived JWT with it (`app-jwt.ts`, RS256, a 10-minute expiry and a
  backdated `iat` to tolerate clock skew), and exchanges the JWT for an
  _installation_ token that expires hourly. `appAuth` caches that token and
  refreshes it before expiry, with a **single-flight guard** so ten concurrent
  requests share one refresh rather than stampeding GitHub's token endpoint.

The refresh logic — the part with bugs in it — is pure over an injected clock
and an injected `mint` callback, so it is fully unit-tested. The JWT signing is
pure over a key and a clock, tested against a generated key pair. The only thing
that cannot be tested offline is the _pair working against real GitHub_ (§9).

## 4. What the client handles

- **Retries.** Transient 5xx (except 501) and re-thrown transport failures back
  off exponentially up to `maxRetries`. The sleep is injected, so tests are
  instant and deterministic and a deployment can supply a jittered one.
- **Rate limits.** GitHub has two throttles — the primary quota
  (`x-ratelimit-remaining: 0` + `x-ratelimit-reset`) and the secondary/abuse
  cooldown (`retry-after`). Both are detected (`detectRateLimit`, a pure
  function) and surfaced as a {@link RateLimitError} carrying an absolute
  `retryAt`. The default is to **throw** so the caller decides;
  `onRateLimit: 'wait'` sleeps until the reset, bounded by a cap so a client
  cannot be told to hang for an hour.
- **Pagination.** `paginate` follows `Link: rel="next"` so a caller iterates
  items, never pages, and `list` collects them. Endpoints that wrap items in an
  envelope (`{ total_count, items }`, or the Actions API's `workflow_runs`) are
  unwrapped via an `itemsKey`.
- **One request loop.** `request` and `paginate` share a single `#raw` loop that
  owns auth, retry, and rate-limit handling — there is not a second, subtly
  different copy for pagination.

## 5. GraphQL

GitHub's GraphQL API is one endpoint that answers `200` even for query errors,
putting failures in an `errors` array. The {@link GraphQLClient} reuses the REST
client's transport (so auth, retries, and rate limits apply unchanged) and adds
the one thing REST semantics miss: it **throws on an `errors` array**, and
treats a partial result (`data` and `errors` both present) as a failure, because
a caller handed half its fields and no signal would be silently wrong.

## 6. Webhooks

Verifying a delivery's `X-Hub-Signature-256` is the entire security of a webhook
endpoint. Two details make `verifyWebhookSignature` correct rather than
nearly-correct, and both are load-bearing:

1. **The HMAC is over the raw bytes.** `parseWebhook` verifies _before_ it
   parses, so an unverified body never reaches `JSON.parse`. Re-serialising the
   JSON first would fail on whitespace or key order.
2. **A constant-time compare** (`timingSafeEqual`), because a byte-by-byte `===`
   leaks how many leading bytes matched, which is enough to forge a signature.

## 7. The resource facade

`GitHub` is a typed facade grouped by resource — `repos`, `issues`, `pulls`,
`actions`, `releases`, and `graphql`. Each method builds a path and types the
result; there is no caching or cleverness. The value is the shape:
`github.pulls.merge(owner, repo, 7, { method: 'squash' })` instead of
remembering `PUT /repos/{o}/{r}/pulls/{n}/merge`. The types carry the fields the
code relies on, not GitHub's every field — they are documentation of what is
used, and grow when a caller needs more.

## 8. The fake GitHub server

`FakeGitHubServer` implements `HttpClient` and models the behaviours the client
depends on: it enforces the `User-Agent` GitHub requires (so a client that
forgot it fails offline, not live), paginates with real `Link` headers, wraps
Actions runs in their envelope, answers the installation-token exchange, and can
be told to rate-limit or fail transiently (`forceNext`) so the retry and
back-off paths are exercised against realistic responses. The contract tests
drive real create-then-read round-trips through it. It is not a validator of
GitHub's every rule — it models what the client relies on, and no more.

## 9. What needs a live credential

Implementation is complete and verified against the fake. What remains, and
**only** what remains, needs a real GitHub credential:

- **A real REST/GraphQL round-trip** against `api.github.com` with a PAT — to
  confirm the headers, pagination, and error mapping match live GitHub, not just
  the fake's model of it.
- **The GitHub App flow end to end** — a real App ID and private key, signing a
  JWT GitHub accepts and exchanging it for an installation token. The signing
  and the exchange are each tested in isolation; the _pair against GitHub_ is
  not.
- **A real webhook delivery** — GitHub POSTing a signed event to a running
  endpoint. The signature algorithm is verified against known-good HMACs; the
  delivery is not.

None of these are code gaps. They are the parts whose correctness can only be
confirmed against GitHub itself, and they are listed in STATUS.md with what each
needs. A `FetchHttpClient` + a token is all that stands between this package and
a live call.

## 10. What is not here

- **No OAuth web flow / device flow.** The client authenticates with tokens and
  Apps; obtaining a user token via the browser consent flow is a product concern
  (it needs a redirect URI and a running server) left to the interface layer.
- **No exhaustive API coverage.** The resource facade covers the lifecycle an
  agent needs first. Uncovered endpoints are reached via `client.request`
  directly, or the facade grows by the same pattern.
- **No runtime toolset.** This is a client library, not a `@hermes/tools`
  toolset — exposing GitHub operations as model-callable tools (with
  permissions) is a thin layer that belongs with the other interface work, once
  the product decides which operations an agent may perform unattended.

## 11. Testing

- **Unit** — `auth` (token/App caching, single-flight refresh), `app-jwt` (RS256
  signing verified with the public key), `errors` (status classification),
  `webhooks` (signature verification, including the constant-time and
  verify-before-parse paths), `client` (request shaping, retries, rate-limit
  throw/wait, pagination, `detectRateLimit`, `parseNextLink`), `graphql`.
- **Contract** — the resource facade end to end against `FakeGitHubServer`,
  including writes visible to subsequent reads (create issue → get issue, create
  PR → merge → get shows merged).
- **Fake server** — its own faithfulness: User-Agent enforcement, forced
  failures, the token exchange, 404s.

Branch coverage is 95.5%, above the enforced 95% floor.
