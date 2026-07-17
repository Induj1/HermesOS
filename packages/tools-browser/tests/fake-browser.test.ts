/**
 * The fake browser, exercised across every behaviour it simulates.
 *
 * Navigation runs through a real HTTP client (the `site` helper), so redirects,
 * network failures, and the SSRF-capable transport are genuinely in the loop.
 * The rest — forms, clicks, keyboard, waits, downloads, uploads, dialogs,
 * screenshots, tabs, contexts — is driven through the port the tools use.
 */

import { describe, expect, it } from 'vitest';
import { FakeBrowser } from '../src/fake-browser.js';
import { BrowserError } from '../src/errors.js';
import type { Dialog, Page } from '../src/browser.js';
import { site } from './support.js';

const B = 'https://ex.dev';

async function pageOn(routes: Parameters<typeof site>[0]): Promise<Page> {
  const browser = new FakeBrowser({ http: site(routes) });
  const context = await browser.newContext();
  return context.newPage();
}

describe('navigation', () => {
  it('loads a page and reads its content and title', async () => {
    const page = await pageOn({
      [B]: '<html><head><title>Home</title></head><body><h1>Hi</h1></body></html>',
    });
    const nav = await page.goto(B);
    expect(nav.status).toBe(200);
    expect(await page.title()).toBe('Home');
    expect(await page.textContent('h1')).toBe('Hi');
  });

  it('follows a redirect through the HTTP layer', async () => {
    const page = await pageOn({
      [`${B}/old`]: { redirectTo: `${B}/new` },
      [`${B}/new`]: '<h1>New</h1>',
    });
    const nav = await page.goto(`${B}/old`);
    expect(nav.url).toBe(`${B}/new`);
    expect(nav.redirects).toBe(1);
    expect(await page.textContent('h1')).toBe('New');
  });

  it('reports a network failure as NAVIGATION_FAILED', async () => {
    const page = await pageOn({ [`${B}/down`]: { fail: true } });
    await expect(page.goto(`${B}/down`)).rejects.toMatchObject({
      code: 'NAVIGATION_FAILED',
    });
  });

  it('rethrows a non-HTTP transport error unchanged', async () => {
    const browser = new FakeBrowser({
      http: { request: () => Promise.reject(new Error('boom')) },
    });
    const page = await (await browser.newContext()).newPage();
    await expect(page.goto(B)).rejects.toThrow('boom');
  });

  it('navigates back through history', async () => {
    const page = await pageOn({
      [`${B}/1`]: '<h1>One</h1>',
      [`${B}/2`]: '<h1>Two</h1>',
    });
    await page.goto(`${B}/1`);
    await page.goto(`${B}/2`);
    expect(await page.textContent('h1')).toBe('Two');
    await page.goBack();
    expect(await page.textContent('h1')).toBe('One');
  });

  it('refuses to go back with no history', async () => {
    const page = await pageOn({ [B]: '<h1>x</h1>' });
    await page.goto(B);
    await expect(page.goBack()).rejects.toMatchObject({ code: 'NAVIGATION_FAILED' });
  });

  it('reloads the current page', async () => {
    const page = await pageOn({ [B]: '<h1>x</h1>' });
    await page.goto(B);
    expect((await page.reload()).url).toBe(`${B}/`);
  });
});

describe('links and clicks', () => {
  it('follows a link click to a new page', async () => {
    const page = await pageOn({
      [B]: '<a href="/next">go</a>',
      [`${B}/next`]: '<h1>Next</h1>',
    });
    await page.goto(B);
    await page.click('a');
    expect(await page.textContent('h1')).toBe('Next');
  });

  it('updates the DOM in place on a click (no navigation)', async () => {
    const page = await pageOn({
      [B]: '<button data-fk-add-on-click="<p id=added>added</p>">add</button>',
    });
    await page.goto(B);
    expect(await page.isVisible('#added')).toBe(false);
    await page.click('button');
    expect(await page.textContent('#added')).toBe('added');
  });

  it('removes elements in place on a click', async () => {
    const page = await pageOn({
      [B]: '<div id="gone">x</div><button data-fk-remove-on-click="#gone">del</button>',
    });
    await page.goto(B);
    await page.click('button');
    expect(await page.isVisible('#gone')).toBe(false);
  });

  it('throws SELECTOR_NOT_FOUND for a missing element', async () => {
    const page = await pageOn({ [B]: '<p>x</p>' });
    await page.goto(B);
    await expect(page.click('#nope')).rejects.toMatchObject({
      code: 'SELECTOR_NOT_FOUND',
    });
  });

  it('clicking a non-submit control inside a form does not submit', async () => {
    const page = await pageOn({
      [B]: '<form action="/s"><input id="t" type="text"><span id="lbl">label</span></form>',
    });
    await page.goto(B);
    await page.click('#t'); // a text input — not a submit
    await page.click('#lbl'); // a plain element inside the form — not a submit
    expect(page.url()).toBe(`${B}/`);
  });
});

