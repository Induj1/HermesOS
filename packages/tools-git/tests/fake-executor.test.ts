/**
 * The scripted executor — the test double the tool tests rely on, tested itself.
 */

import { describe, expect, it } from 'vitest';
import { FakeGitExecutor } from '../src/fake-executor.js';

describe('FakeGitExecutor', () => {
  it('records every run in order', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await git.run(['status']);
    await git.run(['log', '-1'], { cwd: 'sub' });
    expect(git.runs.map((r) => r.args)).toEqual([['status'], ['log', '-1']]);
    expect(git.runs[1]?.options.cwd).toBe('sub');
  });

  it('answers from the handler, defaulting the unset fields', async () => {
    const git = new FakeGitExecutor({ handle: () => ({ stdout: 'hi' }) });
    const result = await git.run(['status']);
    expect(result).toEqual({
      args: ['status'],
      exitCode: 0,
      stdout: 'hi',
      stderr: '',
      timedOut: false,
    });
  });

  it('succeedingWith always exits 0 with the stdout', async () => {
    expect(await FakeGitExecutor.succeedingWith('out').run(['x'])).toMatchObject({
      exitCode: 0,
      stdout: 'out',
    });
  });

  it('failingWith reports the stderr and code', async () => {
    expect(await FakeGitExecutor.failingWith('bad', 128).run(['x'])).toMatchObject({
      exitCode: 128,
      stderr: 'bad',
    });
  });

  // The same null-preservation the shell fake takes: a killed run reports `null`,
  // and it must not collapse to a success.
  it('preserves an explicit null exit code', async () => {
    const git = new FakeGitExecutor({
      handle: () => ({ exitCode: null, timedOut: true }),
    });
    const result = await git.run(['x']);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
  });

  it('honours an already-aborted signal', async () => {
    const git = FakeGitExecutor.succeedingWith('');
    await expect(git.run(['x'], { signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it('awaits an async handler', async () => {
    const git = new FakeGitExecutor({
      handle: () => Promise.resolve({ stdout: 'async' }),
    });
    expect((await git.run(['x'])).stdout).toBe('async');
  });
});
