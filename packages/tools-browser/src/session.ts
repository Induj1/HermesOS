/**
 * A browser session — the stateful thing the stateless tools drive.
 *
 * Kernel tools are stateless functions, but a browser is inherently stateful: a
 * sequence of tool calls (navigate, then click, then read) all act on *the same
 * page*. {@link BrowserSession} is where that state lives. It lazily opens a
 * context and a first page, tracks the open tabs and which is active, and hands
 * the active {@link Page} to each tool.
 *
 * This is the same shape as the other packages' executors and clients — a single
 * injected object the tools close over — so a host wires a real Playwright
 * browser or a {@link FakeBrowser} identically, and the tools never know which.
 */

import type { Browser, BrowserContext, ContextOptions, Page } from './browser.js';
import { BrowserError } from './errors.js';

export class BrowserSession {
  readonly #browser: Browser;
  readonly #contextOptions: ContextOptions;
  #context: BrowserContext | undefined;
  #active = 0;

  constructor(browser: Browser, contextOptions: ContextOptions = {}) {
    this.#browser = browser;
    this.#contextOptions = contextOptions;
  }

  /** The active page, opening the context and first tab on first use. */
  async page(): Promise<Page> {
    const context = await this.#ensureContext();
    const pages = context.pages();
    if (pages.length === 0) return context.newPage();
    return pages[Math.min(this.#active, pages.length - 1)] ?? (await context.newPage());
  }

  /** Open a new tab and make it active. Optionally navigate it. */
  async newTab(url?: string): Promise<Page> {
    const context = await this.#ensureContext();
    const page = await context.newPage();
    this.#active = context.pages().indexOf(page);
    if (url !== undefined) await page.goto(url);
    return page;
  }

  /** Every open tab, with its URL and whether it is active. */
  async tabs(): Promise<readonly { index: number; url: string; active: boolean }[]> {
    const context = await this.#ensureContext();
    return context.pages().map((page, index) => ({
      index,
      url: page.url(),
      active: index === this.#active,
    }));
  }

  /** Make the tab at `index` active. */
  async switchTab(index: number): Promise<void> {
    const context = await this.#ensureContext();
    if (index < 0 || index >= context.pages().length) {
      throw new BrowserError('TARGET_CLOSED', `no tab at index ${String(index)}`);
    }
    this.#active = index;
  }

  async close(): Promise<void> {
    await this.#browser.close();
    this.#context = undefined;
  }

  async #ensureContext(): Promise<BrowserContext> {
    this.#context ??= await this.#browser.newContext(this.#contextOptions);
    return this.#context;
  }
}
