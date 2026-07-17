/**
 * Contract tests: the resource facade end to end against the fake GitHub server.
 *
 * These are the closest thing to "does the client talk to GitHub correctly"
 * without a token. Each drives a real create-or-read-or-mutate through the whole
 * stack — facade → REST client → transport → in-memory GitHub → back — and asserts
 * the round-trip, including that a write is visible to a subsequent read.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { GitHub } from '../src/resources.js';
import { GitHubClient } from '../src/client.js';
import { FakeGitHubServer } from '../src/fake-server.js';
import { tokenAuth } from '../src/auth.js';

let server: FakeGitHubServer;
let github: GitHub;

/** Parse a recorded request's JSON body, typed as unknown for assertions. */
const bodyOf = (req?: { body: string | undefined }): unknown =>
  JSON.parse(req?.body ?? '{}');

beforeEach(() => {
  server = new FakeGitHubServer();
  server.seedRepo('octo', 'demo');
  github = new GitHub(
    new GitHubClient({ http: server, auth: tokenAuth('ghp_x'), userAgent: 'test' }),
  );
});

describe('repos', () => {
  it('gets a repository', async () => {
    const repo = await github.repos.get('octo', 'demo');
    expect(repo).toMatchObject({ full_name: 'octo/demo', default_branch: 'main' });
  });

  it('404s an unknown repository as NOT_FOUND', async () => {
    await expect(github.repos.get('octo', 'ghost')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lists branches', async () => {
    const names: string[] = [];
    for await (const b of github.repos.listBranches('octo', 'demo')) names.push(b.name);
    expect(names).toEqual(['main']);
  });
});

describe('issues', () => {
  it('creates an issue, then reads it back', async () => {
    const created = await github.issues.create('octo', 'demo', {
      title: 'A bug',
      body: 'details',
    });
    expect(created).toMatchObject({ title: 'A bug', state: 'open' });

    const fetched = await github.issues.get('octo', 'demo', created.number);
    expect(fetched.number).toBe(created.number);
  });

  it('lists open issues by default and filters by state', async () => {
    await github.issues.create('octo', 'demo', { title: 'open one' });

    const open: string[] = [];
    for await (const i of github.issues.list('octo', 'demo')) open.push(i.title);
    expect(open).toContain('open one');
  });

  it('comments on an issue', async () => {
    const issue = await github.issues.create('octo', 'demo', { title: 'x' });
    const comment = await github.issues.comment('octo', 'demo', issue.number, 'thanks');
    expect(comment.id).toBeTypeOf('number');
  });
});

describe('pulls', () => {
  it('creates and merges a pull request, and the merge is visible', async () => {
    const pr = await github.pulls.create('octo', 'demo', {
      title: 'Feature',
      head: 'feature',
      base: 'main',
    });
    expect(pr).toMatchObject({ state: 'open', merged: false });

    const merge = await github.pulls.merge('octo', 'demo', pr.number, {
      method: 'squash',
    });
    expect(merge.merged).toBe(true);

    const after = await github.pulls.get('octo', 'demo', pr.number);
    expect(after).toMatchObject({ merged: true, state: 'closed' });

    // The merge went out as a PUT with the chosen method.
    const call = server.requests.find((r) => r.method === 'PUT');
    expect(bodyOf(call)).toMatchObject({ merge_method: 'squash' });
  });

  it('lists pull requests, defaulting to open', async () => {
    await github.pulls.create('octo', 'demo', {
      title: 'PR1',
      head: 'a',
      base: 'main',
    });
    const titles: string[] = [];
    for await (const pr of github.pulls.list('octo', 'demo')) titles.push(pr.title);
    expect(titles).toContain('PR1');
  });

  it('forwards an abort signal on a read', async () => {
    const controller = new AbortController();
    await github.repos.get('octo', 'demo', controller.signal);
    expect(server.requests.at(-1)?.method).toBe('GET');
  });

  it('passes a commit title through on merge', async () => {
    const pr = await github.pulls.create('octo', 'demo', {
      title: 'F',
      head: 'f',
      base: 'main',
    });
    await github.pulls.merge('octo', 'demo', pr.number, { commitTitle: 'Merge F' });
    const call = server.requests.find((r) => r.method === 'PUT');
    expect(bodyOf(call)).toMatchObject({
      merge_method: 'merge',
      commit_title: 'Merge F',
    });
  });
});

describe('actions', () => {
  it('lists workflow runs from the wrapped envelope', async () => {
    server.seedRepo('octo', 'ci', {
      runs: [
        {
          id: 1,
          name: 'CI',
          status: 'completed',
          conclusion: 'success',
          head_branch: 'main',
          html_url: '',
        },
        {
          id: 2,
          name: 'CI',
          status: 'in_progress',
          conclusion: null,
          head_branch: 'dev',
          html_url: '',
        },
      ],
    });
    const ids: number[] = [];
    for await (const run of github.actions.listWorkflowRuns('octo', 'ci'))
      ids.push(run.id);
    expect(ids).toEqual([1, 2]);
  });

  it('dispatches a workflow with a ref and inputs', async () => {
    await github.actions.dispatchWorkflow('octo', 'demo', 'ci.yml', {
      ref: 'main',
      inputs: { env: 'prod' },
    });
    const call = server.requests.at(-1);
    expect(call?.url).toContain('/actions/workflows/ci.yml/dispatches');
    expect(bodyOf(call)).toEqual({ ref: 'main', inputs: { env: 'prod' } });
  });
});

describe('releases', () => {
  it('creates a release and lists it', async () => {
    await github.releases.create('octo', 'demo', { tag_name: 'v1.0.0', name: 'One' });
    const tags: string[] = [];
    for await (const r of github.releases.list('octo', 'demo')) tags.push(r.tag_name);
    expect(tags).toContain('v1.0.0');
  });
});

describe('graphql via the facade', () => {
  it('shares the facade transport', async () => {
    const s = new FakeGitHubServer({
      graphql: () => ({ data: { viewer: { login: 'octo' } } }),
    });
    const gh = new GitHub(new GitHubClient({ http: s, userAgent: 't' }));
    const data = await gh.graphql.query<{ viewer: { login: string } }>(
      'query { viewer { login } }',
    );
    expect(data.viewer.login).toBe('octo');
  });
});