describe('forms', () => {
  it('submits a GET form as a query string', async () => {
    const page = await pageOn({
      [B]: '<form action="/search" method="get"><input name="q" type="text"><button type="submit">Go</button></form>',
      [`${B}/search?q=hello`]: '<h1>Results</h1>',
    });
    await page.goto(B);
    await page.fill('input[name=q]', 'hello');
    await page.click('button');
    expect(page.url()).toBe(`${B}/search?q=hello`);
    expect(await page.textContent('h1')).toBe('Results');
  });

  it('submits a POST form with the fields in the body', async () => {
    const bodies: (string | undefined)[] = [];
    const form =
      '<form action="/save" method="post"><input name="q" type="text"><button type=submit>Go</button></form>';
    const browser = new FakeBrowser({
      http: {
        request: (req) => {
          if ((req.method ?? 'GET') === 'POST') bodies.push(req.body);
          return Promise.resolve({
            status: 200,
            statusText: '',
            headers: { 'content-type': 'text/html' },
            body: req.url.endsWith('/save') ? '<h1>saved</h1>' : form,
            url: req.url,
            truncated: false,
            redirects: 0,
          });
        },
      },
    });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${B}/form`);
    await page.fill('input', 'hello');
    await page.click('button');
    expect(await page.textContent('h1')).toBe('saved');
    expect(bodies).toEqual(['q=hello']);
  });

  it('submits on Enter in a text field', async () => {
    const page = await pageOn({
      [B]: '<form action="/s" method="get"><input name="q" type="text"></form>',
      [`${B}/s?q=abc`]: '<h1>Found</h1>',
    });
    await page.goto(B);
    await page.fill('input', 'abc');
    await page.press('input', 'Enter');
    expect(await page.textContent('h1')).toBe('Found');
  });

  it('includes a checked checkbox and omits an unchecked one', async () => {
    const page = await pageOn({
      [B]: '<form action="/s" method="get"><input name="a" type="checkbox"><input name="b" type="checkbox"><button type=submit>Go</button></form>',
      [`${B}/s?a=`]: '<h1>ok</h1>',
    });
    await page.goto(B);
    await page.check('input[name=a]');
    await page.click('button');
    expect(page.url()).toBe(`${B}/s?a=`);
  });

  it('submits via an <input type=submit>', async () => {
    const page = await pageOn({
      [B]: '<form action="/s" method="get"><input name="q" type="text"><input type="submit" value="Go"></form>',
      [`${B}/s?q=z`]: '<h1>ok</h1>',
    });
    await page.goto(B);
    await page.fill('input[type=text]', 'z');
    await page.click('input[type=submit]');
    expect(page.url()).toBe(`${B}/s?q=z`);
  });

  it('submits a selected option', async () => {
    const page = await pageOn({
      [B]: '<form action="/s" method="get"><select name="c"><option value="US">US</option><option value="CA">CA</option></select><button type=submit>Go</button></form>',
      [`${B}/s?c=CA`]: '<h1>ok</h1>',
    });
    await page.goto(B);
    await page.selectOption('select', 'CA');
    await page.click('button');
    expect(page.url()).toBe(`${B}/s?c=CA`);
  });
});

describe('keyboard input', () => {
  it('fill replaces and type appends', async () => {
    const page = await pageOn({ [B]: '<input type="text" name="q">' });
    await page.goto(B);
    await page.fill('input', 'ab');
    await page.type('input', 'cd');
    expect(await page.getAttribute('input', 'value')).toBe('abcd');
  });

  it('refuses to fill a non-field', async () => {
    const page = await pageOn({ [B]: '<div>x</div>' });
    await page.goto(B);
    await expect(page.fill('div', 'x')).rejects.toMatchObject({
      code: 'NOT_INTERACTABLE',
    });
  });

  it('fills a textarea, updating its text', async () => {
    const page = await pageOn({ [B]: '<textarea name="body"></textarea>' });
    await page.goto(B);
    await page.fill('textarea', 'hello');
    expect(await page.getAttribute('textarea', 'value')).toBe('hello');
  });

  it('refuses to type into a non-field', async () => {
    const page = await pageOn({ [B]: '<div>x</div>' });
    await page.goto(B);
    await expect(page.type('div', 'x')).rejects.toMatchObject({
      code: 'NOT_INTERACTABLE',
    });
  });

  it('a non-Enter key press is a no-op', async () => {
    const page = await pageOn({ [B]: '<input type="text">' });
    await page.goto(B);
    await expect(page.press('input', 'Tab')).resolves.toBeUndefined();
  });

  it('rejects selecting on a non-select and clicking a plain element is a no-op', async () => {
    const page = await pageOn({ [B]: '<div id="d">x</div><span id="s">y</span>' });
    await page.goto(B);
    await expect(page.selectOption('#d', 'x')).rejects.toMatchObject({
      code: 'NOT_INTERACTABLE',
    });
    await expect(page.click('#s')).resolves.toBeUndefined();
  });
});

describe('waits', () => {
  it('resolves immediately for a present, visible element', async () => {
    const page = await pageOn({ [B]: '<div id="ready">x</div>' });
    await page.goto(B);
    await expect(page.waitForSelector('#ready')).resolves.toBeUndefined();
  });

  it('waits out a delayed appearance using virtual time', async () => {
    const page = await pageOn({
      [B]: '<div id="late" data-fk-appear-after="500">soon</div>',
    });
    await page.goto(B);
    // Not visible yet, but appears within the timeout — resolves without real delay.
    expect(await page.isVisible('#late')).toBe(false);
    await expect(
      page.waitForSelector('#late', { timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });

  it('times out when the element never appears', async () => {
    const page = await pageOn({ [B]: '<p>x</p>' });
    await page.goto(B);
    await expect(
      page.waitForSelector('#never', { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('times out when a delayed element appears too late', async () => {
    const page = await pageOn({
      [B]: '<div id="late" data-fk-appear-after="5000">x</div>',
    });
    await page.goto(B);
    await expect(
      page.waitForSelector('#late', { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('finds a hidden element with state "attached"', async () => {
    const page = await pageOn({ [B]: '<div id="h" hidden>x</div>' });
    await page.goto(B);
    await expect(
      page.waitForSelector('#h', { state: 'attached' }),
    ).resolves.toBeUndefined();
    await expect(
      page.waitForSelector('#h', { state: 'visible', timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('dialogs', () => {
  it('passes a dialog to a registered handler', async () => {
    const page = await pageOn({
      [B]: '<button data-fk-dialog="confirm:Delete this?">del</button>',
    });
    await page.goto(B);
    let seen: Dialog | undefined;
    page.onDialog((d) => {
      seen = d;
      void d.accept();
    });
    await page.click('button');
    expect(seen?.type).toBe('confirm');
    expect(seen?.message).toBe('Delete this?');
  });

  it('auto-dismisses a dialog with no handler', async () => {
    const page = await pageOn({ [B]: '<button data-fk-dialog="alert:hi">a</button>' });
    await page.goto(B);
    await expect(page.click('button')).resolves.toBeUndefined();
  });

  it('recognises a prompt dialog and a bare (default confirm) dialog', async () => {
    const page = await pageOn({
      [B]: '<button id="p" data-fk-dialog="prompt:Name?">p</button><button id="d" data-fk-dialog="whatever">d</button>',
    });
    await page.goto(B);
    const seen: string[] = [];
    page.onDialog((d) => {
      seen.push(d.type);
      void d.dismiss();
    });
    await page.click('#p');
    await page.click('#d');
    expect(seen).toEqual(['prompt', 'confirm']);
  });
});

describe('downloads', () => {
  it('captures a download triggered by a click', async () => {
    const page = await pageOn({
      [B]: '<a href="/file.txt" download="report.txt">get</a>',
      [`${B}/file.txt`]: {
        body: 'file contents',
        headers: { 'content-type': 'text/plain' },
      },
    });
    await page.goto(B);
    const download = await page.waitForDownload(() => page.click('a'));
    expect(download.suggestedFilename).toBe('report.txt');
    expect(new TextDecoder().decode(await download.content())).toBe('file contents');
  });

  it('errors when the trigger starts no download', async () => {
    const page = await pageOn({ [B]: '<button>x</button>' });
    await page.goto(B);
    await expect(
      page.waitForDownload(() => page.click('button')),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });

  it('derives the filename from the href when download has no value', async () => {
    const page = await pageOn({
      [B]: '<a href="/files/data.csv" download>get</a>',
      [`${B}/files/data.csv`]: 'a,b',
    });
    await page.goto(B);
    const download = await page.waitForDownload(() => page.click('a'));
    expect(download.suggestedFilename).toBe('data.csv');
  });

  it('fails a download when the fetch errors', async () => {
    const page = await pageOn({
      [B]: '<a href="/broken" download="x">get</a>',
      [`${B}/broken`]: { fail: true },
    });
    await page.goto(B);
    await expect(page.waitForDownload(() => page.click('a'))).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
    });
  });

  it('a download click outside waitForDownload does not throw', async () => {
    const page = await pageOn({
      [B]: '<a href="/f.txt" download>x</a>',
      [`${B}/f.txt`]: 'hi',
    });
    await page.goto(B);
    await expect(page.click('a')).resolves.toBeUndefined();
  });
});

describe('uploads', () => {
  it('attaches files and submits their names', async () => {
    const page = await pageOn({
      [B]: '<form action="/up" method="get"><input type="file" name="f"><button type=submit>Go</button></form>',
      [`${B}/up?f=a.txt`]: '<h1>uploaded</h1>',
    });
    await page.goto(B);
    await page.setInputFiles('input[type=file]', [
      {
        name: 'a.txt',
        mimeType: 'text/plain',
        content: new TextEncoder().encode('hi'),
      },
    ]);
    await page.click('button');
    expect(page.url()).toBe(`${B}/up?f=a.txt`);
  });

  it('rejects a non-file input', async () => {
    const page = await pageOn({ [B]: '<input type="text">' });
    await page.goto(B);
    await expect(page.setInputFiles('input', [])).rejects.toMatchObject({
      code: 'UPLOAD_FAILED',
    });
  });
});

describe('screenshots', () => {
  it('returns deterministic bytes with a PNG signature', async () => {
    const page = await pageOn({ [B]: '<h1>x</h1>' });
    await page.goto(B);
    const a = await page.screenshot();
    const b = await page.screenshot();
    expect(a.slice(0, 4)).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    expect(a).toEqual(b);
  });

  it('differs for different content and supports a selector', async () => {
    const page = await pageOn({ [B]: '<h1>a</h1><h2>b</h2>' });
    await page.goto(B);
    const full = await page.screenshot();
    const part = await page.screenshot({ selector: 'h2' });
    expect(part).not.toEqual(full);
  });
});

describe('tabs and contexts', () => {
  it('opens a target=_blank link in a new tab, leaving the current one', async () => {
    const browser = new FakeBrowser({
      http: site({
        [B]: '<a href="/other" target="_blank">open</a>',
        [`${B}/other`]: '<h1>Other</h1>',
      }),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(B);
    await page.click('a');
    expect(context.pages()).toHaveLength(2);
    // The original page did not navigate.
    expect(page.url()).toBe(`${B}/`);
  });

  it('exposes an (empty) cookie jar per context', async () => {
    const browser = new FakeBrowser({ http: site({ [B]: '<h1>x</h1>' }) });
    const context = await browser.newContext();
    expect(await context.cookies()).toEqual([]);
  });

  it('isolates pages across contexts', async () => {
    const browser = new FakeBrowser({ http: site({ [B]: '<h1>x</h1>' }) });
    const c1 = await browser.newContext();
    const c2 = await browser.newContext();
    await (await c1.newPage()).goto(B);
    expect(c1.pages()).toHaveLength(1);
    expect(c2.pages()).toHaveLength(0);
  });

  it('closing the browser closes contexts and pages', async () => {
    const browser = new FakeBrowser({ http: site({ [B]: '<h1>x</h1>' }) });
    const context = await browser.newContext();
    const page = await context.newPage();
    await browser.close();
    expect(() => page.url()).not.toThrow();
    await expect(page.goto(B)).rejects.toMatchObject({ code: 'TARGET_CLOSED' });
  });
});

describe('cancellation', () => {
  it('aborts a navigation when the signal is already aborted', async () => {
    const page = await pageOn({ [B]: '<h1>x</h1>' });
    await expect(page.goto(B, { signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it('aborts a wait when the signal fires', async () => {
    const page = await pageOn({ [B]: '<p>x</p>' });
    await page.goto(B);
    await expect(
      page.waitForSelector('#never', { signal: AbortSignal.abort(), timeoutMs: 1000 }),
    ).rejects.toThrow();
  });

  it('rejects using a closed page', async () => {
    const page = await pageOn({ [B]: '<h1>x</h1>' });
    await page.close();
    expect(() => new BrowserError('TARGET_CLOSED', 'x')).not.toThrow();
    await expect(page.goto(B)).rejects.toMatchObject({ code: 'TARGET_CLOSED' });
  });
});
