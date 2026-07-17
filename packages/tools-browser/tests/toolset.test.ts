/**
 * The browser toolset on a real kernel: registration and the permission split.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Runtime, sequentialIds } from '@hermes/kernel';
import { catalog, PermissionSet } from '@hermes/tools';
import { browserToolset } from '../src/toolset.js';
import { FakeBrowser } from '../src/fake-browser.js';
import { site } from './support.js';

const B = 'https://ex.dev';
let runtime: Runtime | undefined;

afterEach(async () => {
  await runtime?.stop({ mode: 'cancel' });
  runtime = undefined;
});

const start = async (granted?: PermissionSet): Promise<Runtime> => {
  runtime = Runtime.create({ ids: sequentialIds() });
  runtime.use(
    browserToolset({
      browser: new FakeBrowser({
        http: site({ [B]: '<h1>Hi</h1><button>b</button>' }),
      }),
      ...(granted === undefined ? {} : { granted }),
    }),
  );
  await runtime.start();
  return runtime;
};

describe('browserToolset on a real runtime', () => {
  it('registers the tools, tagged, and navigates + reads by default', async () => {
    const rt = await start();
    const described = catalog(rt.tools);
    expect(described.map((t) => t.name)).toContain('browser.navigate');
    expect(described.every((t) => t.tags?.includes('browser'))).toBe(true);

    const snapshot = await rt.run({
      name: 'browse',
      tasks: [
        {
          name: 'nav',
          handler: { kind: 'tool', name: 'browser.navigate' },
          input: { url: B },
        },
        { name: 'read', handler: { kind: 'tool', name: 'browser.title' }, input: {} },
      ],
    });
    expect(snapshot.tasks[0]?.result).toMatchObject({ url: `${B}/`, status: 200 });
  });

  it('refuses interaction with the default grant', async () => {
    const rt = await start();
    const snapshot = await rt.run({
      name: 'click',
      tasks: [
        {
          name: 'c',
          handler: { kind: 'tool', name: 'browser.click' },
          input: { selector: 'button' },
        },
      ],
    });
    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /requires the "browser:interact" permission/,
    );
  });

  it('allows interaction once browser:interact is granted', async () => {
    const rt = await start(
      PermissionSet.none()
        .grant('browser:read')
        .grant('browser:navigate')
        .grant('browser:interact'),
    );
    // Two missions so the click runs after the navigation completes; the toolset's
    // session persists across missions, so the second acts on the loaded page.
    await rt.run({
      name: 'nav',
      tasks: [
        {
          name: 'nav',
          handler: { kind: 'tool', name: 'browser.navigate' },
          input: { url: B },
        },
      ],
    });
    const snapshot = await rt.run({
      name: 'click',
      tasks: [
        {
          name: 'click',
          handler: { kind: 'tool', name: 'browser.click' },
          input: { selector: 'button' },
        },
      ],
    });
    expect(snapshot.tasks[0]?.error).toBeUndefined();
  });
});
