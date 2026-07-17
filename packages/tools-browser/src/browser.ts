/**
 * The browser port — a Playwright-shaped interface, backend-independent.
 *
 * The shape is deliberately Playwright's — `Browser` → `BrowserContext` → `Page`
 * — because that is the model the real backend will implement, and picking a
 * different shape here would mean an adapter layer translating between two
 * vocabularies forever. So {@link FakeBrowser} implements this, and a future
 * `PlaywrightBrowser` implements the same interface; the tools above depend only
 * on the port and cannot tell which is underneath.
 *
 * The methods are the subset an autonomous agent needs — navigate, read, click,
 * type, wait, upload, screenshot, manage tabs and contexts — each `Promise`-based
 * and `signal`-aware, because every one of them is cancellable in a real driver
 * and a tool must be able to abandon a hung page.
 */

export interface Browser {
  /** Open an isolated context (its own cookies, storage, and pages). */
  newContext(options?: ContextOptions): Promise<BrowserContext>;
  /** Close the browser and every context under it. */
  close(): Promise<void>;
}

export interface ContextOptions {
  /** A base URL that relative `goto` paths resolve against. */
  readonly baseURL?: string;
  /** Extra headers sent with every navigation in this context. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface BrowserContext {
  /** Open a new page (tab) in this context. */
  newPage(): Promise<Page>;
  /** Every open page in this context, in the order they were opened. */
  pages(): readonly Page[];
  /** The cookies visible to this context. */
  cookies(): Promise<readonly Cookie[]>;
  close(): Promise<void>;
}

export interface Cookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
}

export interface GotoOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface WaitOptions {
  readonly timeoutMs?: number;
  /** `attached` — present in the DOM; `visible` — present and not hidden. Default `visible`. */
  readonly state?: 'attached' | 'visible';
  readonly signal?: AbortSignal;
}

export interface ActionOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** The result of a navigation: where it ended up and the response status. */
export interface NavigationResult {
  readonly url: string;
  readonly status: number;
  /** How many redirects were followed to get here. */
  readonly redirects: number;
}

/** A JavaScript dialog (alert/confirm/prompt) awaiting a decision. */
export interface Dialog {
  readonly type: 'alert' | 'confirm' | 'prompt';
  readonly message: string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

/** A file offered for download. */
export interface Download {
  readonly suggestedFilename: string;
  /** The downloaded bytes. */
  content(): Promise<Uint8Array>;
}

export interface Page {
  /** The context this page belongs to. */
  readonly context: BrowserContext;

  /** Navigate to a URL (or a path relative to the context `baseURL`). */
  goto(url: string, options?: GotoOptions): Promise<NavigationResult>;
  /** Reload the current page. */
  reload(options?: GotoOptions): Promise<NavigationResult>;
  /** Navigate back in history. Throws if there is nowhere to go. */
  goBack(options?: GotoOptions): Promise<NavigationResult>;

  /** The current URL. */
  url(): string;
  /** The current page title. */
  title(): Promise<string>;
  /** The current serialized HTML. */
  content(): Promise<string>;
  /** The trimmed text content of the element matching `selector`. */
  textContent(selector: string, options?: ActionOptions): Promise<string>;
  /** An attribute of the element matching `selector`. */
  getAttribute(
    selector: string,
    name: string,
    options?: ActionOptions,
  ): Promise<string | undefined>;
  /** Whether any element matches `selector` right now. */
  isVisible(selector: string): Promise<boolean>;

  /** Click the element matching `selector`, following links and submitting forms. */
  click(selector: string, options?: ActionOptions): Promise<void>;
  /** Replace the value of an input/textarea. */
  fill(selector: string, value: string, options?: ActionOptions): Promise<void>;
  /** Append text to an input/textarea, character by character. */
  type(selector: string, text: string, options?: ActionOptions): Promise<void>;
  /** Press a key on the element matching `selector` (e.g. `Enter` to submit). */
  press(selector: string, key: string, options?: ActionOptions): Promise<void>;
  /** Select an option in a `<select>` by value. */
  selectOption(selector: string, value: string, options?: ActionOptions): Promise<void>;
  /** Set a checkbox or radio to checked. */
  check(selector: string, options?: ActionOptions): Promise<void>;
  /** Set the files on a file input. */
  setInputFiles(
    selector: string,
    files: readonly UploadFile[],
    options?: ActionOptions,
  ): Promise<void>;

  /** Wait for a selector to reach the requested state, or time out. */
  waitForSelector(selector: string, options?: WaitOptions): Promise<void>;

  /** Register a handler for the next dialog. Without one, dialogs auto-dismiss. */
  onDialog(handler: (dialog: Dialog) => void): void;
  /** Wait for a download to start, run `trigger`, and return it. */
  waitForDownload(trigger: () => Promise<void>): Promise<Download>;

  /** Capture a screenshot. The bytes are opaque; the fake returns a deterministic image. */
  screenshot(options?: ScreenshotOptions): Promise<Uint8Array>;

  close(): Promise<void>;
}

export interface UploadFile {
  readonly name: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
}

export interface ScreenshotOptions {
  /** Screenshot just the element matching this selector, rather than the page. */
  readonly selector?: string;
}
