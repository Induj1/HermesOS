/**
 * A high-fidelity fake browser — the reference backend, and the test double.
 *
 * It implements the whole {@link Browser} port with no real browser and no JS
 * engine, yet simulates the behaviours an agent depends on: navigation (through
 * the injected {@link HttpClient}, so redirects, timeouts, SSRF policy, and
 * network failures all flow through the shared HTTP layer — RFC-0012 §5), form
 * submission, clicks, keyboard input, selector waits, downloads, uploads,
 * dialogs, screenshots, multiple tabs, and isolated contexts.
 *
 * ## Where the page content comes from
 *
 * Everything a page shows is fetched over the `HttpClient`. So a test serves HTML
 * from a fake HTTP client keyed by URL, and navigation is a real request through
 * the real HTTP stack — which is what makes "the browser preserves the HTTP
 * layer's guarantees" a tested fact rather than a claim.
 *
 * ## The fake DOM protocol
 *
 * Behaviours a real browser would drive with JavaScript are expressed with
 * `data-fk-*` attributes the fake interprets, so a fixture is self-contained:
 *
 * - `data-fk-dialog="confirm:Are you sure?"` — clicking raises that dialog.
 * - `data-fk-appear-after="150"` — the element is not *visible* until 150ms of
 *   (virtual) wait have passed, for exercising `waitForSelector`.
 * - `data-fk-add-on-click="<p>hi</p>"` / `data-fk-remove-on-click="#gone"` — the
 *   click mutates the DOM in place, without navigating (an SPA update).
 * - `download` on an `<a>` — clicking downloads the href rather than navigating.
 *
 * These are the fake's contract, documented in RFC-0012 §4. A real Playwright
 * backend ignores them and uses actual JS; the tools work against either.
 */

import type { HttpClient } from '@hermes/tools-http';
import { HttpError } from '@hermes/tools-http';
import {
  type Browser,
  type BrowserContext,
  type ContextOptions,
  type Cookie,
  type Dialog,
  type Download,
  type GotoOptions,
  type NavigationResult,
  type Page,
  type ScreenshotOptions,
  type UploadFile,
  type WaitOptions,
  type ActionOptions,
} from './browser.js';
import { BrowserError } from './errors.js';
import {
  type DomElement,
  getAttribute,
  parseHtml,
  querySelector,
  querySelectorAll,
  serialize,
  textContent,
} from './dom.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface FakeBrowserOptions {
  /** The transport every navigation uses. Wrap it in `guarded` for redirects/SSRF. */
  readonly http: HttpClient;
}

export class FakeBrowser implements Browser {
  readonly #http: HttpClient;
  readonly #contexts: FakeContext[] = [];
  #closed = false;

  constructor(options: FakeBrowserOptions) {
    this.#http = options.http;
  }

