/**
 * The git tools, against a scripted executor.
 *
 * No `git` runs here. Each test crafts the git output or exit code the tool would
 * see and asserts two things: the exact argv the tool sends (its security-relevant
 * translation of a validated request), and the structured result it returns. The
 * real-git confirmation that these argvs produce this output is in
 * `integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { auditTool, callTool } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';
import { gitTools } from '../src/tools.js';
import { FakeGitExecutor } from '../src/fake-executor.js';
import { GitError } from '../src/errors.js';
import { LOG_FORMAT } from '../src/parse.js';

const tool = (name: string, executor: FakeGitExecutor): HermesTool => {
  const found = gitTools(executor).find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};

/** The union of shapes the git tools return; `callTool` erases the output type to `unknown`. */
interface GitOut {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  empty?: boolean;
  ok?: boolean;
  merged?: boolean;
  conflict?: boolean;
  rejected?: boolean;
}

const call = async (t: HermesTool, input: unknown): Promise<GitOut> =>
  (await callTool(t, input)) as GitOut;

describe('declaration', () => {
  it('every tool passes auditTool', () => {
    for (const t of gitTools(FakeGitExecutor.succeedingWith(''))) {
      expect(auditTool(t), t.name).toEqual([]);
    }
  });

  it('splits permissions into read, write, and network', () => {
    const perms = new Map(
      gitTools(FakeGitExecutor.succeedingWith('')).map((t) => [t.name, t.permissions]),
    );
    expect(perms.get('git.status')).toEqual(['git:read']);
    expect(perms.get('git.commit')).toEqual(['git:write']);
    expect(perms.get('git.push')).toEqual(['git:network']);
  });

  it('exposes the expected set of operations', () => {
    const names = gitTools(FakeGitExecutor.succeedingWith(''))
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      [
        'git.add',
        'git.branch',
        'git.branches',
        'git.checkout',
        'git.clone',
        'git.commit',
        'git.diff',
        'git.fetch',
        'git.init',
        'git.log',
        'git.merge',
        'git.pull',
        'git.push',
        'git.rebase',
        'git.reset',
        'git.show',
        'git.status',
        'git.stash',
        'git.tag',
        'git.tags',
      ].sort(),
    );
  });
});

describe('git.status', () => {
  it('runs porcelain --branch and returns the parsed status', async () => {
    const git = FakeGitExecutor.succeedingWith(
      '## main...origin/main [ahead 1]\n M src/a.ts\n?? new.ts\n',
    );
    const result = await callTool(tool('git.status', git), {});
    expect(git.runs[0]?.args).toEqual(['status', '--porcelain=v1', '--branch']);
    expect(result).toMatchObject({
      branch: 'main',
      ahead: 1,
      behind: 0,
      clean: false,
      entries: [
        { path: 'src/a.ts', state: 'unstaged', code: ' M' },
        { path: 'new.ts', state: 'untracked', code: '??' },
      ],
    });
  });

  it('throws a classified error when the directory is not a repository', async () => {
    const git = FakeGitExecutor.failingWith('fatal: not a git repository', 128);
    await expect(callTool(tool('git.status', git), {})).rejects.toMatchObject({
      code: 'NOT_A_REPOSITORY',
    });
  });
});

describe('git.log', () => {
  it('logs with the shared format and a max count', async () => {
    const git = FakeGitExecutor.succeedingWith(
      'h\x1fAda\x1fada@x\x1f2026-01-01\x1fSubject\x1e',
    );
    const result = await callTool(tool('git.log', git), { limit: 5 });
    expect(git.runs[0]?.args).toEqual([
      'log',
      '--max-count=5',
      `--format=${LOG_FORMAT}`,
    ]);
    expect(result).toEqual([
      {
        hash: 'h',
        author: 'Ada',
        email: 'ada@x',
        date: '2026-01-01',
        subject: 'Subject',
      },
    ]);
  });

  it('defaults the limit to 20', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.log', git), {});
    expect(git.runs[0]?.args).toContain('--max-count=20');
  });

  it('appends a ref when given', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.log', git), { ref: 'develop' });
    expect(git.runs[0]?.args.at(-1)).toBe('develop');
  });
});

describe('git.diff', () => {
  it('diffs the working tree by default', async () => {
    const git = FakeGitExecutor.succeedingWith('diff --git a/x b/x\n');
    const result = await callTool(tool('git.diff', git), {});
    expect(git.runs[0]?.args).toEqual(['diff']);
    expect(result).toEqual({ diff: 'diff --git a/x b/x\n', empty: false });
  });

  it('diffs the staged changes with --staged and a path', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    const result = await call(tool('git.diff', git), {
      staged: true,
      path: 'src/a.ts',
    });
    expect(git.runs[0]?.args).toEqual(['diff', '--staged', '--', 'src/a.ts']);
    expect(result.empty).toBe(true);
  });
});

