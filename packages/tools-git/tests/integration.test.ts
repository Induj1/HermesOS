/**
 * The tools against real `git`, in a throwaway repository.
 *
 * This is the other half of the fake-driven tool tests: those prove the tools
 * send the right argv and parse crafted output; this proves that argv, run
 * against actual git, produces the output those parsers expect. A change in git's
 * porcelain format that the fakes could not see would surface here.
 *
 * The whole flow is exercised — init → config → add → commit → log → branch →
 * checkout → diff → status → tag — through the real executor stack:
 * `ShellGitExecutor` over a `NodeShellExecutor` allowlisted to `git`, confined to
 * the temp repo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeShellExecutor, allowlisted } from '@hermes/tools-shell';
import { callTool } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';
import { ShellGitExecutor } from '../src/executor.js';
import { gitTools } from '../src/tools.js';
import type { LogEntry } from '../src/parse.js';

let repo: string;
let tools: readonly HermesTool[];

const tool = (name: string): HermesTool => {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};

/** The union of result shapes the flow reads; `callTool` erases the output type to `unknown`. */
interface GitOut {
  clean?: boolean;
  entries?: readonly { path: string; state: string; code: string }[];
  branch?: string;
  current?: string;
  all?: readonly string[];
  exitCode?: number;
  empty?: boolean;
  diff?: string;
  tags?: readonly string[];
  merged?: boolean;
  conflict?: boolean;
}

const call = async (t: HermesTool, input: unknown): Promise<GitOut> =>
  (await callTool(t, input)) as GitOut;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'hermes-git-'));
  const executor = new ShellGitExecutor(allowlisted(new NodeShellExecutor(), ['git']), {
    root: repo,
    timeoutMs: 15_000,
  });
  tools = gitTools(executor, { timeoutMs: 15_000 });

  // Identity written to the repo's own config, so tool-driven commits — which pass
  // no environment — find an author. The raw `config` runs go through the same
  // confined executor.
  await executor.run(['init']);
  // Pin the initial branch to `main` regardless of the host's init.defaultBranch,
  // so the flow below can name it. `symbolic-ref` retargets the unborn HEAD.
  await executor.run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await executor.run(['config', 'user.email', 'test@hermes.dev']);
  await executor.run(['config', 'user.name', 'Hermes Test']);
  await executor.run(['config', 'commit.gpgsign', 'false']);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('a full local flow against real git', () => {
  it('reports a clean, empty repository', async () => {
    const status = await call(tool('git.status'), {});
    expect(status.clean).toBe(true);
    expect(status.entries).toEqual([]);
  });

  it('sees an untracked file', async () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    const status = await call(tool('git.status'), {});
    expect(status.clean).toBe(false);
    expect(status.entries).toContainEqual({
      path: 'a.txt',
      state: 'untracked',
      code: '??',
    });
  });

  it('stages and commits, then logs the commit', async () => {
    await callTool(tool('git.add'), { paths: ['a.txt'] });

    const staged = await call(tool('git.status'), {});
    expect(staged.entries).toContainEqual(
      expect.objectContaining({ path: 'a.txt', state: 'staged' }),
    );

    const commit = await call(tool('git.commit'), { message: 'feat: add a.txt' });
    expect(commit.exitCode).toBe(0);

    const log = (await callTool(tool('git.log'), { limit: 5 })) as readonly LogEntry[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      author: 'Hermes Test',
      email: 'test@hermes.dev',
      subject: 'feat: add a.txt',
    });
    expect(log[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses an empty commit with NOTHING_TO_COMMIT', async () => {
    await expect(
      callTool(tool('git.commit'), { message: 'nothing' }),
    ).rejects.toMatchObject({
      code: 'NOTHING_TO_COMMIT',
    });
  });

  it('creates and switches branches', async () => {
    await callTool(tool('git.checkout'), { target: 'feature/x', create: true });

    const branches = await call(tool('git.branches'), {});
    expect(branches.current).toBe('feature/x');
    expect(branches.all).toContain('feature/x');
  });

  it('shows an unstaged diff', async () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\nworld\n');
    const diff = await call(tool('git.diff'), {});
    expect(diff.empty).toBe(false);
    expect(diff.diff).toContain('+world');
  });

  it('tags the current commit and lists it', async () => {
    // Commit the working change first so there is a clean state to tag.
    await callTool(tool('git.add'), { paths: ['.'] });
    await callTool(tool('git.commit'), { message: 'feat: add world' });

    await callTool(tool('git.tag'), { name: 'v0.1.0', message: 'first release' });
    const tags = await call(tool('git.tags'), {});
    expect(tags.tags).toContain('v0.1.0');
  });

  it('merges a branch back with no conflict', async () => {
    await callTool(tool('git.checkout'), { target: 'main' });
    const merge = await call(tool('git.merge'), { branch: 'feature/x' });
    expect(merge.merged).toBe(true);
    expect(merge.conflict).toBe(false);
  });

  it('reports a real merge conflict as data, not a throw', async () => {
    // Diverge two branches on the same line, then merge — git leaves a conflict.
    await callTool(tool('git.checkout'), { target: 'conflict-a', create: true });
    writeFileSync(join(repo, 'a.txt'), 'A-side\n');
    await callTool(tool('git.add'), { paths: ['.'] });
    await callTool(tool('git.commit'), { message: 'A' });

    await callTool(tool('git.checkout'), { target: 'main' });
    await callTool(tool('git.checkout'), { target: 'conflict-b', create: true });
    writeFileSync(join(repo, 'a.txt'), 'B-side\n');
    await callTool(tool('git.add'), { paths: ['.'] });
    await callTool(tool('git.commit'), { message: 'B' });

    const merge = await call(tool('git.merge'), { branch: 'conflict-a' });
    expect(merge.merged).toBe(false);
    expect(merge.conflict).toBe(true);

    // Drop the conflict markers so the state is clean; the repo is torn down after
    // this file anyway, but a hard reset keeps the test self-contained.
    await callTool(tool('git.reset'), { ref: 'HEAD', mode: 'hard' });
  });

  it('refuses a cwd that escapes the repository root', async () => {
    const executor = new ShellGitExecutor(
      allowlisted(new NodeShellExecutor(), ['git']),
      { root: repo },
    );
    await expect(executor.run(['status'], { cwd: '../../..' })).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });
  });
});
