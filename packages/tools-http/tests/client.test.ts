/**
 * The guard's redirect loop — where SSRF protection meets redirects.
 *
 * The scripted `FakeHttpClient` is what makes the important test possible: a
 * redirect *to a blocked host*. That is the attack — an allowed host answering
 * `302 Location: http://169.254.169.254/` — and against a real server you cannot
 * conjure it on demand. Here it is one line of script.
 */

import { describe, expect, it, vi } from 'vitest';
import { guarded } from '../src/client.js';
import { FakeHttpClient } from '../src/fake-client.js';
import { BlockedError, HttpError } from '../src/errors.js';

describe('policy enforcement', () => {
  it('allows a request to a permitted host', async () => {
    const client = guarded(FakeHttpClient.respondingWith('ok'), {
      policy: { allowlist: ['api.example.com'] },
    });

    const response = await client.request({ url: 'https://api.example.com/x' });

    expect(response.body).toBe('ok');
  });

  it('refuses a blocked host before making the request', async () => {
    const inner = FakeHttpClient.respondingWith('ok');
    const spy = vi.spyOn(inner, 'request');
    const client = guarded(inner, { policy: { allowlist: ['api.example.com'] } });

    await expect(client.request({ url: 'https://evil.com' })).rejects.toThrow(
      BlockedError,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('redirects', () => {
  it('follows a redirect to an allowed host', async () => {
    const client = guarded(
      new FakeHttpClient({
        handle: (req) =>
          req.url === 'https://a.example.com/'
            ? { status: 302, headers: { location: 'https://b.example.com/' } }
            : { status: 200, body: 'final' },
      }),
      { policy: { allowlist: ['a.example.com', 'b.example.com'] } },
    );

    const response = await client.request({ url: 'https://a.example.com/' });

    expect(response.body).toBe('final');
    expect(response.url).toBe('https://b.example.com/');
    expect(response.redirects).toBe(1);
  });

  // THE test. A redirect that would cross the SSRF boundary is caught, because
  // the guard re-checks every hop.
  it('refuses a redirect to a blocked host', async () => {
    const client = guarded(
      new FakeHttpClient({
        handle: () => ({
          status: 302,
          headers: { location: 'http://169.254.169.254/' },
        }),
      }),
      { policy: { allowlist: ['api.example.com'], blockPrivate: true } },
    );

    await expect(
      client.request({ url: 'https://api.example.com/' }),
    ).rejects.toMatchObject({
      code: 'BLOCKED',
    });
  });

  it('resolves a relative redirect before re-checking it', async () => {
    const seen: string[] = [];
    const client = guarded(
      new FakeHttpClient({
        handle: (req) => {
          seen.push(req.url);
          return req.url.endsWith('/login')
            ? { status: 200, body: 'login page' }
            : { status: 302, headers: { location: '/login' } };
        },
      }),
      { policy: { allowlist: ['app.example.com'] } },
    );

    const response = await client.request({ url: 'https://app.example.com/dashboard' });

    expect(seen).toEqual([
      'https://app.example.com/dashboard',
      'https://app.example.com/login',
    ]);
    expect(response.body).toBe('login page');
  });

  it('gives up after too many redirects', async () => {
    const client = guarded(
      new FakeHttpClient({
        handle: () => ({
          status: 302,
          headers: { location: 'https://a.example.com/' },
        }),
      }),
      { policy: { allowlist: ['a.example.com'] }, maxRedirects: 3 },
    );

    const promise = client.request({ url: 'https://a.example.com/' });

    await expect(promise).rejects.toThrow(HttpError);
    await expect(promise).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
  });

  // 303 turns the follow-up into a GET with no body — the POST-redirect-GET
  // pattern. A guard that kept the method and body would re-POST to the new URL.
  it('turns a 303 into a GET and drops the body', async () => {
    const methods: string[] = [];
    const client = guarded(
      new FakeHttpClient({
        handle: (req) => {
          methods.push(req.method ?? 'GET');
          return req.url.endsWith('/result')
            ? { status: 200, body: 'done' }
            : { status: 303, headers: { location: '/result' } };
        },
      }),
      { policy: { allowlist: ['app.example.com'] } },
    );

    await client.request({
      url: 'https://app.example.com/submit',
      method: 'POST',
      body: 'data',
    });

    expect(methods).toEqual(['POST', 'GET']);
  });

  // 307 preserves the method and body — its entire reason to exist.
  it('preserves method and body across a 307', async () => {
    const requests: { method: string; body?: string }[] = [];
    const client = guarded(
      new FakeHttpClient({
        handle: (req) => {
          requests.push({
            method: req.method ?? 'GET',
            ...(req.body === undefined ? {} : { body: req.body }),
          });
          return req.url.endsWith('/moved')
            ? { status: 200, body: 'ok' }
            : { status: 307, headers: { location: '/moved' } };
        },
      }),
      { policy: { allowlist: ['app.example.com'] } },
    );

    await client.request({
      url: 'https://app.example.com/api',
      method: 'POST',
      body: 'payload',
    });

    expect(requests).toEqual([
      { method: 'POST', body: 'payload' },
      { method: 'POST', body: 'payload' },
    ]);
  });

  it('does not treat a 200 as a redirect even with a stray location header', async () => {
    const client = guarded(
      new FakeHttpClient({
        handle: () => ({
          status: 200,
          body: 'here',
          headers: { location: '/elsewhere' },
        }),
      }),
      { policy: {} },
    );

    const response = await client.request({ url: 'https://example.com/' });

    expect(response.body).toBe('here');
    expect(response.redirects).toBe(0);
  });
});

describe('passing through', () => {
  it('reports a non-2xx status as a normal response', async () => {
    const client = guarded(FakeHttpClient.respondingWith('not found', 404), {
      policy: {},
    });

    const response = await client.request({ url: 'https://example.com/missing' });

    expect(response.status).toBe(404);
    expect(response.body).toBe('not found');
  });

  it('carries the method and body to the inner client', async () => {
    const inner = new FakeHttpClient({ handle: () => ({ status: 201 }) });
    const client = guarded(inner, { policy: {} });

    await client.request({ url: 'https://example.com/', method: 'post', body: '{}' });

    // Uppercased, and passed through.
    expect(inner.requests[0]).toMatchObject({ method: 'POST', body: '{}' });
  });
});