describe('git.branches', () => {
  it('lists branches and marks the current', async () => {
    const git = FakeGitExecutor.succeedingWith('* main\n  feature\n');
    const result = await callTool(tool('git.branches', git), {});
    expect(git.runs[0]?.args).toEqual(['branch', '--list']);
    expect(result).toEqual({ current: 'main', all: ['main', 'feature'] });
  });
});

describe('git.tags', () => {
  it('lists tags, dropping blank lines', async () => {
    const git = FakeGitExecutor.succeedingWith('v1.0.0\nv1.1.0\n');
    expect(await callTool(tool('git.tags', git), {})).toEqual({
      tags: ['v1.0.0', 'v1.1.0'],
    });
  });
});

describe('git.show', () => {
  it('shows a ref, defaulting to HEAD', async () => {
    const git = FakeGitExecutor.succeedingWith('commit abc');
    await callTool(tool('git.show', git), {});
    expect(git.runs[0]?.args).toEqual(['show', 'HEAD']);
  });
});

describe('git.init / add / commit', () => {
  it('init runs git init', async () => {
    const git = FakeGitExecutor.succeedingWith('Initialized');
    const result = await call(tool('git.init', git), {});
    expect(git.runs[0]?.args).toEqual(['init']);
    expect(result.exitCode).toBe(0);
  });

  it('add stages paths after a -- guard', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.add', git), { paths: ['src/a.ts', '-weird.ts'] });
    expect(git.runs[0]?.args).toEqual(['add', '--', 'src/a.ts', '-weird.ts']);
  });

  it('add rejects an empty path list at the schema', async () => {
    await expect(
      callTool(tool('git.add', FakeGitExecutor.succeedingWith('')), { paths: [] }),
    ).rejects.toThrow();
  });

  it('commit passes the message as a separate argv element', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.commit', git), { message: 'a; rm -rf ~' });
    expect(git.runs[0]?.args).toEqual(['commit', '-m', 'a; rm -rf ~']);
  });

  it('commit -a stages tracked changes first', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.commit', git), { message: 'm', all: true });
    expect(git.runs[0]?.args).toEqual(['commit', '-m', 'm', '-a']);
  });

  it('commit surfaces NOTHING_TO_COMMIT', async () => {
    const git = FakeGitExecutor.failingWith('nothing to commit, working tree clean', 1);
    await expect(
      callTool(tool('git.commit', git), { message: 'm' }),
    ).rejects.toMatchObject({
      code: 'NOTHING_TO_COMMIT',
    });
  });
});

describe('git.checkout / branch', () => {
  it('checkout switches to a target', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.checkout', git), { target: 'main' });
    expect(git.runs[0]?.args).toEqual(['checkout', 'main']);
  });

  it('checkout -b creates and switches', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.checkout', git), { target: 'feature/x', create: true });
    expect(git.runs[0]?.args).toEqual(['checkout', '-b', 'feature/x']);
  });

  it('branch creates by default and force-deletes on delete', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.branch', git), { name: 'topic' });
    expect(git.runs[0]?.args).toEqual(['branch', 'topic']);
    await callTool(tool('git.branch', git), { name: 'topic', action: 'delete' });
    expect(git.runs[1]?.args).toEqual(['branch', '-D', 'topic']);
  });
});

describe('git.merge', () => {
  it('reports a clean merge', async () => {
    const git = FakeGitExecutor.succeedingWith('Fast-forward');
    const result = await callTool(tool('git.merge', git), { branch: 'feature' });
    expect(git.runs[0]?.args).toEqual(['merge', 'feature']);
    expect(result).toMatchObject({ merged: true, conflict: false });
  });

  // The load-bearing decision: a conflict is a reported outcome, not a thrown
  // error, so an agent can go on to resolve it.
  it('reports a conflict as data rather than throwing', async () => {
    const git = new FakeGitExecutor({
      handle: () => ({
        exitCode: 1,
        stdout: 'CONFLICT (content): Merge conflict in a.txt',
      }),
    });
    const result = await callTool(tool('git.merge', git), { branch: 'feature' });
    expect(result).toMatchObject({ merged: false, conflict: true });
  });
});

describe('git.rebase', () => {
  it('rebases onto a branch', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    const result = await call(tool('git.rebase', git), { onto: 'main' });
    expect(git.runs[0]?.args).toEqual(['rebase', 'main']);
    expect(result.ok).toBe(true);
  });

  it('aborts an in-progress rebase', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.rebase', git), { onto: 'main', abort: true });
    expect(git.runs[0]?.args).toEqual(['rebase', '--abort']);
  });

  it('reports a conflict', async () => {
    const git = new FakeGitExecutor({
      handle: () => ({ exitCode: 1, stderr: 'CONFLICT while rebasing' }),
    });
    expect(await callTool(tool('git.rebase', git), { onto: 'main' })).toMatchObject({
      ok: false,
      conflict: true,
    });
  });
});

