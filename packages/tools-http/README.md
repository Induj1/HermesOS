# @hermes/tools-http

Make HTTP requests for an agent — safely enough to hand a language model.

- **Design record:** [RFC-0009](../../docs/rfcs/RFC-0009-http-tools.md).
- **Depends on:** `@hermes/tools`, `@hermes/kernel`. Uses the platform `fetch`.

## The security core: SSRF

A model choosing a URL can be steered to fetch `http://169.254.169.254/` (cloud
credentials) or an internal service — Server-Side Request Forgery, dangerous
because the request runs from _inside_ the host's trust boundary. Every URL, and
**every redirect target**, passes a `HostPolicy`:

- **An allowlist** — the strong guarantee, immune to DNS rebinding. Use it for
  anything fetching a model-produced URL.
- **A private-range block** (default on) — a safety net that refuses loopback,
  private, and link-local addresses, including the cloud metadata endpoint.

`checkUrl` is a **pure function** — no DNS, no network — so the whole SSRF
argument is testable with no server, and the redirect loop re-checks the policy
on every hop, so a server cannot redirect an allowed request across the
boundary.

## Usage

```ts
import { httpToolset, FetchHttpClient } from '@hermes/tools-http';
import { PermissionSet } from '@hermes/tools';

runtime.use(
  httpToolset({
    client: new FetchHttpClient(),
    policy: { allowlist: ['api.github.com'] }, // strong SSRF protection
    granted: PermissionSet.none().grant('net:read'), // read-only by default
  }),
);
```

## The tools

| Tool           | Does                    | Permission  |
| -------------- | ----------------------- | ----------- |
| `http.get`     | Fetch a URL with GET    | `net:read`  |
| `http.request` | Any method (POST/PUT/…) | `net:write` |

Grant only `net:read` and `http.request` registers but refuses — a read-only
HTTP surface. Every request is bounded: a timeout, a **streaming** size cap (a
huge response is dropped mid-download, never buffered — result flagged
`truncated`), and redirects followed with the policy re-checked each hop. A
**4xx/5xx is a normal result**, not an error, so an agent can reason about "not
found" or "down".

## Testing your own tools against HTTP

`FakeHttpClient` makes no request and answers from a handler — including the
security case that matters most, a redirect to a blocked host:

```ts
import { FakeHttpClient, httpTools, guarded } from '@hermes/tools-http';
import { callTool } from '@hermes/tools';

const client = new FakeHttpClient({
  handle: () => ({ status: 200, body: '{"ok":true}' }),
});
const [get] = httpTools(
  guarded(client, { policy: { allowlist: ['api.example.com'] } }),
);

expect(await callTool(get, { url: 'https://api.example.com/x' })).toMatchObject(
  { status: 200 },
);
```

## Public API

| Export                      | What it is                                             |
| --------------------------- | ------------------------------------------------------ |
| `httpToolset`               | The one call a host makes. SSRF on, read-only default. |
| `httpTools`                 | The tools over an injected client.                     |
| `HttpClient`, `guarded`     | The port, and the SSRF + redirect guard.               |
| `checkUrl`, `isPrivateHost` | The policy. Pure functions.                            |
| `FetchHttpClient`           | Real, `fetch`-backed, manual-redirect, streaming cap.  |
| `FakeHttpClient`            | Scripted, no network. Tests and mock APIs.             |
| `HttpError`, `BlockedError` | Structured "could not fetch" errors.                   |

## Tests

```sh
pnpm test           # 92 tests, incl. a real-server suite and the SSRF-via-redirect case
pnpm test:coverage  # enforces a 95% threshold
```
