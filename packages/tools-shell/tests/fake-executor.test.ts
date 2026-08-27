/**
 * The scripted executor's defaulting rules.
 *
 * `FakeShellExecutor` fills in the fields a handler did not set, and the
 * interesting case is `exitCode`, where "omitted" and "explicitly null" mean
 * opposite things: a clean exit nobody bothered to state, and a process that was
 * killed without one. A fake that conflated them would report a killed process
 * as a success, which is exactly the distinction a timeout test is written to
 * check.
 */

import { describe, expect, it } from 'vitest';
import { FakeShellExecutor } from '../src/fake-executor.js';

const noOptions = {};

describe('FakeShellExecutor defaults', () => {
  // The branch a handler reaches by staying silent. `exitCode` is absent from
  // the partial entirely, which must default to a clean 0 rather than to the
  // `null` that an explicit "killed" answer produces.
  it('treats an omitted exit code as a clean exit', async () => {
    const executor = new FakeShellExecutor({
      handle: () => ({ stdout: 'ok\n' }),
    });

    const result = await executor.run('git', ['status'], noOptions);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\n');
  });

  // The same field set explicitly to `null` must survive as `null`. A bare
  // `?? 0` would collapse this into the case above.
  it('keeps an explicit null exit code, which means killed', async () => {
    const executor = new FakeShellExecutor({
      handle: () => ({ exitCode: null, timedOut: true, signal: 'SIGTERM' }),
    });

    const result = await executor.run('sleep', ['60'], noOptions);

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
  });

  it('fills every remaining field a handler left unset', async () => {
    const executor = new FakeShellExecutor({ handle: () => ({}) });

    const result = await executor.run('true', [], noOptions);

    expect(result).toMatchObject({
      command: 'true',
      args: [],
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      durationMs: 0,
    });
  });

  it('records every run for a test to assert on afterwards', async () => {
    const executor = FakeShellExecutor.succeedingWith('on branch main');

    await executor.run('git', ['status', '--short'], noOptions);

    expect(executor.runs).toHaveLength(1);
    expect(executor.runs[0]).toMatchObject({
      command: 'git',
      args: ['status', '--short'],
    });
  });

  it('copies the arguments rather than aliasing the caller list', async () => {
    const executor = FakeShellExecutor.succeedingWith('');
    const args = ['status'];

    const result = await executor.run('git', args, noOptions);
    args.push('--short');

    expect(result.args).toEqual(['status']);
  });
});
