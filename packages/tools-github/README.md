# @hermes/tools-github

Talk to GitHub — REST and GraphQL, auth, webhooks — without a token in the hot
path.

- **Design record:** [RFC-0011](../../docs/rfcs/RFC-0011-github-integration.md).
- **Depends on:** `@hermes/tools-http` (its `HttpClient` is the injected
  transport).

## The idea

The client holds an `HttpClient`, not a socket. So GitHub is just a policy on
top of the HTTP package — inheriting its timeout, size cap, and (through
`guarded`) its SSRF protection — and a **fake GitHub is just another
`HttpClient`**. Every test in this package runs against that fake; nothing opens
a connection. The only thing that needs a real token is a live round-trip (see
the bottom).

## Usage

```ts
import { GitHubClient, GitHub, tokenAuth } from '@hermes/tools-github';
import { FetchHttpClient, guarded } from '@hermes/tools-http';

const http = guarded(new FetchHttpClient(), {
  policy: { allowHosts: ['api.github.com'] },
});
const client = new GitHubClient({
  http,
  auth: tokenAuth(process.env.GITHUB_TOKEN!),
});
const github = new GitHub(client);

const repo = await github.repos.get('octocat', 'hello-world');
for await (const pr of github.pulls.list('octocat', 'hello-world', {
  state: 'open',
})) {
  // paginated transparently — no page boundaries
}
const merged = await github.pulls.merge('octocat', 'hello-world', 7, {
  method: 'squash',
});
```

## What the client handles

- **Auth as an abstraction.** `tokenAuth` (PAT), `unauthenticated` (public), and
  `appAuth` (a GitHub App: mint a JWT from the app key, exchange for an
  installation token, cache and refresh it before expiry — with a single-flight
  guard so concurrent requests share one refresh).
- **Retries.** Transient 5xx and transport blips back off exponentially. Sleep
  is injectable, so tests are instant.
- **Rate limits.** Both GitHub throttles are detected and surfaced as a
  `RateLimitError` with a concrete `retryAt`. Default is to throw;
  `onRateLimit: 'wait'` sleeps until reset, bounded by a cap.
- **Pagination.** `paginate` follows `Link` headers; `list` collects. Envelope
  endpoints (`workflow_runs`) unwrap via `itemsKey`.
- **GraphQL.** `GraphQLClient` reuses the transport and throws on a GraphQL
  `errors` array — the failure REST semantics would otherwise hide.

## Webhooks

```ts
import { parseWebhook } from '@hermes/tools-github';

// Verify the raw body BEFORE parsing — never parse an unverified payload.
const event = parseWebhook(rawBody, req.headers, process.env.WEBHOOK_SECRET!);
if (event.name === 'pull_request') {
  /* event.payload is the parsed body */
}
```

`verifyWebhookSignature` uses a constant-time compare and HMACs the exact bytes
GitHub sent.

## The resource facade

`GitHub` groups operations by resource:

```ts
github.repos.get / listBranches;
github.issues.list / get / create / comment;
github.pulls.list / get / create / merge;
github.actions.listWorkflowRuns / dispatchWorkflow;
github.releases.list / create;
github.graphql.query;
```

Uncovered endpoints are reachable via `client.request(method, path, options)`.

## Testing against the fake server

`FakeGitHubServer` is an in-memory GitHub that implements `HttpClient`:

```ts
import { FakeGitHubServer, GitHubClient, GitHub } from '@hermes/tools-github';

const server = new FakeGitHubServer();
server.seedRepo('octo', 'demo');
const github = new GitHub(
  new GitHubClient({ http: server, userAgent: 'test' }),
);

const issue = await github.issues.create('octo', 'demo', { title: 'A bug' });
const back = await github.issues.get('octo', 'demo', issue.number); // round-trips

server.forceNext({ status: 503 }, 2); // make the client's retry logic earn it
```

## What needs a live token

Everything above is implemented and tested against the fake. Only a **live
round-trip** is unverified, because it needs a credential this build does not
have: a real REST/GraphQL call with a PAT, the GitHub App JWT→installation-token
flow against real GitHub, and a real signed webhook delivery. See RFC-0011 §9
and STATUS.md. A `FetchHttpClient` and a token are all that is required to close
it.
