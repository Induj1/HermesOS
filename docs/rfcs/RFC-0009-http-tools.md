# RFC-0009: HTTP Tools

| Field         | Value                                                            |
| ------------- | ---------------------------------------------------------------- |
| Status        | Implemented                                                      |
| Date          | 2026-07-17                                                       |
| Scope         | `packages/tools-http` (`@hermes/tools-http`)                     |
| Depends on    | RFC-0001 (kernel), RFC-0006 (tool framework), RFC-0007 (pattern) |
| Supersedes    | —                                                                |
| Superseded by | —                                                                |

Design record for the HTTP tools. Like the shell package, it is mostly a
security document, because fetching a URL a model chose is the network's version
of running a command a model chose. It follows the tool-package pattern (a port,
one platform-coupled implementation, a fake) and the interesting parts are SSRF
and the redirect loop.

Covered by 92 tests in `packages/tools-http/tests`.

---

## 1. Context

Give an agent the ability to fetch a URL and it can read an API, a doc, a page —
and it can also fetch
`http://169.254.169.254/latest/meta-data/iam/security- credentials/`, the AWS
metadata endpoint that hands out the host's IAM credentials. Or
`http://localhost:6379`, an unauthenticated internal Redis. Or
`http://10.0.0.5/admin`. That is Server-Side Request Forgery, and it is
dangerous precisely because the request originates _inside_ the host's trust
boundary, where the firewall is not looking.

The model choosing the URL can be steered — "summarise this page" where the page
says "and fetch this internal URL". So the threat is live, not theoretical, and
it is the organising concern of the package.

## 2. The organising principle

> **Every URL, and every redirect target, passes a host policy — and the policy
> check is a pure function.**

## 3. The policy is pure, so the safety is testable

`checkUrl(url, policy)` decides whether a URL may be fetched, and it does **no
I/O** — no network, no DNS. It is a function of the URL string and the policy,
so the entire SSRF argument reduces to enumerable string cases. Three gates:

1. **Scheme.** Only `http`/`https`; `file://`, `ftp://`, `gopher://`, `data:`
   are refused — the classic protocol-smuggling vectors.
2. **Allowlist**, when set: only these exact hosts. The **strong** guarantee.
3. **Private-range block**, on by default: loopback, RFC 1918 private, RFC 3927
   link-local (which includes the metadata address), plus `localhost` and IPv6
   equivalents. The **safety net**.

`isPrivateHost` is a table of address ranges, and a table is where one wrong bit
hides, so it has a test per row.

## 4. The redirect loop is where the policy earns its keep

A request to an allowed host that responds
`302 Location: http://169.254.169.254/` would, under a client that
auto-followed, walk straight across the boundary — the allowlist checked once
and bypassed by the _server's_ response.

So redirect-following does **not** live in the fetch wrapper. The `HttpClient`
port makes exactly one request and `redirect: 'manual'` — it never follows.
`guarded()` owns the loop: it checks the initial URL, makes one request, and if
the answer is a redirect it **re-checks the new URL against the same policy**
before the next single request. The boundary is enforced on every hop or it is
not enforced.

`tests/client.test.ts` scripts the attack directly — an allowed host returning a
redirect to the metadata address — which is why the client is a port with a
fake: you cannot conjure that response from a real server on demand, but you can
script it in one line.

The loop also gets the HTTP redirect semantics right: 303 (and the historical
treatment of 301/302) becomes a GET with no body; 307/308 preserve method and
body, which is their whole purpose. A relative `Location` is resolved against
the URL that returned it before re-checking, because a relative redirect is
still a way across the boundary.

## 5. Bounds — streamed, not buffered

- **Size cap, enforced by streaming.** The response body is read chunk by chunk
  and the connection is dropped the moment it crosses the cap. `response.text()`
  would download the whole 2 GB first and _then_ measure it, paying the cost the
  cap exists to prevent. The result is flagged `truncated`.
- **Timeout** via an `AbortController`, honouring the caller's signal too — with
  an explicit check for an _already-aborted_ signal, because
  `addEventListener('abort')` never fires for one (a bug caught by a test: a
  pre-aborted request ran to completion).
- **Environment.** No credential handling here — the tool does not attach the
  host's cookies or auth. A caller that needs auth passes an explicit header,
  scoped to the request.

A 4xx or 5xx is **not** a bound and **not** an error: it is an `HttpResponse`
with that status, because "the resource is gone" or "the API is down" is
information an agent reasons about. The client throws only when no response came
back — blocked, timed out, too large, connection failed.

## 6. The read/write split

Two tools: `http.get` (declares `net:read`) and `http.request` (any method,
declares `net:write`). A host granting only `net:read` gets a read-only HTTP
surface, because the mutating methods are gated behind a permission it did not
grant — the same shape the filesystem tools use for a read-only disk. The
toolset defaults to `net:read`, because a request that changes state is one a
host should grant on purpose.

## 7. Known limitations and extension points

### 7.1 DNS rebinding defeats the private-range block

`checkUrl` sees _hostnames and IP literals_, not resolved addresses. A public
hostname `internal.evil.com` that resolves to `10.0.0.1` passes the
private-range block, because the block cannot see the resolution without doing
DNS — which a pure function will not do, and which would open a TOCTOU gap
between the check and the connect even if it did.

**This is why the allowlist is the real defence.** An allowlist is immune to
rebinding: a hostname not on the list cannot be reached whatever it resolves to.
The private-range block is a safety net for the common, unsophisticated case (a
model literally asking for `10.0.0.1`), and the documentation says so rather
than overstating it. A host fetching untrusted URLs should set an allowlist; a
fully robust block would need DNS resolution plus connecting to the pinned
resolved IP, which belongs in a custom `HttpClient`, not the pure policy.

### 7.2 No streaming _response_ to the caller

The size cap streams _internally_ to enforce the bound, but the tool returns a
whole (capped) string. There is no way to stream a response body incrementally
to a model, because the tool framework's `execute` returns a value, not a stream
(RFC-0006). Server-Sent Events and long-poll are therefore out of scope here;
they need a different surface — an event channel — which the interface layers
(REST, Telegram) will establish, and a streaming HTTP tool can build on then.

### 7.3 No cookie jar, no connection reuse across calls

Each `http.request` is independent: no shared cookie jar, no session. That is
the safe default — a shared jar is shared state a model could use to carry a
credential from one host to another — and a host that needs a session composes
it explicitly (an injected `fetch` with a cookie jar). Connection pooling is the
platform `fetch`'s business, and an injected `fetch` is the seam to tune it.

### 7.4 Text bodies only

Response bodies are decoded as UTF-8, like the filesystem and shell packages
(RFC-0007 §7.2, RFC-0008 §7.4). A binary download is a different tool.

## 8. Invariants — the short list

1. Every URL and every redirect target passes `checkUrl` before a request is
   made.
2. `checkUrl` is pure — no DNS, no network, no TOCTOU surface.
3. The `HttpClient` never follows redirects; `guarded` does, re-checking each
   hop.
4. Response bodies are size-capped by streaming, not buffered then measured.
5. A 4xx/5xx is a response, not an error; only "could not fetch" throws.
6. `http.get` is `net:read`; `http.request` is `net:write`.
