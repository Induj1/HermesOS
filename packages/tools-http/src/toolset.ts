/**
 * The HTTP toolset — the one call a host makes.
 *
 * It wraps the client in {@link guarded} so SSRF protection is on by default and
 * redirects are re-checked, and it defaults to read-only, because the dangerous
 * direction is a request that changes state.
 */

import { PermissionSet, toolset } from '@hermes/tools';
import type { Plugin } from '@hermes/kernel';
import { guarded, type HttpClient } from './client.js';
import type { HostPolicy } from './policy.js';
import { httpTools, type HttpToolsOptions } from './tools.js';

export interface HttpToolsetOptions extends HttpToolsOptions {
  /**
   * The client. Required. Usually a {@link FetchHttpClient}.
   *
   * No default: a client is what makes network requests, and defaulting to one
   * would be this package deciding a host may reach the network without saying so.
   */
  readonly client: HttpClient;
  /**
   * The SSRF policy. Defaults to blocking private addresses.
   *
   * With no `allowlist`, private/loopback/link-local addresses are blocked but any
   * public host is reachable — safe against the obvious internal-service attacks,
   * not against a public hostname that resolves to a private IP. For anything
   * fetching a model-produced URL, set an `allowlist`: it is the strong guarantee.
   */
  readonly policy?: HostPolicy;
  /** Maximum redirects to follow. Default 5. */
  readonly maxRedirects?: number;
  /**
   * What the tools are permitted to do. Defaults to read-only.
   *
   * `net:read` lets `http.get` work; `http.request` (any method, including
   * mutating ones) needs `net:write`. Read-only is the default because a
   * request that changes state is the one a host should have to grant on purpose.
   */
  readonly granted?: PermissionSet;
  readonly name?: string;
}

/**
 * Wire HTTP tools into a runtime.
 *
 * ```ts
 * runtime.use(httpToolset({
 *   client: new FetchHttpClient(),
 *   policy: { allowlist: ['api.github.com'] },   // strong SSRF protection
 *   granted: PermissionSet.none().grant('net:read'),
 * }));
 * ```
 */
export function httpToolset(options: HttpToolsetOptions): Plugin {
  const client = guarded(options.client, {
    policy: options.policy ?? { blockPrivate: true },
    ...(options.maxRedirects === undefined
      ? {}
      : { maxRedirects: options.maxRedirects }),
  });

  return toolset({
    name: options.name ?? 'http',
    tags: ['http', 'network'],
    granted: options.granted ?? PermissionSet.none().grant('net:read'),
    tools: httpTools(client, options),
  });
}