describe('git.stash / tag / reset', () => {
  it('stash push by default', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.stash', git), {});
    expect(git.runs[0]?.args).toEqual(['stash', 'push']);
  });

  it('stash pop', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.stash', git), { action: 'pop' });
    expect(git.runs[0]?.args).toEqual(['stash', 'pop']);
  });

  it('tag creates a lightweight tag', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.tag', git), { name: 'v1.0.0' });
    expect(git.runs[0]?.args).toEqual(['tag', 'v1.0.0']);
  });

  it('tag -a -m creates an annotated tag', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.tag', git), { name: 'v1.0.0', message: 'release' });
    expect(git.runs[0]?.args).toEqual(['tag', '-a', 'v1.0.0', '-m', 'release']);
  });

  it('reset defaults to a mixed reset of HEAD', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.reset', git), {});
    expect(git.runs[0]?.args).toEqual(['reset', '--mixed', 'HEAD']);
  });

  it('reset --hard to a ref', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.reset', git), { ref: 'origin/main', mode: 'hard' });
    expect(git.runs[0]?.args).toEqual(['reset', '--hard', 'origin/main']);
  });
});

describe('git.clone / fetch / pull / push', () => {
  it('clone guards its positional args with --', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.clone', git), { url: '-hostile', directory: 'dest' });
    expect(git.runs[0]?.args).toEqual(['clone', '--', '-hostile', 'dest']);
  });

  it('clone refuses a git remote-helper transport URL', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await expect(
      callTool(tool('git.clone', git), { url: "ext::sh -c 'id'", directory: 'dest' }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(git.runs).toHaveLength(0); // git was never invoked
  });

  it('clone refuses an empty URL', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await expect(
      callTool(tool('git.clone', git), { url: '  ', directory: 'dest' }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });

  it('clone allows normal URL forms', async () => {
    for (const url of ['https://github.com/x/y.git', 'git@github.com:x/y.git']) {
      const git = FakeGitExecutor.succeedingWith('');
      await callTool(tool('git.clone', git), { url, directory: 'dest' });
      expect(git.runs[0]?.args).toEqual(['clone', '--', url, 'dest']);
    }
  });

  it('fetch defaults to origin', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.fetch', git), {});
    expect(git.runs[0]?.args).toEqual(['fetch', 'origin']);
  });

  it('pull reports a conflict', async () => {
    const git = new FakeGitExecutor({
      handle: () => ({ exitCode: 1, stderr: 'Merge conflict in a' }),
    });
    const result = await callTool(tool('git.pull', git), { branch: 'main' });
    expect(git.runs[0]?.args).toEqual(['pull', 'origin', 'main']);
    expect(result).toMatchObject({ ok: false, conflict: true });
  });

  it('push force uses --force-with-lease, never a bare --force', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await callTool(tool('git.push', git), { force: true, branch: 'main' });
    expect(git.runs[0]?.args).toEqual(['push', '--force-with-lease', 'origin', 'main']);
  });

  it('push reports a rejection as data', async () => {
    const git = new FakeGitExecutor({
      handle: () => ({ exitCode: 1, stderr: '! [rejected] (non-fast-forward)' }),
    });
    expect(await callTool(tool('git.push', git), {})).toMatchObject({
      ok: false,
      rejected: true,
    });
  });
});

describe('cancellation', () => {
  it('honours an aborted signal — the executor throws rather than completing', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await expect(
      callTool(tool('git.status', git), {}, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});

describe('options', () => {
  it('passes a configured timeout through to the executor', async () => {
    const git = FakeGitExecutor.succeedingWith('## main\n');
    const [status] = gitTools(git, { timeoutMs: 2500 }).filter(
      (t) => t.name === 'git.status',
    );
    if (status === undefined) throw new Error('no git.status');
    await callTool(status, {});
    expect(git.runs[0]?.options.timeoutMs).toBe(2500);
  });

  it('omits the timeout when none is configured', async () => {
    const git = FakeGitExecutor.succeedingWith('## main\n');
    await callTool(tool('git.status', git), {});
    expect(git.runs[0]?.options.timeoutMs).toBeUndefined();
  });
});

describe('GitError re-export', () => {
  it('is the same class the errors module exports', () => {
    // A host can `import { GitError } from '@hermes/tools-git'` and catch it.
    expect(GitError).toBeDefined();
  });
});
