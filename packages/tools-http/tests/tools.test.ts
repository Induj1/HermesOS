/**
 * The HTTP tools, against a fake client.
 *
 * `callTool` runs the input schema first, so these test the tools as a model
 * reaches them. The fake client records the request, which is what the header and
 * method tests assert on.
 */

import { describe, expect, it } from 'vitest';
import { auditTool, callTool, PermissionSet, withPermissions } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';
import { httpTools } from '../src/tools.js';
import { guarded } from '../src/client.js';
import { FakeHttpClient } from '../src/fake-client.js';
import { PermissionDeniedError } from '@hermes/tools';

/** The first tool of a set, guarded — the linter forbids a bare `[0]!` or cast. */
const firstTool = (built: readonly HermesTool[]): HermesTool => {
  const [tool] = built;
  if (tool === undefined) throw new Error('expected at least one tool');
  return tool;
};

const tools = (
  client: FakeHttpClient = FakeHttpClient.respondingWith('ok'),
  options = {},
) => {
  const built = httpTools(guarded(client, { policy: {} }), options);
  const get = built[0];
  const request = built[1];
  if (get === undefined || request === undefined) throw new Error('missing tool');
  return { client, get, request };
};

describe('declarations', () => {
  it.each(
    httpTools(FakeHttpClient.respondingWith('ok'), {}).map((t) => [t.name, t] as const),
  )('%s passes auditTool', (_name, tool) => {
    expect(auditTool(tool)).toEqual([]);
  });

  // The read/write split is the reason there are two tools.
  it('splits read and write across permissions', () => {
    const { get, request } = tools();

    expect(get.permissions).toEqual(['net:read']);
    expect(request.permissions).toEqual(['net:write']);
  });

  it('marks GET idempotent and request not', () => {
    const { get, request } = tools();

    expect(get.idempotent).toBe(true);
    expect(request.idempotent).toBe(false);
  });
});

describe('http.get', () => {
  it('fetches a URL and returns the response', async () => {
    const client = new FakeHttpClient({
      handle: () => ({
        status: 200,
        statusText: 'OK',
        body: '{"ok":true}',
        headers: { 'content-type': 'application/json' },
      }),
    });

    const result = await callTool(tools(client).get, {
      url: 'https://api.example.com/status',
    });

    expect(result).toMatchObject({
      status: 200,
      body: '{"ok":true}',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('is a GET', async () => {
    const client = FakeHttpClient.respondingWith('');

    await callTool(tools(client).get, { url: 'https://example.com/' });

    expect(client.requests[0]?.method).toBe('GET');
  });

  it('passes headers through', async () => {
    const client = FakeHttpClient.respondingWith('');

    await callTool(tools(client).get, {
      url: 'https://example.com/',
      headers: { authorization: 'Bearer x' },
    });

    expect(client.requests[0]?.headers).toEqual({ authorization: 'Bearer x' });
  });

  // A model may send a non-string header value; it is coerced, not rejected.
  it('coerces a numeric header value rather than failing', async () => {
    const client = FakeHttpClient.respondingWith('');

    await callTool(tools(client).get, {
      url: 'https://example.com/',
      headers: { 'x-count': 5 },
    });

    expect(client.requests[0]?.headers).toEqual({ 'x-count': '5' });
  });

  it('drops a header value that cannot be a string', async () => {
    const client = FakeHttpClient.respondingWith('');

    await callTool(tools(client).get, {
      url: 'https://example.com/',
      headers: { good: 'yes', bad: { nested: true } },
    });

    expect(client.requests[0]?.headers).toEqual({ good: 'yes' });
  });

  // A 4xx is a normal result an agent reasons about, not an exception.
  it('returns a 404 as a result', async () => {
    const result = await callTool(
      tools(FakeHttpClient.respondingWith('gone', 404)).get,
      {
        url: 'https://example.com/x',
      },
    );

    expect(result).toMatchObject({ status: 404, body: 'gone' });
  });

  it('reports a truncated body', async () => {
    const client = new FakeHttpClient({
      handle: () => ({ body: 'partial', truncated: true }),
    });

    const result = await callTool(tools(client).get, { url: 'https://example.com/' });

    expect(result).toMatchObject({ truncated: true });
  });

  it('rejects a blocked URL', async () => {
    const get = firstTool(
      httpTools(
        guarded(FakeHttpClient.respondingWith(''), { policy: { blockPrivate: true } }),
      ),
    );

    await expect(
      callTool(get, { url: 'http://169.254.169.254/' }),
    ).rejects.toMatchObject({
      code: 'BLOCKED',
    });
  });

  it('rejects a missing url', async () => {
    await expect(callTool(tools().get, {})).rejects.toThrow(/"url" is required/);
  });
});

describe('http.request', () => {
  it('posts with a body', async () => {
    const client = FakeHttpClient.respondingWith('created', 201);

    const result = await callTool(tools(client).request, {
      url: 'https://api.example.com/items',
      method: 'POST',
      body: '{"name":"x"}',
    });

    expect(client.requests[0]).toMatchObject({ method: 'POST', body: '{"name":"x"}' });
    expect(result).toMatchObject({ status: 201 });
  });

  it('defaults to GET', async () => {
    const client = FakeHttpClient.respondingWith('');

    await callTool(tools(client).request, { url: 'https://example.com/' });

    expect(client.requests[0]?.method).toBe('GET');
  });

  it('rejects a method the schema does not allow', async () => {
    await expect(
      callTool(tools().request, { url: 'https://example.com/', method: 'TRACE' }),
    ).rejects.toThrow(/must be one of/);
  });
});

describe('caps', () => {
  it('caps a model timeout to the host limit', async () => {
    const client = FakeHttpClient.respondingWith('');
    const get = firstTool(
      httpTools(guarded(client, { policy: {} }), { timeoutMs: 1_000 }),
    );

    await callTool(get, {
      url: 'https://example.com/',
      timeoutMs: 999_999,
    });

    expect(client.requests[0]?.timeoutMs).toBe(1_000);
  });

  it('applies the host byte cap', async () => {
    const client = FakeHttpClient.respondingWith('');
    const get = firstTool(
      httpTools(guarded(client, { policy: {} }), { maxBytes: 2_048 }),
    );

    await callTool(get, { url: 'https://example.com/' });

    expect(client.requests[0]?.maxBytes).toBe(2_048);
  });

  it("uses the model's timeout when the host set no limit", async () => {
    const client = FakeHttpClient.respondingWith('');
    const get = firstTool(httpTools(guarded(client, { policy: {} })));

    await callTool(get, {
      url: 'https://example.com/',
      timeoutMs: 3_000,
    });

    expect(client.requests[0]?.timeoutMs).toBe(3_000);
  });

  it('leaves the timeout unset when neither model nor host set one', async () => {
    const client = FakeHttpClient.respondingWith('');

    await callTool(tools(client).get, { url: 'https://example.com/' });

    expect(client.requests[0]?.timeoutMs).toBeUndefined();
  });
});

describe('permissions', () => {
  it('lets http.get through a net:read grant', async () => {
    const get = withPermissions(tools().get, PermissionSet.none().grant('net:read'));

    await expect(callTool(get, { url: 'https://example.com/' })).resolves.toMatchObject(
      {
        status: 200,
      },
    );
  });

  it('refuses http.request under a net:read-only grant', async () => {
    const request = withPermissions(
      tools().request,
      PermissionSet.none().grant('net:read'),
    );

    await expect(
      callTool(request, { url: 'https://example.com/', method: 'POST' }),
    ).rejects.toThrow(PermissionDeniedError);
  });
});
