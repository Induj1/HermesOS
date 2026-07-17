/**
 * @hermes/tools-http — make HTTP requests, safely enough to hand a model.
 *
 * The security core is **SSRF protection**. A model choosing a URL can be steered
 * to `http://169.254.169.254/` (cloud credentials) or an internal service, so
 * every URL — and every redirect target — passes a {@link HostPolicy}
 * ({@link checkUrl}, a pure function). The strong guarantee is an allowlist; the
 * default safety net blocks private and loopback addresses.
 *
 * ```ts
 * import { httpToolset, FetchHttpClient } from '@hermes/tools-http';
 * import { PermissionSet } from '@hermes/tools';
 *
 * runtime.use(httpToolset({
 *   client: new FetchHttpClient(),
 *   policy: { allowlist: ['api.github.com'] },        // strong SSRF protection
 *   granted: PermissionSet.none().grant('net:read'),  // read-only by default
 * }));
 * ```
 *
 * Requests are bounded by a timeout and a **streaming** size cap (a 2 GB response
 * is dropped mid-download, never buffered), and redirects are followed with the
 * boundary re-checked on every hop.
 *
 * See `docs/rfcs/RFC-0009-http-tools.md` for why it is shaped this way.
 */

export { httpTools } from './tools.js';
export type { HttpToolsOptions } from './tools.js';

export { httpToolset } from './toolset.js';
export type { HttpToolsetOptions } from './toolset.js';

export { guarded } from './client.js';
export type { GuardOptions, HttpClient, HttpRequest, HttpResponse } from './client.js';

export { checkUrl, isPrivateHost } from './policy.js';
export type { HostPolicy, PolicyVerdict } from './policy.js';

export { FetchHttpClient } from './fetch-client.js';
export type { FetchHttpClientOptions } from './fetch-client.js';

export { FakeHttpClient } from './fake-client.js';
export type {
  FakeHandler,
  FakeHttpClientOptions,
  FakeResponse,
} from './fake-client.js';

export { BlockedError, HttpError } from './errors.js';
export type { HttpErrorCode } from './errors.js';
