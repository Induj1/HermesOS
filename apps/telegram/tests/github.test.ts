import { callTool } from '@hermes/tools';
import { FakeHttpClient } from '@hermes/tools-http';
import { describe, expect, it } from 'vitest';
import { githubTools } from '../src/github.js';

function tool(http: FakeHttpClient, name: string) {
  const found = githubTools(http, 'tok').find((t) => t.name === name);
  if (found === undefined) throw new Error(`missing ${name}`);
  return found;
}
const json = (body: unknown, status = 200) =>
  new FakeHttpClient({ handle: () => ({ status, body: JSON.stringify(body) }) });

describe('githubTools', () => {
  it('summarises a repo, tolerating a null description', async () => {
    const http = json({
      full_name: 'a/b',
      description: null,
      stargazers_count: 5,
      forks_count: 2,
      open_issues_count: 1,
    });
    const out = (await callTool(tool(http, 'github.repo'), { repo: 'a/b' })) as string;
    expect(out).toContain('a/b');
    expect(out).toContain('⭐ 5');
  });

  it('lists issues and reports emptiness', async () => {
    const withIssues = json([{ number: 7, title: 'bug', html_url: 'u' }]);
    expect(
      await callTool(tool(withIssues, 'github.issues'), { repo: 'a/b' }),
    ).toContain('#7 bug');

    const empty = json([]);
    expect(await callTool(tool(empty, 'github.issues'), { repo: 'a/b' })).toBe(
      'No open issues.',
    );
  });

  it('creates an issue and surfaces API errors', async () => {
    const ok = json({ number: 9, title: 't', html_url: 'https://x/9' }, 201);
    expect(
      await callTool(tool(ok, 'github.createIssue'), {
        repo: 'a/b',
        title: 't',
        body: '',
      }),
    ).toContain('#9');

    const bad = new FakeHttpClient({ handle: () => ({ status: 404, body: 'nope' }) });
    await expect(callTool(tool(bad, 'github.repo'), { repo: 'a/b' })).rejects.toThrow(
      /GitHub/,
    );
  });
});
