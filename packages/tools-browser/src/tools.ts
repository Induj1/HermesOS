/**
 * The browser tools.
 *
 * A tool per operation, over a {@link BrowserSession}, grouped by permission:
 *
 * - **`browser:read`** — content, text, attribute, title, visibility, waits,
 *   screenshots, listing tabs. Observe the page; change nothing.
 * - **`browser:navigate`** — navigate, back, reload, open/switch tabs. Cause the
 *   browser to load a URL (which goes through the HTTP layer's SSRF policy).
 * - **`browser:interact`** — click, fill, type, press, select, check, upload.
 *   Drive the page as a user would.
 *
 * Navigation is separated from interaction because a URL an agent visits is a
 * network request under the host's SSRF policy, while a click is a local act on
 * an already-loaded page — different reach, different grant.
 */

import { defineTool, s, type HermesTool } from '@hermes/tools';
import type { ToolContext } from '@hermes/kernel';
import type { ActionOptions, GotoOptions, Page, UploadFile } from './browser.js';
import type { BrowserSession } from './session.js';

const navResult = s.object({
  url: s.string(),
  status: s.number({ integer: true }),
  redirects: s.number({ integer: true }),
});

export function browserTools(session: BrowserSession): readonly HermesTool[] {
  // The kernel always supplies a signal, so it is always forwarded — a tool must
  // be cancellable.
  const opts = (ctx: ToolContext): ActionOptions & GotoOptions => ({
    signal: ctx.signal,
  });
  const page = (): Promise<Page> => session.page();

  // ── navigate ────────────────────────────────────────────────────────────────

  const navigate = defineTool({
    name: 'browser.navigate',
    description:
      'Navigate the active tab to a URL. Returns the final URL after redirects and the status.',
    tags: ['browser', 'navigate'],
    permissions: ['browser:navigate'],
    idempotent: true,
    input: s.object({ url: s.string({ description: 'The URL to open.' }) }),
    output: navResult,
    examples: [{ description: 'Open a page', input: { url: 'https://example.com' } }],
    execute: async ({ url }, ctx) => ({
      ...(await (await page()).goto(url, opts(ctx))),
    }),
  });

  const back = defineTool({
    name: 'browser.back',
    description: 'Navigate the active tab back to the previous page in history.',
    tags: ['browser', 'navigate'],
    permissions: ['browser:navigate'],
    idempotent: false,
    input: s.object({}),
    output: navResult,
    examples: [{ description: 'Go back', input: {} }],
    execute: async (_input, ctx) => ({ ...(await (await page()).goBack(opts(ctx))) }),
  });

  const reload = defineTool({
    name: 'browser.reload',
    description: 'Reload the active tab.',
    tags: ['browser', 'navigate'],
    permissions: ['browser:navigate'],
    idempotent: true,
    input: s.object({}),
    output: navResult,
    examples: [{ description: 'Reload', input: {} }],
    execute: async (_input, ctx) => ({ ...(await (await page()).reload(opts(ctx))) }),
  });

  const newTab = defineTool({
    name: 'browser.newTab',
    description:
      'Open a new tab and make it active, optionally navigating it to a URL.',
    tags: ['browser', 'navigate'],
    permissions: ['browser:navigate'],
    idempotent: false,
    input: s.object({
      url: s.optional(s.string({ description: 'A URL to open in the new tab.' })),
    }),
    output: s.object({ url: s.string() }),
    examples: [{ description: 'New blank tab', input: {} }],
    execute: async ({ url }) => {
      const tab = await session.newTab(url);
      return { url: tab.url() };
    },
  });

  const switchTab = defineTool({
    name: 'browser.switchTab',
    description: 'Switch the active tab by index (see browser.listTabs).',
    tags: ['browser', 'navigate'],
    permissions: ['browser:navigate'],
    idempotent: true,
    input: s.object({ index: s.number({ integer: true, minimum: 0 }) }),
    output: s.object({ active: s.number({ integer: true }) }),
    examples: [{ description: 'Switch to the second tab', input: { index: 1 } }],
    execute: async ({ index }) => {
      await session.switchTab(index);
      return { active: index };
    },
  });

  // ── read ────────────────────────────────────────────────────────────────────

  const content = defineTool({
    name: 'browser.content',
    description: 'Get the current HTML of the active tab.',
    tags: ['browser', 'read'],
    permissions: ['browser:read'],
    idempotent: true,
    input: s.object({}),
    output: s.object({ html: s.string() }),
    examples: [{ description: 'Read the page HTML', input: {} }],
    execute: async () => ({ html: await (await page()).content() }),
  });

  const title = defineTool({
    name: 'browser.title',
    description: 'Get the title of the active tab.',
    tags: ['browser', 'read'],
    permissions: ['browser:read'],
    idempotent: true,
    input: s.object({}),
    output: s.object({ title: s.string() }),
    examples: [{ description: 'Read the title', input: {} }],
    execute: async () => ({ title: await (await page()).title() }),
  });

  const text = defineTool({
    name: 'browser.text',
    description: 'Get the trimmed text content of the element matching a selector.',
    tags: ['browser', 'read'],
    permissions: ['browser:read'],
    idempotent: true,
    input: s.object({
      selector: s.string({ description: 'A CSS selector, or `text=…`.' }),
    }),
    output: s.object({ text: s.string() }),
    examples: [{ description: 'Read a heading', input: { selector: 'h1' } }],
    execute: async ({ selector }, ctx) => ({
      text: await (await page()).textContent(selector, opts(ctx)),
    }),
  });

  const attribute = defineTool({
    name: 'browser.attribute',
    description: 'Get an attribute of the element matching a selector.',
    tags: ['browser', 'read'],
    permissions: ['browser:read'],
    idempotent: true,
    input: s.object({
      selector: s.string(),
      name: s.string({ description: 'The attribute name.' }),
    }),
    output: s.object({ value: s.optional(s.string()) }),
    examples: [
      { description: 'Read a link target', input: { selector: 'a', name: 'href' } },
    ],
    execute: async ({ selector, name }, ctx) => ({
      value: await (await page()).getAttribute(selector, name, opts(ctx)),
    }),
  });

  const visible = defineTool({
    name: 'browser.visible',
    description: 'Check whether an element matching a selector is currently visible.',
    tags: ['browser', 'read'],
    permissions: ['browser:read'],
    idempotent: true,
    input: s.object({ selector: s.string() }),
    output: s.object({ visible: s.boolean() }),
    examples: [{ description: 'Is the banner shown', input: { selector: '#banner' } }],
    execute: async ({ selector }) => ({
      visible: await (await page()).isVisible(selector),
    }),
  });

  const waitFor = defineTool({
    name: 'browser.waitFor',
    description:
      'Wait for an element to appear (state "attached") or become visible ("visible").',
    tags: ['browser', 'read'],
    permissions: ['browser:read'],
    idempotent: true,
    input: s.object({
      selector: s.string(),
      state: s.withDefault(s.enumOf(['attached', 'visible']), 'visible'),
      timeoutMs: s.optional(s.number({ integer: true, minimum: 0 })),
    }),
    output: s.object({ found: s.boolean() }),
    examples: [{ description: 'Wait for a result', input: { selector: '#result' } }],
    execute: async ({ selector, state, timeoutMs }, ctx) => {
      await (
        await page()
      ).waitForSelector(selector, {
        state,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...opts(ctx),
      });
      return { found: true };
    },
  });

  const screenshot = defineTool({
    name: 'browser.screenshot',
    description:
      'Capture a screenshot of the page (or one element), returned as base64.',
    tags: ['browser', 'read'],
    permissions: ['browser:read'],
    idempotent: true,
    input: s.object({
      selector: s.optional(s.string({ description: 'Screenshot just this element.' })),
    }),
    output: s.object({ base64: s.string() }),
    examples: [{ description: 'Screenshot the page', input: {} }],
    execute: async ({ selector }) => {
      const bytes = await (
        await page()
      ).screenshot(selector === undefined ? {} : { selector });
      return { base64: Buffer.from(bytes).toString('base64') };
    },
  });

  const listTabs = defineTool({
    name: 'browser.listTabs',
    description: 'List the open tabs with their URLs and which is active.',
    tags: ['browser', 'read'],
    permissions: ['browser:read'],
    idempotent: true,
    input: s.object({}),
    output: s.object({
      tabs: s.array(
        s.object({
          index: s.number({ integer: true }),
          url: s.string(),
          active: s.boolean(),
        }),
      ),
    }),
    examples: [{ description: 'List tabs', input: {} }],
    execute: async () => ({ tabs: [...(await session.tabs())] }),
  });

  // ── interact ──────────────────────────────────────────────────────────────────

  const click = defineTool({
    name: 'browser.click',
    description:
      'Click the element matching a selector. Follows links and submits forms.',
    tags: ['browser', 'interact'],
    permissions: ['browser:interact'],
    idempotent: false,
    input: s.object({ selector: s.string() }),
    output: s.object({ url: s.string() }),
    examples: [
      { description: 'Click a button', input: { selector: 'button[type=submit]' } },
    ],
    execute: async ({ selector }, ctx) => {
      const p = await page();
      await p.click(selector, opts(ctx));
      return { url: p.url() };
    },
  });

  const fill = defineTool({
    name: 'browser.fill',
    description: 'Replace the value of an input or textarea.',
    tags: ['browser', 'interact'],
    permissions: ['browser:interact'],
    idempotent: true,
    input: s.object({ selector: s.string(), value: s.string() }),
    output: s.object({ ok: s.boolean() }),
    examples: [
      { description: 'Fill a field', input: { selector: '#email', value: 'a@b.dev' } },
    ],
    execute: async ({ selector, value }, ctx) => {
      await (await page()).fill(selector, value, opts(ctx));
      return { ok: true };
    },
  });

  const type = defineTool({
    name: 'browser.type',
    description: 'Append text to an input or textarea, character by character.',
    tags: ['browser', 'interact'],
    permissions: ['browser:interact'],
    idempotent: false,
    input: s.object({ selector: s.string(), text: s.string() }),
    output: s.object({ ok: s.boolean() }),
    examples: [
      {
        description: 'Type into a search box',
        input: { selector: '#q', text: 'hello' },
      },
    ],
    execute: async ({ selector, text: value }, ctx) => {
      await (await page()).type(selector, value, opts(ctx));
      return { ok: true };
    },
  });

  const press = defineTool({
    name: 'browser.press',
    description: 'Press a key on an element (e.g. "Enter" to submit a form).',
    tags: ['browser', 'interact'],
    permissions: ['browser:interact'],
    idempotent: false,
    input: s.object({
      selector: s.string(),
      key: s.string({ description: 'A key name, e.g. Enter.' }),
    }),
    output: s.object({ url: s.string() }),
    examples: [
      { description: 'Submit with Enter', input: { selector: '#q', key: 'Enter' } },
    ],
    execute: async ({ selector, key }, ctx) => {
      const p = await page();
      await p.press(selector, key, opts(ctx));
      return { url: p.url() };
    },
  });

  const select = defineTool({
    name: 'browser.select',
    description: 'Select an option in a <select> by value.',
    tags: ['browser', 'interact'],
    permissions: ['browser:interact'],
    idempotent: true,
    input: s.object({ selector: s.string(), value: s.string() }),
    output: s.object({ ok: s.boolean() }),
    examples: [
      { description: 'Choose a country', input: { selector: '#country', value: 'US' } },
    ],
    execute: async ({ selector, value }, ctx) => {
      await (await page()).selectOption(selector, value, opts(ctx));
      return { ok: true };
    },
  });

  const check = defineTool({
    name: 'browser.check',
    description: 'Check a checkbox or radio button.',
    tags: ['browser', 'interact'],
    permissions: ['browser:interact'],
    idempotent: true,
    input: s.object({ selector: s.string() }),
    output: s.object({ ok: s.boolean() }),
    examples: [{ description: 'Accept terms', input: { selector: '#terms' } }],
    execute: async ({ selector }, ctx) => {
      await (await page()).check(selector, opts(ctx));
      return { ok: true };
    },
  });

  const upload = defineTool({
    name: 'browser.upload',
    description: 'Set the files on a file input. File contents are base64-encoded.',
    tags: ['browser', 'interact'],
    permissions: ['browser:interact'],
    idempotent: true,
    input: s.object({
      selector: s.string(),
      files: s.array(
        s.object({
          name: s.string(),
          mimeType: s.withDefault(s.string(), 'application/octet-stream'),
          contentBase64: s.string({ description: 'The file bytes, base64-encoded.' }),
        }),
        { minItems: 1 },
      ),
    }),
    output: s.object({ ok: s.boolean() }),
    examples: [
      {
        description: 'Upload a text file',
        input: {
          selector: 'input[type=file]',
          files: [{ name: 'a.txt', contentBase64: 'aGk=' }],
        },
      },
    ],
    execute: async ({ selector, files }, ctx) => {
      const decoded: UploadFile[] = files.map((f) => ({
        name: f.name,
        mimeType: f.mimeType,
        content: new Uint8Array(Buffer.from(f.contentBase64, 'base64')),
      }));
      await (await page()).setInputFiles(selector, decoded, opts(ctx));
      return { ok: true };
    },
  });

  return [
    navigate,
    back,
    reload,
    newTab,
    switchTab,
    content,
    title,
    text,
    attribute,
    visible,
    waitFor,
    screenshot,
    listTabs,
    click,
    fill,
    type,
    press,
    select,
    check,
    upload,
  ];
}
