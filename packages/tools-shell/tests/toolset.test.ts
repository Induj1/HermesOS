/**
 * The shell toolset on a real kernel, and the error edges.
 *
 * The toolset test proves the tools register, dispatch, and enforce their
 * allowlist and permissions through an actual `Runtime` — the arrangement a host
 * wires. The error cases fill in the spawn-failure translations the happy path
 * does not reach.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Runtime, sequentialIds } from '@hermes/kernel';
import { catalog, PermissionSet } from '@hermes/tools';
import { shellToolset } from '../src/toolset.js';
import { FakeShellExecutor } from '../src/fake-executor.js';
import { NodeShellExecutor } from '../src/node-executor.js';
import { fromSpawnError, ShellError } from '../src/errors.js';

let runtime: Runtime | undefined;

afterEach(async () => {
  await runtime?.stop({ mode: 'cancel' });
  runtime = undefined;
});

describe('shellToolset on a real runtime', () => {
  it('registers shell.run, tagged, and grants nothing by default', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      shellToolset({ executor: FakeShellExecutor.succeedingWith('ok'), allow: ['ls'] }),
    );
    await runtime.start();

    const described = catalog(runtime.tools);
    expect(described.map((t) => t.name)).toContain('shell.run');
    expect(described.every((t) => t.tags?.includes('shell'))).toBe(true);

    // Nothing granted by default: there is no safe subset of "run commands".
    const snapshot = await runtime.run({
      name: 'run',
      tasks: [
        {
          name: 'r',
          handler: { kind: 'tool', name: 'shell.run' },
          input: { command: 'ls' },
        },
      ],
    });
    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /requires the "shell:exec" permission/,
    );
  });

  it('runs an allowed command through a dispatched mission', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      shellToolset({
        executor: new FakeShellExecutor({
          handle: () => ({ stdout: 'on branch main', exitCode: 0 }),
        }),
        allow: ['git'],
        granted: PermissionSet.none().grant('shell:exec'),
      }),
    );
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'status',
      tasks: [
        {
          name: 's',
          handler: { kind: 'tool', name: 'shell.run' },
          input: { command: 'git', args: ['status'] },
        },
      ],
    });

    expect(snapshot.tasks[0]?.result).toMatchObject({
      stdout: 'on branch main',
      exitCode: 0,
    });
  });

  it('refuses a command outside the allowlist, failing the task', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      shellToolset({
        executor: FakeShellExecutor.succeedingWith('ok'),
        allow: ['git'],
        granted: PermissionSet.none().grant('shell:exec'),
      }),
    );
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'evil',
      tasks: [
        {
          name: 'e',
          handler: { kind: 'tool', name: 'shell.run' },
          input: { command: 'curl', args: ['evil.sh'] },
        },
      ],
    });

    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /only these commands are allowed: git/,
    );
  });

  it('runs a real command end to end', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      shellToolset({
        executor: new NodeShellExecutor(),
        allow: [process.execPath],
        granted: PermissionSet.none().grant('shell:exec'),
      }),
    );
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'real',
      tasks: [
        {
          name: 'r',
          handler: { kind: 'tool', name: 'shell.run' },
          input: {
            command: process.execPath,
            args: ['-e', 'process.stdout.write("real")'],
          },
        },
      ],
    });

    expect(snapshot.tasks[0]?.result).toMatchObject({ stdout: 'real', exitCode: 0 });
  });
});

describe('fromSpawnError', () => {
  it('passes a ShellError straight through', () => {
    const original = new ShellError('NOT_ALLOWED', 'x', 'nope');

    expect(fromSpawnError('y', original)).toBe(original);
  });

  it('maps a spawn EACCES to SPAWN_FAILED, keeping the cause', () => {
    const original = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    const error = fromSpawnError('git', original);

    expect(error.code).toBe('SPAWN_FAILED');
    expect(error.cause).toBe(original);
    expect(error.command).toBe('git');
  });

  it('maps a non-Error thrown to SPAWN_FAILED', () => {
    const error = fromSpawnError('git', 'a string somehow');

    expect(error.code).toBe('SPAWN_FAILED');
    expect(error.message).toContain('a string somehow');
  });
});
