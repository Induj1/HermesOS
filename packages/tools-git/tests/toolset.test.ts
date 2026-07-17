/**
 * The git toolset on a real kernel.
 *
 * Proves the tools register, dispatch, and enforce their three-grade permissions
 * through an actual `Runtime` — the arrangement a host wires. The default grant is
 * read-only, so a write tool must be refused until `git:write` is granted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Runtime, sequentialIds } from '@hermes/kernel';
import { catalog, PermissionSet } from '@hermes/tools';
import { gitToolset } from '../src/toolset.js';
import { FakeGitExecutor } from '../src/fake-executor.js';

let runtime: Runtime | undefined;

afterEach(async () => {
  await runtime?.stop({ mode: 'cancel' });
  runtime = undefined;
});

describe('gitToolset on a real runtime', () => {
  it('registers the git tools, tagged, and allows a read by default', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(gitToolset({ executor: FakeGitExecutor.succeedingWith('## main\n') }));
    await runtime.start();

    const described = catalog(runtime.tools);
    expect(described.map((t) => t.name)).toContain('git.status');
    expect(described.every((t) => t.tags?.includes('git'))).toBe(true);

    const snapshot = await runtime.run({
      name: 'status',
      tasks: [{ name: 's', handler: { kind: 'tool', name: 'git.status' }, input: {} }],
    });
    expect(snapshot.tasks[0]?.result).toMatchObject({ branch: 'main', clean: true });
  });

  it('refuses a write with the default read-only grant', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(gitToolset({ executor: FakeGitExecutor.succeedingWith('') }));
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'commit',
      tasks: [
        {
          name: 'c',
          handler: { kind: 'tool', name: 'git.commit' },
          input: { message: 'm' },
        },
      ],
    });
    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /requires the "git:write" permission/,
    );
  });

  it('allows a write once git:write is granted', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      gitToolset({
        executor: FakeGitExecutor.succeedingWith('committed'),
        granted: PermissionSet.none().grant('git:read').grant('git:write'),
      }),
    );
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'commit',
      tasks: [
        {
          name: 'c',
          handler: { kind: 'tool', name: 'git.commit' },
          input: { message: 'm' },
        },
      ],
    });
    expect(snapshot.tasks[0]?.result).toMatchObject({ exitCode: 0 });
  });

  it('refuses a network op until git:network is granted', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      gitToolset({
        executor: FakeGitExecutor.succeedingWith(''),
        granted: PermissionSet.none().grant('git:read').grant('git:write'),
      }),
    );
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'push',
      tasks: [{ name: 'p', handler: { kind: 'tool', name: 'git.push' }, input: {} }],
    });
    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /requires the "git:network" permission/,
    );
  });

  it('takes a custom toolset name', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      gitToolset({ executor: FakeGitExecutor.succeedingWith(''), name: 'vcs' }),
    );
    await runtime.start();
    // The plugin registered under the custom name without throwing.
    expect(catalog(runtime.tools).map((t) => t.name)).toContain('git.status');
  });
});
