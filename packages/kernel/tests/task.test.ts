import { describe, expect, it } from 'vitest';

import { InvalidTransitionError } from '../src/errors.js';
import { toMissionId, toTaskId } from '../src/ids.js';
import { Task, type TaskSpec } from '../src/task.js';

const MISSION = toMissionId('mission_1');

const makeTask = (spec: Partial<TaskSpec> = {}): Task =>
  new Task({
    id: toTaskId('task_1'),
    missionId: MISSION,
    createdAt: 1_000,
    spec: { name: 'work', handler: { kind: 'tool', name: 'noop' }, ...spec },
  });

describe('Task', () => {
  it('starts pending with no attempts', () => {
    const task = makeTask();

    expect(task.state).toBe('pending');
    expect(task.attempts).toBe(0);
    expect(task.isTerminal).toBe(false);
  });

  it('applies defaults for the optional spec fields', () => {
    const task = makeTask();

    expect(task.dependsOn).toEqual([]);
    expect(task.priority).toBe(0);
    expect(task.maxAttempts).toBe(1);
    expect(task.timeoutMs).toBeUndefined();
    expect(task.metadata).toEqual({});
  });

  it('runs the happy path pending -> ready -> running -> succeeded', () => {
    const task = makeTask();

    task.markReady();
    expect(task.state).toBe('ready');

    task.markRunning(2_000);
    expect(task.state).toBe('running');

    task.markSucceeded({ ok: true }, 3_000);
    expect(task.state).toBe('succeeded');
    expect(task.result).toEqual({ ok: true });
    expect(task.isTerminal).toBe(true);
  });

  it('counts an attempt per run, and stamps startedAt only on the first', () => {
    const task = makeTask({ maxAttempts: 3 });
    task.markReady();

    task.markRunning(2_000);
    expect(task.attempts).toBe(1);

    task.markRetrying(new Error('flake'), 2_500);
    task.markRunning(3_000);
    expect(task.attempts).toBe(2);
    // startedAt is when the task first began, not when the latest retry did.
    expect(task.snapshot().startedAt).toBe(2_000);
  });

  it('refuses to move out of a terminal state', () => {
    const task = makeTask();
    task.markReady();
    task.markRunning(2_000);
    task.markSucceeded('done', 3_000);

    expect(() => {
      task.markRunning(4_000);
    }).toThrow(InvalidTransitionError);
    expect(task.state).toBe('succeeded');
  });

  it('refuses to run without being made ready first', () => {
    expect(() => {
      makeTask().markRunning(1);
    }).toThrow(InvalidTransitionError);
  });

  it('names the task in transition errors', () => {
    const task = makeTask({ name: 'send-email' });

    expect(() => {
      task.markRunning(1);
    }).toThrow(/task "send-email" cannot transition from "pending" to "running"/);
  });

  describe('canRetry', () => {
    it('is false once the only attempt is spent', () => {
      const task = makeTask({ maxAttempts: 1 });
      task.markReady();
      task.markRunning(1);

      expect(task.canRetry).toBe(false);
    });

    it('is true while attempts remain', () => {
      const task = makeTask({ maxAttempts: 2 });
      task.markReady();
      task.markRunning(1);

      expect(task.canRetry).toBe(true);
    });
  });

  it('markRetrying returns the task to ready and gates it behind notBefore', () => {
    const task = makeTask({ maxAttempts: 2 });
    task.markReady();
    task.markRunning(1_000);

    task.markRetrying(new Error('flake'), 1_500);

    expect(task.state).toBe('ready');
    expect(task.notBefore).toBe(1_500);
    // The error is kept so an observer can see *why* the retry is happening.
    expect(task.error?.message).toBe('flake');
  });

  it('markFailed is terminal and records the error', () => {
    const task = makeTask();
    task.markReady();
    task.markRunning(1_000);

    task.markFailed(new Error('nope'), 2_000);

    expect(task.state).toBe('failed');
    expect(task.error?.message).toBe('nope');
    expect(task.snapshot().finishedAt).toBe(2_000);
  });

  it('cancels straight from pending, without ever running', () => {
    const task = makeTask();

    task.markCancelled(new Error('shutdown'), 5_000);

    expect(task.state).toBe('cancelled');
    expect(task.attempts).toBe(0);
  });

  it('skips from pending, recording the reason', () => {
    const task = makeTask();

    task.markSkipped('Dependency "fetch" failed', 5_000);

    expect(task.state).toBe('skipped');
    expect(task.error?.message).toBe('Dependency "fetch" failed');
  });

  it('clears a previous error when a retry finally succeeds', () => {
    const task = makeTask({ maxAttempts: 2 });
    task.markReady();
    task.markRunning(1_000);
    task.markRetrying(new Error('flake'), 1_100);
    task.markRunning(1_200);

    task.markSucceeded('ok', 1_300);

    expect(task.error).toBeUndefined();
  });

  it('snapshots as plain data that does not track later changes', () => {
    const task = makeTask({ name: 'work', priority: 5, dependsOn: ['other'] });
    task.markReady();

    const before = task.snapshot();
    task.markRunning(2_000);

    expect(before.state).toBe('ready');
    expect(task.snapshot().state).toBe('running');
    expect(before).toMatchObject({
      id: 'task_1',
      missionId: 'mission_1',
      name: 'work',
      priority: 5,
      dependsOn: ['other'],
      handler: { kind: 'tool', name: 'noop' },
    });
  });
});
