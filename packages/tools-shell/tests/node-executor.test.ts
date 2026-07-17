/**
 * NodeShellExecutor against real processes.
 *
 * This is where the security claim is *proved* rather than asserted: that argv is
 * not a shell, so an argument that looks like a second command is just an
 * argument. A test that only used the fake executor could not show that — the
 * fake never spawns anything, so it cannot demonstrate what a real shell would or
 * would not do with the string.
 *
 * These use `node` itself as the command under test, so they run anywhere Node
 * runs, with no assumption about `sh`, `ls`, or a PATH.
 */

import { describe, expect, it } from 'vitest';
import { NodeShellExecutor } from '../src/node-executor.js';
import { ShellError } from '../src/errors.js';

const exec = new NodeShellExecutor();
const node = process.execPath;

describe('running a real process', () => {
  it('captures stdout and a zero exit', async () => {
    const result = await exec.run(node, ['-e', 'process.stdout.write("hello")']);

    expect(result.stdout).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr and a non-zero exit as a normal result', async () => {
    const result = await exec.run(node, [
      '-e',
      'process.stderr.write("bad"); process.exit(3)',
    ]);

    expect(result.stderr).toBe('bad');
    expect(result.exitCode).toBe(3);
  });

  it('pipes stdin to the process', async () => {
    const result = await exec.run(
      node,
      ['-e', 'process.stdin.on("data", (d) => process.stdout.write(d))'],
      { stdin: 'echoed' },
    );

    expect(result.stdout).toBe('echoed');
  });

  it('closes stdin so a reader does not hang', async () => {
    // Reads all of stdin then exits. With stdin left open this would hang until
    // the timeout; the executor closes it, so it ends promptly.
    const result = await exec.run(node, [
      '-e',
      'let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => process.stdout.write("done:" + s.length))',
    ]);

    expect(result.stdout).toBe('done:0');
  });
});

// The claim, proved on a real process.
describe('argv is not a shell', () => {
  it('treats a shell metacharacter argument as literal text', async () => {
    // If this were run through a shell, `; process.exit(99)` would be a second
    // statement. As an argv element it is just a string printed back.
    const payload = '; process.exit(99)';
    const result = await exec.run(node, [
      '-e',
      'process.stdout.write(process.argv[1])',
      payload,
    ]);

    expect(result.stdout).toBe(payload);
    // Exit 0, not 99: the "second command" never ran because there was no shell
    // to split the argument into one.
    expect(result.exitCode).toBe(0);
  });

  it('does not expand a variable-looking argument', async () => {
    const result = await exec.run(node, [
      '-e',
      'process.stdout.write(process.argv[1])',
      '$HOME',
    ]);

    // A shell would substitute $HOME; argv passes it through unchanged.
    expect(result.stdout).toBe('$HOME');
  });
});

describe('bounds', () => {
  it('kills a command that exceeds the timeout', async () => {
    const result = await exec.run(node, ['-e', 'setTimeout(() => {}, 60000)'], {
      timeoutMs: 100,
    });

    expect(result.timedOut).toBe(true);
    // Killed by signal, so no clean exit code.
    expect(result.exitCode).toBeNull();
  });

  it('kills a command that floods its output', async () => {
    const result = await exec.run(
      node,
      ['-e', 'while (true) process.stdout.write("x".repeat(1000))'],
      { maxOutputBytes: 5_000, timeoutMs: 5_000 },
    );

    expect(result.truncated).toBe(true);
    // The captured output does not vastly exceed the cap — the process is killed
    // once it crosses, not allowed to run to completion.
    expect(result.stdout.length).toBeLessThan(1_000_000);
  });

  // A process that ignores SIGTERM must still die: the executor escalates to
  // SIGKILL after the grace period.
  it('escalates to SIGKILL when a process ignores SIGTERM', async () => {
    const stubborn = new NodeShellExecutor({ killGraceMs: 100 });
    const result = await stubborn.run(
      node,
      ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'],
      { timeoutMs: 100 },
    );

    expect(result.timedOut).toBe(true);
    // Killed — by SIGKILL, which cannot be trapped — so no clean exit.
    expect(result.exitCode).toBeNull();
  });

  it('cancels a running command on abort', async () => {
    const controller = new AbortController();
    const promise = exec.run(node, ['-e', 'setTimeout(() => {}, 60000)'], {
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 50);

    const result = await promise;

    // Killed by the abort — no clean exit.
    expect(result.exitCode).toBeNull();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    await expect(
      exec.run(node, ['-e', 'process.exit(0)'], { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/Aborted before/);
  });

  it('reports a duration', async () => {
    const result = await exec.run(node, ['-e', 'process.exit(0)']);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe('number');
  });
});

describe('when the command cannot be run', () => {
  // A spawn failure is distinct from a command that ran and failed: it rejects.
  it('rejects with NOT_FOUND for a program that does not exist', async () => {
    await expect(
      exec.run('this-command-definitely-does-not-exist-hermes', []),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws a ShellError, not a raw errno', async () => {
    const error = await exec
      .run('this-command-definitely-does-not-exist-hermes', [])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ShellError);
    expect((error as ShellError).command).toBe(
      'this-command-definitely-does-not-exist-hermes',
    );
  });
});

describe('environment isolation', () => {
  it('does not leak the host environment by default', async () => {
    process.env['HERMES_SHELL_SECRET'] = 'leaked';
    try {
      const result = await exec.run(node, [
        '-e',
        'process.stdout.write(String(process.env.HERMES_SHELL_SECRET))',
      ]);

      // An empty `env` (the default) replaces the ambient one, so the secret is
      // not visible to the child.
      expect(result.stdout).toBe('undefined');
    } finally {
      delete process.env['HERMES_SHELL_SECRET'];
    }
  });

  it('passes exactly the environment it is given', async () => {
    const result = await exec.run(
      node,
      ['-e', 'process.stdout.write(String(process.env.GIVEN))'],
      { env: { GIVEN: 'value' } },
    );

    expect(result.stdout).toBe('value');
  });
});
