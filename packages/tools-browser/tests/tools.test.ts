/**
 * The browser tools, driven through the port against a fake browser.
 *
 * Each tool is exercised end to end: a session over a `FakeBrowser` whose pages
 * are served through a real HTTP client. The tools' job is to translate a
 * validated request into a port call and shape the result, so these assert both.
 */

import { describe, expect, it } from 'vitest';
import { auditTool, callTool } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';
import { browserTools } from '../src/tools.js';
import { BrowserSession } from '../src/session.js';
import { FakeBrowser } from '../src/fake-browser.js';
import { site } from './support.js';

const B = 'https://ex.dev';

function toolsOn(routes: Parameters<typeof site>[0]): Map<string, HermesTool> {
  const session = new BrowserSession(new FakeBrowser({ http: site(routes) }));
  return new Map(browserTools(session).map((t) => [t.name, t]));
}

const get = (tools: Map<string, HermesTool>, name: string): HermesTool => {
  const t = tools.get(name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};

describe('declaration', () => {
  it('every tool passes auditTool', () => {
    for (const t of toolsOn({}).values()) expect(auditTool(t), t.name).toEqual([]);
  });

  it('splits permissions into read, navigate, and interact', () => {
    const tools = toolsOn({});
    expect(get(tools, 'browser.content').permissions).toEqual(['browser:read']);
    expect(get(tools, 'browser.navigate').permissions).toEqual(['browser:navigate']);
    expect(get(tools, 'browser.click').permissions).toEqual(['browser:interact']);
  });
});

describe('navigation and reading', () => {
  it('navigates and reads title, content, and text', async () => {
    const tools = toolsOn({
      [B]: '<html><head><title>T</title></head><body><h1>Head</h1></body></html>',
    });
    const nav = await callTool(get(tools, 'browser.navigate'), { url: B });
    expect(nav).toMatchObject({ url: `${B}/`, status: 200, redirects: 0 });
    expect(await callTool(get(tools, 'browser.title'), {})).toEqual({ title: 'T' });
    expect(await callTool(get(tools, 'browser.text'), { selector: 'h1' })).toEqual({
      text: 'Head',
    });
    expect(
      ((await callTool(get(tools, 'browser.content'), {})) as { html: string }).html,
    ).toContain('<h1>');
  });

  it('reads an attribute and visibility', async () => {
    const tools = toolsOn({
      [B]: '<a href="/x" id="lnk">go</a><div id="h" hidden>x</div>',
    });
    await callTool(get(tools, 'browser.navigate'), { url: B });
    expect(
      await callTool(get(tools, 'browser.attribute'), {
        selector: '#lnk',
        name: 'href',
      }),
    ).toEqual({ value: '/x' });
    expect(await callTool(get(tools, 'browser.visible'), { selector: '#h' })).toEqual({
      visible: false,
    });
  });

  it('waits for a selector', async () => {
    const tools = toolsOn({ [B]: '<div id="r" data-fk-appear-after="200">x</div>' });
    await callTool(get(tools, 'browser.navigate'), { url: B });
    expect(
      await callTool(get(tools, 'browser.waitFor'), {
        selector: '#r',
        timeoutMs: 1000,
      }),
    ).toEqual({ found: true });
  });

  it('captures a screenshot as base64, of the page or an element', async () => {
    const tools = toolsOn({ [B]: '<h1>x</h1><h2>y</h2>' });
    await callTool(get(tools, 'browser.navigate'), { url: B });
    const full = (await callTool(get(tools, 'browser.screenshot'), {})) as {
      base64: string;
    };
    expect(Buffer.from(full.base64, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const el = (await callTool(get(tools, 'browser.screenshot'), {
      selector: 'h2',
    })) as { base64: string };
    expect(el.base64).not.toBe(full.base64);
  });

  it('waits with the default timeout when none is given', async () => {
    const tools = toolsOn({ [B]: '<div id="r">x</div>' });
    await callTool(get(tools, 'browser.navigate'), { url: B });
    expect(await callTool(get(tools, 'browser.waitFor'), { selector: '#r' })).toEqual({
      found: true,
    });
  });
});

describe('interaction', () => {
  it('fills, types, and clicks through a form', async () => {
    const tools = toolsOn({
      [B]: '<form action="/s" method="get"><input name="q" type="text"><button type=submit>Go</button></form>',
      [`${B}/s?q=hello`]: '<h1>Results</h1>',
    });
    await callTool(get(tools, 'browser.navigate'), { url: B });
    await callTool(get(tools, 'browser.fill'), { selector: 'input', value: 'hel' });
    await callTool(get(tools, 'browser.type'), { selector: 'input', text: 'lo' });
    const clicked = (await callTool(get(tools, 'browser.click'), {
      selector: 'button',
    })) as { url: string };
    expect(clicked.url).toBe(`${B}/s?q=hello`);
    expect(await callTool(get(tools, 'browser.text'), { selector: 'h1' })).toEqual({
      text: 'Results',
    });
  });

  it('presses Enter to submit', async () => {
    const tools = toolsOn({
      [B]: '<form action="/s" method="get"><input name="q" type="text"></form>',
      [`${B}/s?q=x`]: '<h1>ok</h1>',
    });
    await callTool(get(tools, 'browser.navigate'), { url: B });
    await callTool(get(tools, 'browser.fill'), { selector: 'input', value: 'x' });
    const res = (await callTool(get(tools, 'browser.press'), {
      selector: 'input',
      key: 'Enter',
    })) as { url: string };
    expect(res.url).toBe(`${B}/s?q=x`);
  });

  it('selects, checks, and uploads', async () => {
    const tools = toolsOn({
      [B]: '<select id="c"><option value="US">US</option></select><input id="t" type="checkbox"><input id="f" type="file" name="f">',
    });
    await callTool(get(tools, 'browser.navigate'), { url: B });
    expect(
      await callTool(get(tools, 'browser.select'), { selector: '#c', value: 'US' }),
    ).toEqual({ ok: true });
    expect(await callTool(get(tools, 'browser.check'), { selector: '#t' })).toEqual({
      ok: true,
    });
    expect(
      await callTool(get(tools, 'browser.upload'), {
        selector: '#f',
        files: [{ name: 'a.txt', contentBase64: Buffer.from('hi').toString('base64') }],
      }),
    ).toEqual({ ok: true });
  });
});

describe('tabs', () => {
  it('opens, lists, and switches tabs', async () => {
    const tools = toolsOn({ [B]: '<h1>one</h1>', [`${B}/2`]: '<h1>two</h1>' });
    await callTool(get(tools, 'browser.navigate'), { url: B });
    await callTool(get(tools, 'browser.newTab'), { url: `${B}/2` });

    const listed = (await callTool(get(tools, 'browser.listTabs'), {})) as {
      tabs: { index: number; active: boolean }[];
    };
    expect(listed.tabs).toHaveLength(2);

    expect(await callTool(get(tools, 'browser.switchTab'), { index: 0 })).toEqual({
      active: 0,
    });
  });
});

describe('back and reload', () => {
  it('navigates back', async () => {
    const tools = toolsOn({ [`${B}/1`]: '<h1>one</h1>', [`${B}/2`]: '<h1>two</h1>' });
    await callTool(get(tools, 'browser.navigate'), { url: `${B}/1` });
    await callTool(get(tools, 'browser.navigate'), { url: `${B}/2` });
    const back = (await callTool(get(tools, 'browser.back'), {})) as { url: string };
    expect(back.url).toBe(`${B}/1`);
  });

  it('reloads', async () => {
    const tools = toolsOn({ [B]: '<h1>x</h1>' });
    await callTool(get(tools, 'browser.navigate'), { url: B });
    expect(
      ((await callTool(get(tools, 'browser.reload'), {})) as { url: string }).url,
    ).toBe(`${B}/`);
  });
});
