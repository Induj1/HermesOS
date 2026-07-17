/**
 * @hermes/tools-browser — drive a web browser from an agent, backend-independent.
 *
 * A Playwright-shaped port (`Browser` → `BrowserContext` → `Page`), a
 * high-fidelity {@link FakeBrowser} that implements it with no real browser, a
 * {@link BrowserSession} that carries page state across tool calls, and the tools
 * on top. Two ideas hold it together:
 *
 * 1. **Navigation goes through the HTTP layer.** A page's content is fetched over
 *    an injected `@hermes/tools-http` `HttpClient`, so redirects, timeouts, the
 *    SSRF policy, and network failures all flow through the shared, already-hardened
 *    networking rather than a second stack. Wrap the client in `guarded` and the
 *    browser inherits SSRF protection for free.
 * 2. **The backend is swappable.** The tools depend only on the port, so a real
 *    Playwright/Chromium driver is just another `Browser` implementation — nothing
 *    above it changes.
 *
 * ```ts
 * import { browserToolset, FakeBrowser } from '@hermes/tools-browser';
 * import { FetchHttpClient, guarded } from '@hermes/tools-http';
 * import { PermissionSet } from '@hermes/tools';
 *
 * const http = guarded(new FetchHttpClient(), { policy: { allowHosts: ['example.com'] } });
 * runtime.use(browserToolset({
 *   browser: new FakeBrowser({ http }),
 *   granted: PermissionSet.none().grant('browser:read').grant('browser:navigate').grant('browser:interact'),
 * }));
 * ```
 *
 * See `docs/rfcs/RFC-0012-browser-automation.md` for the design and STATUS.md for
 * what needs a real browser to verify.
 */

export { browserTools } from './tools.js';
export { browserToolset } from './toolset.js';
export type { BrowserToolsetOptions } from './toolset.js';

export { BrowserSession } from './session.js';

export { FakeBrowser, FakeContext, FakePage } from './fake-browser.js';
export type { FakeBrowserOptions } from './fake-browser.js';

export { BrowserError } from './errors.js';
export type { BrowserErrorCode } from './errors.js';

export type {
  Browser,
  BrowserContext,
  ContextOptions,
  Cookie,
  Page,
  GotoOptions,
  WaitOptions,
  ActionOptions,
  NavigationResult,
  Dialog,
  Download,
  UploadFile,
  ScreenshotOptions,
} from './browser.js';

export {
  parseHtml,
  querySelector,
  querySelectorAll,
  textContent,
  getAttribute,
  serialize,
  element,
} from './dom.js';
export type { DomElement } from './dom.js';
