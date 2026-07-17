/**
 * The session — lazy context/page creation and tab management.
 */

import { describe, expect, it } from 'vitest';
import { FakeBrowser } from '../src/fake-browser.js';
import { BrowserSession } from '../src/session.js';
import { site } from './support.js';

const B = 'https://ex.dev';

const sessionOn = (routes: Parameters<typeof site>[0]): BrowserSession =>
  new BrowserSession(new FakeBrowser({ http: site(routes) }));

describe('BrowserSession', () => {
  it('lazily opens a context and a first page', async () => {
    const session = sessionOn({ [B]: '<h1>x</h1>' });
    const page = await session.page();
    expect(page.url()).toBe('about:blank');
    await page.goto(B);
    // The same page is returned on the next call.
    expect((await session.page()).url()).toBe(`${B}/`);
  });

  it('opens and tracks multiple tabs', async () => {
    const session = sessionOn({ [B]: '<h1>one</h1>', [`${B}/2`]: '<h1>two</h1>' });
    await (await session.page()).goto(B);
    await session.newTab(`${B}/2`);

    const tabs = await session.tabs();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ index: 1, url: `${B}/2`, active: true });
  });

  it('switches the active tab', async () => {
    const session = sessionOn({ [B]: '<h1>one</h1>', [`${B}/2`]: '<h1>two</h1>' });
    await (await session.page()).goto(B);
    await session.newTab(`${B}/2`);
    await session.switchTab(0);
    expect((await session.page()).url()).toBe(`${B}/`);
    expect((await session.tabs())[0]?.active).toBe(true);
  });

  it('opens a blank new tab when no url is given', async () => {
    const session = sessionOn({ [B]: '<h1>x</h1>' });
    await session.page();
    const tab = await session.newTab();
    expect(tab.url()).toBe('about:blank');
  });

  it('rejects switching to a non-existent tab (high and negative)', async () => {
    const session = sessionOn({ [B]: '<h1>x</h1>' });
    await session.page();
    await expect(session.switchTab(5)).rejects.toMatchObject({ code: 'TARGET_CLOSED' });
    await expect(session.switchTab(-1)).rejects.toMatchObject({
      code: 'TARGET_CLOSED',
    });
  });

  it('closes the browser', async () => {
    const session = sessionOn({ [B]: '<h1>x</h1>' });
    await session.page();
    await expect(session.close()).resolves.toBeUndefined();
  });
});
