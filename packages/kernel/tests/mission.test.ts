import { describe, expect, it } from 'vitest';

import { MissionValidationError } from '../src/errors.js';
import { sequentialIds } from '../src/ids.js';
import { Mission, type MissionSpec } from '../src/mission.js';
import type { TaskSpec } from '../src/task.js';

const task = (
  name: string,
  dependsOn: string[] = [],
  extra: Partial<TaskSpec> = {},
): TaskSpec => ({
  name,
  handler: { kind: 'tool', name: 'noop' },
  dependsOn,
  ...extra,
});

const make = (spec: Partial<MissionSpec> = {}): Mission =>
  Mission.create(
    { name: 'test', tasks: [task('a')], ...spec },
    { ids: sequentialIds(), now: 1_000 },
  );

/** Drive a task to succeeded the way the scheduler would. */
const succeed = (mission: Mission, name: string, now = 2_000): void => {
  const t = mission.taskByName(name);
  if (!t) throw new Error(`no task ${name}`);
  t.markRunning(now);
  t.markSucceeded('ok', now);
};

const fail = (mission: Mission, name: string, now = 2_000): void => {
  const t = mission.taskByName(name);
  if (!t) throw new Error(`no task ${name}`);
  t.markRunning(now);
  t.markFailed(new Error('boom'), now);
};

