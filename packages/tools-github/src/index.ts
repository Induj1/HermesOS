/**
 * @hermes/tools-github — talk to GitHub, without a token in the hot path.
 *
 * A REST client and a GraphQL client over an injected transport
 * (`@hermes/tools-http`'s `HttpClient`), a typed resource facade for the objects
 * an agent works with, an authentication abstraction that spans PATs and GitHub
 * Apps, webhook signature verification, and a fake GitHub server that makes all of
 * it testable without a credential or the network.
 *
 * ```ts
 * import { GitHubClient, GitHub, tokenAuth } from '@hermes/tools-github';
 * import { FetchHttpClient, guarded } from '@hermes/tools-http';
 *
 * const http = guarded(new FetchHttpClient(), { policy: { allowHosts: ['api.github.com'] } });
 * const client = new GitHubClient({ http, auth: tokenAuth(process.env.GITHUB_TOKEN!) });
 * const github = new GitHub(client);
 *
 * const repo = await github.repos.get('octocat', 'hello-world');
 * for await (const pr of github.pulls.list('octocat', 'hello-world', { state: 'open' })) { ... }
 * ```
 *
 * See `docs/rfcs/RFC-0011-github-integration.md` for the design, and STATUS.md for
 * exactly what needs a live token to verify.
 */

export { GitHubClient, detectRateLimit, parseNextLink } from './client.js';
export type {
  GitHubClientOptions,
  RequestOptions,
  PaginateOptions,
  GitHubResponse,
} from './client.js';

export { GraphQLClient } from './graphql.js';
export type { GraphQLError, GraphQLResponse } from './graphql.js';

export { GitHub } from './resources.js';
export type {
  Repository,
  Issue,
  PullRequest,
  WorkflowRun,
  Release,
} from './resources.js';

export { tokenAuth, appAuth, unauthenticated } from './auth.js';
export type {
  GitHubAuth,
  AuthHeader,
  AppAuthOptions,
  InstallationToken,
} from './auth.js';

export { appJwt, installationTokenMinter } from './app-jwt.js';
export type { AppJwtOptions, InstallationMinterOptions } from './app-jwt.js';

export { verifyWebhookSignature, parseWebhook } from './webhooks.js';
export type { WebhookEvent, WebhookHeaders } from './webhooks.js';

export {
  GitHubError,
  RateLimitError,
  classifyStatus,
  messageFromBody,
} from './errors.js';
export type { GitHubErrorCode } from './errors.js';

export { FakeGitHubServer } from './fake-server.js';
export type { FakeGitHubOptions } from './fake-server.js';
