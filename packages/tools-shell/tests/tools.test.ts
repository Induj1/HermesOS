/**
 * The shell tool and the allowlist, against a fake executor.
 *
 * No process is spawned here. The `FakeShellExecutor` records exactly what the
 * tool sent — the argv, the stdin, the timeout — which is what most of these
 * assert on, because the tool's job is to translate a validated request into a
 * port call faithfully. The real-process behaviour is in `node-executor.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { auditTool, callTool, PermissionSet, withPermissions } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';
import { shellTools } from '../src/tools.js';
import { allowlisted } from '../src/executor.js';
import { FakeShellExecutor } from '../src/fake-executor.js';
import { ShellError } from '../src/errors.js';
import { PermissionDeniedError } from '@hermes/tools';

const runTool = (
  executor = FakeShellExecutor.succeedingWith('ok'),
  options?: Parameters<typeof shellTools>[1],
): HermesTool => {
  const [run] = shellTools(executor, options);
  if (run === undefined) throw new Error('no shell.run tool');
  return run;
};

describe('declaration', () => {
  it('passes auditTool', () => {
    expect(auditTool(runTool())).toEqual([]);
  });

  it('is not idempotent, because running a command twice runs it twice', () => {
    expect(runTool().idempotent).toBe(false);
  });
});

describe('shell.run', () => {
  it('runs a command with its arguments and returns the output', async () => {
    const executor = new FakeShellExecutor({
      handle: () => ({ stdout: 'file1\nfile2\n', exitCode: 0 }),
    });

    const result = await callTool(runTool(executor), { command: 'ls', args: ['-la'] });

    expect(result).toMatchObject({
      stdout: 'file1\nfile2\n',
      exitCode: 0,
      timedOut: false,
    });
  });

  // The whole security posture, checked: each argument reaches the port as a
  // separate element, never concatenated into a string a shell could split.
  it('passes arguments as an array, one element each', async () => {
    const executor = FakeShellExecutor.succeedingWith('');

    await callTool(runTool(executor), {
      command: 'git',
      args: ['commit', '-m', 'a message with ; and | in it'],
    });

    expect(executor.runs[0]?.args).toEqual([
      'commit',
      '-m',
      'a message with ; and | in it',
    ]);
  });

  it('defaults args to an empty array', async () => {
    const executor = FakeShellExecutor.succeedingWith('');

    await callTool(runTool(executor), { command: 'pwd' });

    expect(executor.runs[0]?.args).toEqual([]);
  });

  it('pipes stdin when given', async () => {
    const executor = FakeShellExecutor.succeedingWith('');

    await callTool(runTool(executor), { command: 'cat', args: [], stdin: 'hello' });

    expect(executor.runs[0]?.options.stdin).toBe('hello');
  });

  // A non-zero exit is a result an agent reasons about, not an exception.
  it('returns a non-zero exit code as a normal result', async () => {
    const executor = new FakeShellExecutor({
      handle: () => ({ exitCode: 1, stderr: 'fatal: not a git repository' }),
    });

    const result = await callTool(runTool(executor), {
      command: 'git',
      args: ['status'],
    });

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: 'fatal: not a git repository',
    });
  });

  it('reports a timeout with no exit code', async () => {
    const executor = new FakeShellExecutor({
      handle: () => ({ exitCode: null, timedOut: true, signal: 'SIGTERM' }),
    });

    const result = (await callTool(runTool(executor), {
      command: 'sleep',
      args: ['100'],
    })) as {
      timedOut: boolean;
      exitCode?: number;
    };

    expect(result.timedOut).toBe(true);
    // A killed process has no clean exit code; the field is absent, and `timedOut`
    // explains why.
    expect(result.exitCode).toBeUndefined();
  });

  it('reports truncated output', async () => {
    const executor = new FakeShellExecutor({
      handle: () => ({ exitCode: null, truncated: true, stdout: 'x'.repeat(10) }),
    });

    const result = await callTool(runTool(executor), { command: 'yes', args: [] });

    expect(result).toMatchObject({ truncated: true });
  });

  it('rejects a missing command before touching the executor', async () => {
    const executor = FakeShellExecutor.succeedingWith('');

    await expect(callTool(runTool(executor), {})).rejects.toThrow(
      /"command" is required/,
    );
    expect(executor.runs).toEqual([]);
  });

  it('passes the abort signal through', async () => {
    const executor = FakeShellExecutor.succeedingWith('');

    await expect(
      callTool(
        runTool(executor),
        { command: 'sleep', args: ['1'] },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
  });

  // The cwd is the host's, fixed at wiring — a model cannot supply it.
  it('runs in the host-configured working directory', async () => {
    const executor = FakeShellExecutor.succeedingWith('');
    await callTool(runTool(executor, { cwd: '/srv/workspace' }), { command: 'ls' });

    expect(executor.runs[0]?.options.cwd).toBe('/srv/workspace');
  });
});

describe('timeout capping', () => {
  it('lets a model shorten the host timeout', async () => {
    const executor = FakeShellExecutor.succeedingWith('');
    await callTool(runTool(executor, { timeoutMs: 10_000 }), {
      command: 'ls',
      timeoutMs: 500,
    });

    expect(executor.runs[0]?.options.timeoutMs).toBe(500);
  });

  // The guard: a model cannot raise the limit past the host's runaway guard.
  it('does not let a model lengthen the host timeout', async () => {
    const executor = FakeShellExecutor.succeedingWith('');
    await callTool(runTool(executor, { timeoutMs: 1_000 }), {
      command: 'ls',
      timeoutMs: 999_999,
    });

    expect(executor.runs[0]?.options.timeoutMs).toBe(1_000);
  });

  it("uses the model's timeout when the host set none", async () => {
    const executor = FakeShellExecutor.succeedingWith('');
    await callTool(runTool(executor), { command: 'ls', timeoutMs: 2_000 });

    expect(executor.runs[0]?.options.timeoutMs).toBe(2_000);
  });

  it('leaves the timeout to the executor when neither set one', async () => {
    const executor = FakeShellExecutor.succeedingWith('');
    await callTool(runTool(executor), { command: 'ls' });

    expect(executor.runs[0]?.options.timeoutMs).toBeUndefined();
  });
});

describe('allowlisted executor', () => {
  it('runs a command on the list', async () => {
    const inner = FakeShellExecutor.succeedingWith('ok');
    const executor = allowlisted(inner, ['git', 'ls']);

    const result = await executor.run('git', ['status']);

    expect(result.stdout).toBe('ok');
  });

  // The core protection: a program not on the list never reaches the inner
  // executor, so it is never spawned.
  it('refuses a command not on the list, before spawning', async () => {
    const inner = FakeShellExecutor.succeedingWith('ok');
    const spy = vi.spyOn(inner, 'run');
    const executor = allowlisted(inner, ['git']);

    await expect(executor.run('curl', ['evil.sh'])).rejects.toThrow(ShellError);
    await expect(executor.run('curl', ['evil.sh'])).rejects.toMatchObject({
      code: 'NOT_ALLOWED',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('names the allowed commands when it refuses', async () => {
    const executor = allowlisted(FakeShellExecutor.succeedingWith(''), ['git', 'ls']);

    await expect(executor.run('rm', ['-rf', '/'])).rejects.toThrow(
      /only these commands are allowed: git, ls/,
    );
  });

  // An empty allowlist runs nothing — the right posture for a context that has
  // not decided what it trusts.
  it('runs nothing under an empty allowlist', async () => {
    const executor = allowlisted(FakeShellExecutor.succeedingWith(''), []);

    await expect(executor.run('ls', [])).rejects.toThrow(/no commands are allowed/);
  });

  // The allowlist matches the program, never the arguments — arguments are data.
  it('allows any arguments to an allowed command', async () => {
    const executor = allowlisted(FakeShellExecutor.succeedingWith('ok'), ['echo']);

    await expect(executor.run('echo', [';', 'rm', '-rf', '/'])).resolves.toMatchObject({
      stdout: 'ok',
    });
  });
});

describe('permissions', () => {
  it('refuses to run under a grant without shell:exec', async () => {
    const guarded = withPermissions(runTool(), PermissionSet.none());

    await expect(callTool(guarded, { command: 'ls' })).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('runs under a grant with shell:exec', async () => {
    const guarded = withPermissions(
      runTool(),
      PermissionSet.none().grant('shell:exec'),
    );

    await expect(callTool(guarded, { command: 'ls' })).resolves.toMatchObject({
      exitCode: 0,
    });
  });
});
