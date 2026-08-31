/**
 * GitHub tools for the agent — read a repo, list issues, open an issue.
 *
 * Uses the REST API over the injected HttpClient with a token. The API host is
 * public, so the guarded client is fine. Kept small and typed; the agent calls
 * these when a chat asks about GitHub.
 */

import { defineTool, s } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';
import type { HttpClient } from '@hermes/tools-http';

interface RepoInfo {
  readonly full_name: string;
  readonly description: string | null;
  readonly stargazers_count: number;
  readonly forks_count: number;
  readonly open_issues_count: number;
}
interface Issue {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
}

/** GitHub tools over the given HTTP client and token. */
export function githubTools(http: HttpClient, token: string): readonly HermesTool[] {
  const api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const res = await http.request({
      url: `https://api.github.com${path}`,
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'hermes-telegram',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status >= 400) {
      throw new Error(`GitHub ${method} ${path} -> ${String(res.status)}`);
    }
    return JSON.parse(res.body) as T;
  };

  const repo = defineTool({
    name: 'github.repo',
    description:
      'Get a GitHub repository summary: stars, forks, open issues, description.',
    tags: ['github'],
    idempotent: true,
    input: s.object({ repo: s.string({ description: 'owner/name' }) }),
    output: s.string(),
    execute: async ({ repo: name }) => {
      const d = await api<RepoInfo>(`/repos/${name}`);
      return (
        `${d.full_name} — ⭐ ${String(d.stargazers_count)}, forks ${String(d.forks_count)}, ` +
        `open issues ${String(d.open_issues_count)}\n${d.description ?? ''}`
      );
    },
  });

  const issues = defineTool({
    name: 'github.issues',
    description: 'List the open issues on a GitHub repository.',
    tags: ['github'],
    idempotent: true,
    input: s.object({ repo: s.string({ description: 'owner/name' }) }),
    output: s.string(),
    execute: async ({ repo: name }) => {
      const list = await api<Issue[]>(`/repos/${name}/issues?state=open&per_page=10`);
      if (list.length === 0) return 'No open issues.';
      return list.map((i) => `#${String(i.number)} ${i.title}`).join('\n');
    },
  });

  const createIssue = defineTool({
    name: 'github.createIssue',
    description: 'Open a new issue on a GitHub repository.',
    tags: ['github'],
    input: s.object({
      repo: s.string({ description: 'owner/name' }),
      title: s.string(),
      body: s.withDefault(s.string(), ''),
    }),
    output: s.string(),
    execute: async ({ repo: name, title, body }) => {
      const created = await api<Issue>(`/repos/${name}/issues`, 'POST', {
        title,
        body,
      });
      return `Opened issue #${String(created.number)}: ${created.html_url}`;
    },
  });

  return [repo, issues, createIssue];
}
