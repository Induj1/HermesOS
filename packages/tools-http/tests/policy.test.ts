/**
 * The SSRF boundary, tested as the pure function it is.
 *
 * The whole safety argument reduces to "does `checkUrl` ever say ok to a URL it
 * should not" — a question about strings, with no server. `isPrivateHost` gets
 * its own attention because the address ranges are a table, and a table is where
 * one wrong bit hides.
 */

import { describe, expect, it } from 'vitest';
import { checkUrl, isPrivateHost } from '../src/policy.js';

const ok = (url: string, policy = {}): boolean => checkUrl(url, policy).ok;
const reasonFor = (url: string, policy = {}): string => {
  const verdict = checkUrl(url, policy);
  return verdict.ok ? '' : verdict.reason;
};

describe('scheme', () => {
  it('allows http and https', () => {
    expect(ok('http://example.com', { blockPrivate: false })).toBe(true);
    expect(ok('https://example.com', { blockPrivate: false })).toBe(true);
  });

  // The protocol-smuggling vectors SSRF loves.
  it.each([
    'file:///etc/passwd',
    'ftp://example.com',
    'gopher://x',
    'data:text/plain,hi',
  ])('refuses %s', (url) => {
    expect(ok(url, { blockPrivate: false })).toBe(false);
    expect(reasonFor(url, { blockPrivate: false })).toContain('scheme is not allowed');
  });

  it('refuses a string that is not a URL', () => {
    expect(ok('not a url', { blockPrivate: false })).toBe(false);
    expect(reasonFor('not a url', { blockPrivate: false })).toContain(
      'not a valid URL',
    );
  });
});

describe('the allowlist — the strong guarantee', () => {
  it('allows a host on the list', () => {
    expect(ok('https://api.github.com/repos', { allowlist: ['api.github.com'] })).toBe(
      true,
    );
  });

  it('refuses a host not on the list', () => {
    expect(ok('https://evil.com', { allowlist: ['api.github.com'] })).toBe(false);
    expect(reasonFor('https://evil.com', { allowlist: ['api.github.com'] })).toContain(
      'not on the allowlist',
    );
  });

  it('matches case-insensitively', () => {
    expect(ok('https://API.GitHub.com', { allowlist: ['api.github.com'] })).toBe(true);
  });

  it('allows nothing under an empty allowlist', () => {
    expect(ok('https://anything.com', { allowlist: [] })).toBe(false);
    expect(reasonFor('https://anything.com', { allowlist: [] })).toContain(
      'no hosts are allowed',
    );
  });

  // The allowlist is immune to DNS rebinding: a subdomain of an allowed host is
  // still a different host and is refused.
  it('does not allow a subdomain of an allowed host', () => {
    expect(ok('https://evil.api.github.com', { allowlist: ['api.github.com'] })).toBe(
      false,
    );
  });
});

describe('private-address block — the safety net', () => {
  it('is on by default', () => {
    expect(ok('http://127.0.0.1')).toBe(false);
    expect(ok('http://localhost')).toBe(false);
  });

  // The one that matters most: the cloud metadata endpoint that hands out
  // credentials.
  it('blocks the cloud metadata address', () => {
    expect(ok('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(reasonFor('http://169.254.169.254')).toContain('private or loopback');
  });

  it('can be turned off for a context that needs a private address', () => {
    expect(ok('http://127.0.0.1:8080', { blockPrivate: false })).toBe(true);
  });

  it('allows a public host with the block on', () => {
    expect(ok('https://example.com')).toBe(true);
  });
});

describe('isPrivateHost', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback range', '127.5.5.5'],
    ['private 10', '10.0.0.1'],
    ['private 192.168', '192.168.1.1'],
    ['private 172.16', '172.16.0.1'],
    ['private 172.31', '172.31.255.255'],
    ['link-local / metadata', '169.254.169.254'],
    ['unspecified', '0.0.0.0'],
    ['zero range', '0.1.2.3'],
    ['localhost', 'localhost'],
    ['sub.localhost', 'app.localhost'],
    ['ipv6 loopback', '::1'],
    ['ipv6 loopback bracketed', '[::1]'],
    ['ipv6 unique-local', 'fd00::1'],
    ['ipv6 link-local fe80', 'fe80::1'],
    ['ipv6 link-local fe90', 'fe90::1'],
    ['ipv6 link-local fea0', 'fea0::1'],
    ['ipv6 link-local feb0', 'feb0::1'],
    ['ipv6 unspecified', '::'],
    ['empty host', ''],
  ])('flags %s', (_label, host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([
    ['a public v4', '8.8.8.8'],
    ['just outside 172 range', '172.32.0.1'],
    ['not quite 172 range', '172.15.255.255'],
    ['a public host', 'example.com'],
    ['a public v6', '2001:4860:4860::8888'],
  ])('does not flag %s', (_label, host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});
