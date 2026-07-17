/**
 * The fake server's own behaviours — the ones tests rely on being faithful.
 */

import { describe, expect, it } from 'vitest';
import { FakeGitHubServer } from '../src/fake-server.js';
import { GitHubClient } from '../src/client.js';
import { verifyWebhookSignature } from '../src/webhooks.js';

describe('FakeGitHubServer', () => {
  it('rejects a request with no User-Agent, as GitHub does', async () => {
    const server = new FakeGitHubServer();
    const res = await server.request({
      url: 'https://api.github.com/x',
      method: 'GET',
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain('User-Agent');
  });

  it('forceNext pre-empts routing for the given count', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r');
    server.forceNext({ status: 503 }, 2);
    const client = new GitHubClient({
      http: server,
      userAgent: 't',
      sleep: () => Promise.resolve(),
    });

    // Two 503s then the real 200.
    const repo = await client.request<{ name: string }>('GET', '/repos/o/r');
    expect(repo.data.name).toBe('r');
    expect(server.requests).toHaveLength(3);
  });

  it('404s an unseeded repository', async () => {
    const server = new FakeGitHubServer();
    const res = await server.request({
      url: 'https://api.github.com/repos/no/repo',
      method: 'GET',
      headers: { 'user-agent': 't' },
    });
    expect(res.status).toBe(404);
  });

  it('404s an unknown path', async () => {
    const server = new FakeGitHubServer();
    const res = await server.request({
      url: 'https://api.github.com/zen',
      method: 'GET',
      headers: { 'user-agent': 't' },
    });
    expect(res.status).toBe(404);
  });

  it('signWebhook produces a signature verifyWebhookSignature accepts', () => {
    const server = new FakeGitHubServer({ webhookSecret: 's3cret' });
    const body = '{"action":"opened"}';
    expect(verifyWebhookSignature(body, server.signWebhook(body), 's3cret')).toBe(true);
  });

  it('answers the installation-token exchange', async () => {
    const server = new FakeGitHubServer();
    const res = await server.request({
      url: 'https://api.github.com/app/installations/5/access_tokens',
      method: 'POST',
      headers: { 'user-agent': 't' },
    });
    expect(res.status).toBe(201);
    const parsed = JSON.parse(res.body) as { token: unknown; expires_at: unknown };
    expect(typeof parsed.token).toBe('string');
    expect(typeof parsed.expires_at).toBe('string');
  });

  it('defaults GraphQL to empty data when no responder is set', async () => {
    const server = new FakeGitHubServer();
    const res = await server.request({
      url: 'https://api.github.com/graphql',
      method: 'POST',
      headers: { 'user-agent': 't' },
      body: '{"query":"{ viewer { login } }"}',
    });
    expect(JSON.parse(res.body)).toEqual({ data: {} });
  });

  it('404s a merge of a non-existent pull request', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r');
    const res = await server.request({
      url: 'https://api.github.com/repos/o/r/pulls/99/merge',
      method: 'PUT',
      headers: { 'user-agent': 't' },
    });
    expect(res.status).toBe(404);
  });

  it('falls back to defaults for a non-numeric per_page/page', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r', { branches: [{ name: 'main' }] });
    const res = await server.request({
      url: 'https://api.github.com/repos/o/r/branches?per_page=abc&page=xyz',
      method: 'GET',
      headers: { 'user-agent': 't' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ name: 'main' }]);
  });

  it('404s an unmatched sub-path under a real repo', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r');
    const res = await server.request({
      url: 'https://api.github.com/repos/o/r/unknown/thing',
      method: 'GET',
      headers: { 'user-agent': 't' },
    });
    expect(res.status).toBe(404);
  });

  it('tolerates an invalid JSON request body', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r');
    // A malformed body parses to undefined rather than throwing; the created
    // issue simply has undefined fields.
    const res = await server.request({
      url: 'https://api.github.com/repos/o/r/issues',
      method: 'POST',
      headers: { 'user-agent': 't' },
      body: '{not json',
    });
    expect(res.status).toBe(201);
  });

  it('404s a write to the repo root', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r');
    const res = await server.request({
      url: 'https://api.github.com/repos/o/r',
      method: 'POST',
      headers: { 'user-agent': 't' },
    });
    expect(res.status).toBe(404);
  });

  it('204s a workflow dispatch', async () => {
    const server = new FakeGitHubServer();
    server.seedRepo('o', 'r');
    const res = await server.request({
      url: 'https://api.github.com/repos/o/r/actions/workflows/ci.yml/dispatches',
      method: 'POST',
      headers: { 'user-agent': 't' },
      body: '{"ref":"main"}',
    });
    expect(res.status).toBe(204);
  });
});