describe('Mission.create', () => {
  it('builds tasks with ids and back-references to the mission', () => {
    const mission = make({ tasks: [task('a'), task('b')] });

    expect(mission.id).toBe('mission_1');
    expect(mission.tasks.map((t) => t.name)).toEqual(['a', 'b']);
    expect(mission.tasks.every((t) => t.missionId === mission.id)).toBe(true);
    expect(mission.state).toBe('pending');
  });

  it('defaults to fail-fast', () => {
    expect(make().failurePolicy).toBe('fail-fast');
  });

  it('carries the goal without interpreting it', () => {
    expect(make({ goal: 'Summarise the day' }).goal).toBe('Summarise the day');
  });

  it('rejects an empty task list', () => {
    expect(() => make({ tasks: [] })).toThrow(MissionValidationError);
  });

  it('rejects a blank mission name', () => {
    expect(() => make({ name: '  ' })).toThrow(/mission name must not be empty/);
  });

  it('rejects duplicate task names', () => {
    expect(() => make({ tasks: [task('a'), task('a')] })).toThrow(
      /duplicate task name "a"/,
    );
  });

  it('rejects a dependency on a task that does not exist', () => {
    expect(() => make({ tasks: [task('a', ['ghost'])] })).toThrow(
      /task "a" depends on unknown task "ghost"/,
    );
  });

  it('rejects a dependency cycle', () => {
    expect(() => make({ tasks: [task('a', ['b']), task('b', ['a'])] })).toThrow(
      /dependency cycle/,
    );
  });

  it('rejects a task that depends on itself', () => {
    expect(() => make({ tasks: [task('a', ['a'])] })).toThrow(
      /task "a" depends on itself/,
    );
  });

  it('rejects a maxAttempts below 1 and a non-positive timeout', () => {
    expect(() => make({ tasks: [task('a', [], { maxAttempts: 0 })] })).toThrow(
      /maxAttempts must be at least 1/,
    );
    expect(() => make({ tasks: [task('a', [], { timeoutMs: 0 })] })).toThrow(
      /timeoutMs must be positive/,
    );
  });

  it('reports every problem at once, not just the first', () => {
    try {
      make({ name: '', tasks: [task('a', ['ghost']), task('a')] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MissionValidationError);
      expect((error as MissionValidationError).issues.length).toBeGreaterThan(1);
    }
  });
});

describe('Mission.refresh', () => {
  it('promotes dependency-free tasks to ready and reports them', () => {
    const mission = make({ tasks: [task('a'), task('b', ['a'])] });

    const changed = mission.refresh(1_000);

    expect(changed.map((t) => t.name)).toEqual(['a']);
    expect(mission.taskByName('a')?.state).toBe('ready');
    expect(mission.taskByName('b')?.state).toBe('pending');
  });

  it('holds a task until every dependency has succeeded', () => {
    const mission = make({ tasks: [task('a'), task('b'), task('c', ['a', 'b'])] });
    mission.refresh(1_000);

    succeed(mission, 'a');
    mission.refresh(2_000);
    expect(mission.taskByName('c')?.state).toBe('pending');

    succeed(mission, 'b');
    mission.refresh(3_000);
    expect(mission.taskByName('c')?.state).toBe('ready');
  });

  it('skips dependents of a failed task, and their dependents in turn', () => {
    const mission = make({ tasks: [task('a'), task('b', ['a']), task('c', ['b'])] });
    mission.refresh(1_000);
    fail(mission, 'a');

    // One call cascades the whole chain: refresh runs to a fixed point.
    const changed = mission.refresh(2_000);

    expect(changed.map((t) => t.name).sort()).toEqual(['b', 'c']);
    expect(mission.taskByName('b')?.state).toBe('skipped');
    expect(mission.taskByName('b')?.error?.message).toBe('Dependency "a" failed');
    expect(mission.taskByName('c')?.state).toBe('skipped');
    expect(mission.taskByName('c')?.error?.message).toBe('Dependency "b" skipped');
  });

  it('leaves an independent branch alone when another fails', () => {
    const mission = make({ tasks: [task('a'), task('b', ['a']), task('x')] });
    mission.refresh(1_000);
    fail(mission, 'a');

    mission.refresh(2_000);

    expect(mission.taskByName('b')?.state).toBe('skipped');
    expect(mission.taskByName('x')?.state).toBe('ready');
  });

  it('reports nothing when nothing changed', () => {
    const mission = make({ tasks: [task('a'), task('b', ['a'])] });
    mission.refresh(1_000);

    expect(mission.refresh(1_000)).toEqual([]);
  });
});

describe('Mission.readyTasks', () => {
  it('orders by priority, highest first', () => {
    const mission = make({
      tasks: [task('low', [], { priority: 1 }), task('high', [], { priority: 10 })],
    });
    mission.refresh(1_000);

    expect(mission.readyTasks(1_000).map((t) => t.name)).toEqual(['high', 'low']);
  });

  it('excludes a task still inside its retry backoff', () => {
    const mission = make({ tasks: [task('a', [], { maxAttempts: 2 })] });
    mission.refresh(1_000);
    const a = mission.taskByName('a');
    a?.markRunning(1_000);
    a?.markRetrying(new Error('flake'), 5_000);

    expect(mission.readyTasks(4_999)).toEqual([]);
    expect(mission.readyTasks(5_000).map((t) => t.name)).toEqual(['a']);
  });

  it('excludes tasks that are not ready', () => {
    const mission = make({ tasks: [task('a'), task('b', ['a'])] });

    expect(mission.readyTasks(1_000)).toEqual([]);
  });
});

describe('Mission settlement', () => {
  it('does not settle while a task can still move', () => {
    const mission = make({ tasks: [task('a'), task('b')] });
    mission.refresh(1_000);
    succeed(mission, 'a');

    expect(mission.trySettle(2_000)).toBe(false);
    expect(mission.state).toBe('pending');
  });

  it('succeeds when every task succeeded', () => {
    const mission = make({ tasks: [task('a'), task('b', ['a'])] });
    mission.refresh(1_000);
    succeed(mission, 'a');
    mission.refresh(2_000);
    succeed(mission, 'b', 3_000);

    expect(mission.trySettle(4_000)).toBe(true);
    expect(mission.state).toBe('succeeded');
    expect(mission.snapshot().finishedAt).toBe(4_000);
  });

  it('fails when any task failed', () => {
    const mission = make({ tasks: [task('a'), task('b', ['a'])] });
    mission.refresh(1_000);
    fail(mission, 'a');
    mission.refresh(2_000);

    expect(mission.trySettle(3_000)).toBe(true);
    expect(mission.state).toBe('failed');
  });

  it('reports failure, not cancellation, when a cancel swept up a real failure', () => {
    // The cause of death is more useful than the mechanism that finished it off.
    const mission = make({ tasks: [task('a'), task('b')] });
    mission.refresh(1_000);
    fail(mission, 'a');
    mission.requestCancel('fail-fast', 2_000);
    mission.refresh(2_000);

    mission.trySettle(3_000);

    expect(mission.state).toBe('failed');
  });

  it('cancels when tasks were cancelled and none failed', () => {
    const mission = make({ tasks: [task('a'), task('b')] });
    mission.refresh(1_000);
    mission.requestCancel('user asked', 2_000);

    expect(mission.trySettle(3_000)).toBe(true);
    expect(mission.state).toBe('cancelled');
  });

  it('settles only once', () => {
    const mission = make();
    mission.refresh(1_000);
    succeed(mission, 'a');

    expect(mission.trySettle(2_000)).toBe(true);
    expect(mission.trySettle(3_000)).toBe(false);
    expect(mission.snapshot().finishedAt).toBe(2_000);
  });
});

describe('Mission.requestCancel', () => {
  it('cancels queued tasks and records the reason', () => {
    const mission = make({ tasks: [task('a'), task('b', ['a'])] });
    mission.refresh(1_000);

    const changed = mission.requestCancel('user asked', 2_000);

    expect(changed.map((t) => t.name).sort()).toEqual(['a', 'b']);
    expect(mission.taskByName('a')?.error?.message).toBe('user asked');
    expect(mission.cancelRequested).toBe(true);
  });

  it('leaves a running task to unwind through its own signal', () => {
    const mission = make({ tasks: [task('a'), task('b')] });
    mission.refresh(1_000);
    mission.taskByName('a')?.markRunning(1_000);

    const changed = mission.requestCancel('stop', 2_000);

    expect(changed.map((t) => t.name)).toEqual(['b']);
    expect(mission.taskByName('a')?.state).toBe('running');
  });
});

describe('Mission.start', () => {
  it('is idempotent', () => {
    const mission = make();

    expect(mission.start()).toBe(true);
    expect(mission.start()).toBe(false);
    expect(mission.state).toBe('running');
  });
});

describe('Mission.snapshot', () => {
  it('is plain data covering every task', () => {
    const mission = make({
      tasks: [task('a'), task('b', ['a'])],
      goal: 'g',
      metadata: { source: 'test' },
    });

    const snapshot = mission.snapshot();

    expect(snapshot).toMatchObject({
      id: 'mission_1',
      name: 'test',
      goal: 'g',
      state: 'pending',
      metadata: { source: 'test' },
    });
    expect(snapshot.tasks).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(snapshot))).toBeTruthy();
  });
});
