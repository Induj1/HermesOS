/**
 * The toolset's defaults, and the edges the happy path misses.
 *
 * The defaults are load-bearing security posture: SSRF protection on, read-only.
 * A host that forgets to pass a policy must still be safe, so the defaults are
 * tested directly rather than assumed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Runtime, sequentialIds } from '@hermes/kernel';
import { PermissionSet } from '@hermes/tools';
import { httpToolset } from '../src/toolset.js';
import { httpTools } from '../src/tools.js';
import type { HermesTool } from '@hermes/tools';
import { guarded } from '../src/client.js';
import { FakeHttpClient } from '../src/fake-client.js';

let runtime: Runtime | undefined;

afterEach(async () => {
  await runtime?.stop({ mode: 'cancel' });
  runtime = undefined;
});

describe('default posture', () => {
  // The most important default: with no policy given, SSRF protection is on.
  it('blocks a private address by default', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      httpToolset({
        client: FakeHttpClient.respondingWith('secret'),
        granted: PermissionSet.none().grant('net:read'),
      }),
    );
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'ssrf',
      tasks: [
        {
          name: 's',
          handler: { kind: 'tool', name: 'http.get' },
          input: { url: 'http://169.254.169.254/latest/meta-data/' },
        },
      ],
    });

    // The metadata endpoint is refused even though nothing set a policy.
    expect(snapshot.tasks[0]?.error?.message).toMatch(/private or loopback/);
  });

  // The other important default: read-only.
  it('grants only net:read by default', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      httpToolset({
        client: FakeHttpClient.respondingWith('ok'),
        policy: { blockPrivate: false },
      }),
    );
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'write',
      tasks: [
        {
          name: 'w',
          handler: { kind: 'tool', name: 'http.request' },
          input: { url: 'https://example.com/', method: 'POST' },
        },
      ],
    });

    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /requires the "net:write" permission/,
    );
  });

  it('honours a custom maxRedirects', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      httpToolset({
        client: new FakeHttpClient({
          handle: () => ({
            status: 302,
            headers: { location: 'https://example.com/loop' },
          }),
        }),
        policy: { blockPrivate: false },
        maxRedirects: 1,
        granted: PermissionSet.none().grant('net:read'),
      }),
    );
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'loop',
      tasks: [
        {
          name: 'l',
          handler: { kind: 'tool', name: 'http.get' },
          input: { url: 'https://example.com/' },
        },
      ],
    });

    expect(snapshot.tasks[0]?.error?.message).toMatch(/redirects/);
  });
});

describe('response edges', () => {
  const tool = (client: FakeHttpClient): HermesTool => {
    const [get] = httpTools(guarded(client, { policy: { blockPrivate: false } }));
    if (get === undefined) throw new Error('expected http.get');
    return get;
  };

  it('handles a response with no body (a HEAD-like 204)', async () => {
    const client = new FakeHttpClient({ handle: () => ({ status: 204, body: '' }) });

    const { callTool } = await import('@hermes/tools');
    const result = await callTool(tool(client), { url: 'https://example.com/' });

    expect(result).toMatchObject({ status: 204, body: '' });
  });

  it('ignores headers sent as a non-object', async () => {
    const client = FakeHttpClient.respondingWith('');
    const { callTool } = await import('@hermes/tools');

    // A model sending `headers: "oops"` — coerced to no headers, not a crash.
    await callTool(tool(client), { url: 'https://example.com/', headers: 'oops' });

    expect(client.requests[0]?.headers).toEqual({});
  });
});