  newContext(options: ContextOptions = {}): Promise<BrowserContext> {
    if (this.#closed) throw new BrowserError('TARGET_CLOSED', 'the browser is closed');
    const context = new FakeContext(this.#http, options);
    this.#contexts.push(context);
    return Promise.resolve(context);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const context of this.#contexts) await context.close();
  }
}

export class FakeContext implements BrowserContext {
  readonly #http: HttpClient;
  readonly #options: ContextOptions;
  readonly #pages: FakePage[] = [];
  readonly #cookies: Cookie[] = [];

  constructor(http: HttpClient, options: ContextOptions) {
    this.#http = http;
    this.#options = options;
  }

  get baseURL(): string | undefined {
    return this.#options.baseURL;
  }

  get extraHeaders(): Readonly<Record<string, string>> {
    return this.#options.extraHeaders ?? {};
  }

  get http(): HttpClient {
    return this.#http;
  }

  newPage(): Promise<Page> {
    const page = new FakePage(this);
    this.#pages.push(page);
    return Promise.resolve(page);
  }

  /** Internal: a page opening a background tab (target=_blank) registers here. */
  adopt(page: FakePage): void {
    this.#pages.push(page);
  }

  pages(): readonly Page[] {
    return this.#pages.filter((p) => !p.isClosed);
  }

  cookies(): Promise<readonly Cookie[]> {
    return Promise.resolve([...this.#cookies]);
  }

  async close(): Promise<void> {
    for (const page of this.#pages) await page.close();
  }
}

export class FakePage implements Page {
  readonly #context: FakeContext;
  #dom: DomElement = parseHtml('');
  #url = 'about:blank';
  readonly #history: string[] = [];
  #historyIndex = -1;
  /** Virtual milliseconds since the last navigation, advanced by waits. */
  #virtualNow = 0;
  #dialogHandler: ((dialog: Dialog) => void) | undefined;
  #capturingDownload = false;
  /** A one-slot sink for a captured download. An array so the compiler does not
   * narrow it to "always empty" (the mutation happens in an async callback). */
  readonly #downloadSink: Download[] = [];
  readonly #files = new Map<DomElement, readonly UploadFile[]>();
  #closed = false;

  constructor(context: FakeContext) {
    this.#context = context;
  }

  get context(): BrowserContext {
    return this.#context;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  // ── navigation ──────────────────────────────────────────────────────────────

  goto(url: string, options: GotoOptions = {}): Promise<NavigationResult> {
    return this.#navigate(this.#resolve(url), 'GET', undefined, options, true);
  }

  reload(options: GotoOptions = {}): Promise<NavigationResult> {
    return this.#navigate(this.#url, 'GET', undefined, options, false);
  }

  async goBack(options: GotoOptions = {}): Promise<NavigationResult> {
    const target = this.#history[this.#historyIndex - 1];
    if (this.#historyIndex <= 0 || target === undefined) {
      throw new BrowserError(
        'NAVIGATION_FAILED',
        'there is no previous page in history',
      );
    }
    this.#historyIndex -= 1;
    return this.#navigate(target, 'GET', undefined, options, false);
  }

  async #navigate(
    url: string,
    method: string,
    body: string | undefined,
    options: GotoOptions,
    pushHistory: boolean,
  ): Promise<NavigationResult> {
    this.#assertOpen();
    options.signal?.throwIfAborted();

    let response;
    try {
      response = await this.#context.http.request({
        url,
        method,
        headers: { ...this.#context.extraHeaders },
        ...(body === undefined ? {} : { body }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        throw new BrowserError(
          'NAVIGATION_FAILED',
          `navigation to ${url} failed: ${err.message}`,
          {
            target: url,
            cause: err,
          },
        );
      }
      throw err;
    }

    this.#dom = parseHtml(response.body);
    this.#url = response.url;
    this.#virtualNow = 0;
    this.#files.clear();
    if (pushHistory) {
      this.#history.splice(this.#historyIndex + 1);
      this.#history.push(response.url);
      this.#historyIndex = this.#history.length - 1;
    }
    return {
      url: response.url,
      status: response.status,
      redirects: response.redirects,
    };
  }

  #resolve(url: string): string {
    const base = this.#url !== 'about:blank' ? this.#url : this.#context.baseURL;
    // Normalize even without a base, so `https://x.dev` and `https://x.dev/` do
    // not read as two different pages.
    return new URL(url, base).toString();
  }

  // ── reading ─────────────────────────────────────────────────────────────────

  url(): string {
    return this.#url;
  }

  title(): Promise<string> {
    const title = querySelector(this.#dom, 'title');
    return Promise.resolve(title === undefined ? '' : textContent(title));
  }

  content(): Promise<string> {
    return Promise.resolve(serialize(this.#dom));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so #require's throw rejects
  async textContent(selector: string, options: ActionOptions = {}): Promise<string> {
    options.signal?.throwIfAborted();
    return textContent(this.#require(selector));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so #require's throw rejects
  async getAttribute(
    selector: string,
    name: string,
    options: ActionOptions = {},
  ): Promise<string | undefined> {
    options.signal?.throwIfAborted();
    return getAttribute(this.#require(selector), name);
  }

  isVisible(selector: string): Promise<boolean> {
    const el = querySelector(this.#dom, selector);
    return Promise.resolve(el !== undefined && this.#visible(el));
  }

  // ── interaction ─────────────────────────────────────────────────────────────

  async click(selector: string, options: ActionOptions = {}): Promise<void> {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    const el = this.#require(selector);

    const dialogSpec = getAttribute(el, 'data-fk-dialog');
    if (dialogSpec !== undefined) {
      await this.#raiseDialog(dialogSpec);
      return;
    }

    const download = getAttribute(el, 'download');
    const href = getAttribute(el, 'href');
    if (download !== undefined && href !== undefined) {
      await this.#startDownload(el, href, options);
      return;
    }

    if (this.#mutateOnClick(el)) return;

    if (el.tag === 'a' && href !== undefined) {
      if (getAttribute(el, 'target') === '_blank') {
        await this.#openInNewTab(href, options);
        return;
      }
      await this.#navigate(this.#resolve(href), 'GET', undefined, options, true);
      return;
    }

    const form = this.#enclosingForm(el);
    if (form !== undefined && this.#isSubmit(el)) {
      await this.#submit(form, options);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so a throw rejects
  async fill(
    selector: string,
    value: string,
    options: ActionOptions = {},
  ): Promise<void> {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    const el = this.#require(selector);
    if (!this.#isTextField(el)) {
      throw new BrowserError(
        'NOT_INTERACTABLE',
        `element "${selector}" cannot be filled`,
        { target: selector },
      );
    }
    el.attrs['value'] = value;
    if (el.tag === 'textarea') el.text = value;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so a throw rejects
  async type(
    selector: string,
    text: string,
    options: ActionOptions = {},
  ): Promise<void> {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    const el = this.#require(selector);
    if (!this.#isTextField(el)) {
      throw new BrowserError(
        'NOT_INTERACTABLE',
        `element "${selector}" cannot be typed into`,
        { target: selector },
      );
    }
    el.attrs['value'] = (el.attrs['value'] ?? '') + text;
  }

  async press(
    selector: string,
    key: string,
    options: ActionOptions = {},
  ): Promise<void> {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    const el = this.#require(selector);
    if (key === 'Enter') {
      const form = this.#enclosingForm(el);
      if (form !== undefined) await this.#submit(form, options);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so a throw rejects
  async selectOption(
    selector: string,
    value: string,
    options: ActionOptions = {},
  ): Promise<void> {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    const el = this.#require(selector);
    if (el.tag !== 'select') {
      throw new BrowserError(
        'NOT_INTERACTABLE',
        `element "${selector}" is not a <select>`,
        { target: selector },
      );
    }
    el.attrs['value'] = value;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so a throw rejects
  async check(selector: string, options: ActionOptions = {}): Promise<void> {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    const el = this.#require(selector);
    el.attrs['checked'] = '';
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so a throw rejects
  async setInputFiles(
    selector: string,
    files: readonly UploadFile[],
    options: ActionOptions = {},
  ): Promise<void> {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    const el = this.#require(selector);
    if (el.tag !== 'input' || getAttribute(el, 'type') !== 'file') {
      throw new BrowserError(
        'UPLOAD_FAILED',
        `element "${selector}" is not a file input`,
        { target: selector },
      );
    }
    this.#files.set(el, files);
  }

  // ── waiting ─────────────────────────────────────────────────────────────────

  // async (despite no await) so an aborted signal rejects rather than throwing
  // synchronously; the loop does no real awaiting — virtual time.
  // eslint-disable-next-line @typescript-eslint/require-await
  async waitForSelector(selector: string, options: WaitOptions = {}): Promise<void> {
    this.#assertOpen();
    const deadline = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const wantVisible = (options.state ?? 'visible') === 'visible';

    for (;;) {
      options.signal?.throwIfAborted();
      const matches = querySelectorAll(this.#dom, selector);
      const satisfied = wantVisible
        ? matches.some((el) => this.#visible(el))
        : matches.length > 0;
      if (satisfied) return;

      // Advance virtual time to the next moment an element could appear, capped
      // at the deadline. No real clock — this is deterministic and instant.
      const nextAppear = this.#nextAppearance(matches);
      if (nextAppear !== undefined && nextAppear <= deadline) {
        this.#virtualNow = nextAppear;
        continue;
      }
      if (this.#virtualNow < deadline && matches.length === 0) {
        this.#virtualNow = deadline;
      }
      throw new BrowserError(
        'TIMEOUT',
        `waiting for "${selector}" timed out after ${String(deadline)}ms`,
        {
          target: selector,
        },
      );
    }
  }

  #nextAppearance(matches: readonly DomElement[]): number | undefined {
    let next: number | undefined;
    for (const el of matches) {
      const at = Number(getAttribute(el, 'data-fk-appear-after') ?? 'NaN');
      if (
        !Number.isNaN(at) &&
        at > this.#virtualNow &&
        (next === undefined || at < next)
      )
        next = at;
    }
    return next;
  }

  // ── dialogs & downloads ───────────────────────────────────────────────────────

  onDialog(handler: (dialog: Dialog) => void): void {
    this.#dialogHandler = handler;
  }

  async waitForDownload(trigger: () => Promise<void>): Promise<Download> {
    this.#capturingDownload = true;
    this.#downloadSink.length = 0;
    try {
      await trigger();
    } finally {
      this.#capturingDownload = false;
    }
    const download = this.#downloadSink[0];
    if (download === undefined) {
      throw new BrowserError('DOWNLOAD_FAILED', 'the trigger did not start a download');
    }
    return download;
  }

  async #raiseDialog(spec: string): Promise<void> {
    const sep = spec.indexOf(':');
    const rawType = (sep === -1 ? spec : spec.slice(0, sep)).trim();
    const message = sep === -1 ? '' : spec.slice(sep + 1);
    const type: Dialog['type'] =
      rawType === 'alert' || rawType === 'prompt' ? rawType : 'confirm';

    // An array flag rather than a boolean, so the compiler does not treat it as
    // "never set" — the accept/dismiss closures set it, and the handler may call
    // them synchronously.
    const settled: true[] = [];
    const dialog: Dialog = {
      type,
      message,
      accept: () => {
        settled.push(true);
        return Promise.resolve();
      },
      dismiss: () => {
        settled.push(true);
        return Promise.resolve();
      },
    };
    this.#dialogHandler?.(dialog);
    // Playwright auto-dismisses a dialog no handler settled; model that rather
    // than hanging. It is recorded as handled, not an error.
    if (settled.length === 0) await dialog.dismiss();
  }

  async #startDownload(
    el: DomElement,
    href: string,
    options: ActionOptions,
  ): Promise<void> {
    const suggested = getAttribute(el, 'download');
    const filename =
      suggested !== undefined && suggested !== '' ? suggested : last(href);
    const url = this.#resolve(href);

    let bytes: Uint8Array;
    try {
      const response = await this.#context.http.request({
        url,
        method: 'GET',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      bytes = new TextEncoder().encode(response.body);
    } catch (err) {
      throw new BrowserError('DOWNLOAD_FAILED', `download of ${url} failed`, {
        target: url,
        cause: err,
      });
    }

    const download: Download = {
      suggestedFilename: filename,
      content: () => Promise.resolve(bytes),
    };
    if (this.#capturingDownload) this.#downloadSink.push(download);
  }

  // ── screenshots ─────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/require-await -- async so #require's throw rejects
  async screenshot(options: ScreenshotOptions = {}): Promise<Uint8Array> {
    this.#assertOpen();
    const target =
      options.selector === undefined ? this.#dom : this.#require(options.selector);
    const html = serialize(target);
    // Deterministic opaque bytes: the PNG signature plus a hash of the rendered
    // HTML, so identical DOM yields identical screenshots and a test can assert
    // stability without a real renderer.
    const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const digest = new TextEncoder().encode(hash(html));
    const out = new Uint8Array(signature.length + digest.length);
    out.set(signature);
    out.set(digest, signature.length);
    return out;
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  // ── internals ───────────────────────────────────────────────────────────────

  #require(selector: string): DomElement {
    const el = querySelector(this.#dom, selector);
    if (el === undefined) {
      throw new BrowserError('SELECTOR_NOT_FOUND', `no element matches "${selector}"`, {
        target: selector,
      });
    }
    return el;
  }

  #visible(el: DomElement): boolean {
    if (getAttribute(el, 'hidden') !== undefined) return false;
    const at = Number(getAttribute(el, 'data-fk-appear-after') ?? 'NaN');
    if (!Number.isNaN(at) && at > this.#virtualNow) return false;
    return true;
  }

  #mutateOnClick(el: DomElement): boolean {
    let mutated = false;
    const remove = getAttribute(el, 'data-fk-remove-on-click');
    if (remove !== undefined) {
      for (const target of querySelectorAll(this.#dom, remove)) detach(target);
      mutated = true;
    }
    const add = getAttribute(el, 'data-fk-add-on-click');
    if (add !== undefined) {
      const host = querySelector(this.#dom, 'body') ?? this.#dom;
      for (const child of parseHtml(add).children) {
        child.parent = host;
        host.children.push(child);
      }
      mutated = true;
    }
    return mutated;
  }

  async #openInNewTab(href: string, options: ActionOptions): Promise<void> {
    const page = new FakePage(this.#context);
    this.#context.adopt(page);
    await page.goto(this.#resolve(href), options);
  }

  #enclosingForm(el: DomElement): DomElement | undefined {
    let node: DomElement | undefined = el;
    while (node !== undefined) {
      if (node.tag === 'form') return node;
      node = node.parent;
    }
    return undefined;
  }

  #isSubmit(el: DomElement): boolean {
    const type = getAttribute(el, 'type');
    if (el.tag === 'button') return type === undefined || type === 'submit';
    if (el.tag === 'input') return type === 'submit';
    return false;
  }

  #isTextField(el: DomElement): boolean {
    if (el.tag === 'textarea') return true;
    if (el.tag !== 'input') return false;
    const type = getAttribute(el, 'type') ?? 'text';
    return ['text', 'search', 'email', 'password', 'url', 'tel', 'number'].includes(
      type,
    );
  }

  async #submit(form: DomElement, options: ActionOptions): Promise<void> {
    const params = new URLSearchParams();
    for (const field of querySelectorAll(form, 'input, textarea, select')) {
      const name = getAttribute(field, 'name');
      if (name === undefined) continue;
      const type = getAttribute(field, 'type');
      if (
        (type === 'checkbox' || type === 'radio') &&
        getAttribute(field, 'checked') === undefined
      )
        continue;
      if (type === 'file') {
        for (const file of this.#files.get(field) ?? []) params.append(name, file.name);
        continue;
      }
      params.append(
        name,
        getAttribute(field, 'value') ?? (field.tag === 'textarea' ? field.text : ''),
      );
    }

    const action = this.#resolve(getAttribute(form, 'action') ?? this.#url);
    const method = (getAttribute(form, 'method') ?? 'GET').toUpperCase();
    if (method === 'POST') {
      await this.#navigate(action, 'POST', params.toString(), options, true);
    } else {
      const url = new URL(action);
      url.search = params.toString();
      await this.#navigate(url.toString(), 'GET', undefined, options, true);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new BrowserError('TARGET_CLOSED', 'the page is closed');
  }
}

function detach(el: DomElement): void {
  const parent = el.parent;
  if (parent === undefined) return;
  const idx = parent.children.indexOf(el);
  if (idx !== -1) parent.children.splice(idx, 1);
  el.parent = undefined;
}

function last(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? path;
  const segments = clean.split('/').filter((s) => s !== '');
  return segments[segments.length - 1] ?? 'download';
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(16);
}
