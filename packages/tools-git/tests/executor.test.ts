/**
 * The executor: confinement, and the wrapping of a shell executor.
 *
 * `confine` is a pure string function, tested exhaustively here. `ShellGitExecutor`
 * is tested against a `FakeShellExecutor`, so these assert what argv, cwd, timeout
 * and signal it hands the shell layer — its whole job is to pass those through
 * pinned to `git`, confined to a root. The real-git behaviour is in
 * `integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { FakeShellExecutor } from '@hermes/tools-shell';
import { ShellGitExecutor, confine } from '../src/executor.js';
import { GitError } from '../src/errors.js';

describe('confine', () => {
  it('resolves a relative path within the root', () => {
    expect(confine('/srv/repos', 'a/b')).toBe('/srv/repos/a/b');
  });

  it('treats "." and "" as the root itself', () => {
    expect(confine('/srv/repos', '.')).toBe('/srv/repos');
    expect(confine('/srv/repos', '')).toBe('/srv/repos');
  });

  it('collapses redundant "." segments', () => {
    expect(confine('/srv/repos', './a/./b')).toBe('/srv/repos/a/b');
  });

  it('allows ".." that stays within the root', () => {
    expect(confine('/srv/repos', 'a/../b')).toBe('/srv/repos/b');
  });

  it('refuses ".." that escapes the root', () => {
    expect(() => confine('/srv/repos', '..')).toThrow(GitError);
    expect(() => confine('/srv/repos', 'a/../../etc')).toThrow(
      /outside the repository root/,
    );
  });

  it('refuses an escape even when it dips in first', () => {
    expect(() => confine('/srv/repos', 'a/b/../../../x')).toThrow(GitError);
  });

  it('tags the escape with PATH_ESCAPE', () => {
    try {
      confine('/srv/repos', '../../etc/passwd');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).code).toBe('PATH_ESCAPE');
    }
  });
});

describe('ShellGitExecutor', () => {
  it('runs git with the given argv, in the confined cwd', async () => {
    const shell = FakeShellExecutor.succeedingWith('output');
    const git = new ShellGitExecutor(shell, { root: '/srv/repos' });

    const result = await git.run(['status', '--porcelain'], { cwd: 'project' });

    expect(shell.runs[0]?.command).toBe('git');
    expect(shell.runs[0]?.args).toEqual(['status', '--porcelain']);
    expect(shell.runs[0]?.options.cwd).toBe('/srv/repos/project');
    expect(result.stdout).toBe('output');
    expect(result.args).toEqual(['status', '--porcelain']);
  });

  it('defaults the cwd to the root', async () => {
    const shell = FakeShellExecutor.succeedingWith('');
    await new ShellGitExecutor(shell, { root: '/srv/repos' }).run(['status']);
    expect(shell.runs[0]?.options.cwd).toBe('/srv/repos');
  });

  it('refuses a cwd that escapes the root before spawning git', async () => {
    const shell = FakeShellExecutor.succeedingWith('');
    const git = new ShellGitExecutor(shell, { root: '/srv/repos' });

    await expect(git.run(['status'], { cwd: '../../etc' })).rejects.toThrow(GitError);
    expect(shell.runs).toHaveLength(0);
  });

  it('pins the git program when a path is given', async () => {
    const shell = FakeShellExecutor.succeedingWith('');
    await new ShellGitExecutor(shell, { root: '/r', gitPath: '/usr/bin/git' }).run([
      'status',
    ]);
    expect(shell.runs[0]?.command).toBe('/usr/bin/git');
  });

  it('passes the per-call timeout through, falling back to the default', async () => {
    const shell = FakeShellExecutor.succeedingWith('');
    const git = new ShellGitExecutor(shell, { root: '/r', timeoutMs: 1000 });

    await git.run(['status']);
    expect(shell.runs[0]?.options.timeoutMs).toBe(1000);

    await git.run(['status'], { timeoutMs: 50 });
    expect(shell.runs[1]?.options.timeoutMs).toBe(50);
  });

  it('omits the timeout when neither default nor override is set', async () => {
    const shell = FakeShellExecutor.succeedingWith('');
    await new ShellGitExecutor(shell, { root: '/r' }).run(['status']);
    expect(shell.runs[0]?.options.timeoutMs).toBeUndefined();
  });

  it('forwards the abort signal', async () => {
    const shell = FakeShellExecutor.succeedingWith('');
    const controller = new AbortController();
    await new ShellGitExecutor(shell, { root: '/r' }).run(['status'], {
      signal: controller.signal,
    });
    expect(shell.runs[0]?.options.signal).toBe(controller.signal);
  });

  it('carries a non-zero exit and stderr through as a result, not a throw', async () => {
    const shell = new FakeShellExecutor({
      handle: () => ({ exitCode: 1, stderr: 'boom' }),
    });
    const result = await new ShellGitExecutor(shell, { root: '/r' }).run(['status']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('boom');
  });
});
