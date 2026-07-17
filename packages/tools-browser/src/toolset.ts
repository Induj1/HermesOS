/**
 * The browser toolset — the one call a host makes.
 *
 * The default grant is **`browser:read` + `browser:navigate`**: an agent may
 * browse and observe out of the box (navigation is bounded by the HTTP layer's
 * SSRF policy already), but *acting* on a page — clicking, typing, uploading — is
 * `browser:interact`, an explicit escalation. This mirrors the read/navigate vs.
 * write split the other tool packages use.
 *
 * All the tools share one {@link BrowserSession}, so a mission's navigate → fill →
 * click sequence acts on the same live page.
 */

import { PermissionSet, toolset } from '@hermes/tools';
import type { Plugin } from '@hermes/kernel';
import type { Browser, ContextOptions } from './browser.js';
import { BrowserSession } from './session.js';
import { browserTools } from './tools.js';

export interface BrowserToolsetOptions {
  /**
   * The browser. Required. A {@link FakeBrowser}, or a real Playwright-backed one.
   *
   * No default: a browser is a heavyweight, stateful resource a host owns and
   * must supply — defaulting to one would be this package launching a browser the
   * host never asked for.
   */
  readonly browser: Browser;
  /** Options for the context the session opens (base URL, extra headers). */
  readonly context?: ContextOptions;
  /** What the tools may do. Defaults to read + navigate. */
  readonly granted?: PermissionSet;
  readonly name?: string;
}

/**
 * Wire browser tools into a runtime.
 *
 * ```ts
 * runtime.use(browserToolset({
 *   browser: new FakeBrowser({ http: guarded(new FetchHttpClient(), { policy }) }),
 *   granted: PermissionSet.none().grant('browser:read').grant('browser:navigate').grant('browser:interact'),
 * }));
 * ```
 */
export function browserToolset(options: BrowserToolsetOptions): Plugin {
  const session = new BrowserSession(options.browser, options.context ?? {});
  return toolset({
    name: options.name ?? 'browser',
    tags: ['browser'],
    granted:
      options.granted ??
      PermissionSet.none().grant('browser:read').grant('browser:navigate'),
    tools: browserTools(session),
  });
}
