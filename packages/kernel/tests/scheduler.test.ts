import { describe, expect, it, vi } from 'vitest';

import { TestClock } from '../src/clock.js';
import { EventBus } from '../src/event-bus.js';
import { TaskTimeoutError } from '../src/errors.js';
import type { KernelEventMap } from '../src/events.js';
import { sequentialIds } from '../src/ids.js';
import { Mission, type MissionSpec } from '../src/mission.js';
import { Scheduler, type TaskExecutor } from '../src/scheduler.js';
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

interface Harness {
  readonly scheduler: Scheduler;
  readonly bus: EventBus<KernelEventMap>;
  readonly clock: TestClock;
  readonly events: string[];
  mission(spec?: Partial<MissionSpec>): Mission;
}

const harness = (
  executor: TaskExecutor,
  options: { concurrency?: number; retryDelay?: (attempt: number) => number } = {},
): Harness => {
  const bus = new EventBus<KernelEventMap>();
  const clock = new TestClock(1_000);
  const events: string[] = [];
  bus.onAny((event) => void events.push(event.type));
  // One generator for the whole harness: a fresh one per mission would hand out
  // the same id twice and the scheduler would treat two missions as one.
  const ids = sequentialIds();

  const scheduler = new Scheduler({
    bus,
    clock,
    executor,
    concurrency: options.concurrency ?? 4,
    retryDelay: options.retryDelay ?? (() => 0),
  });
  scheduler.start();

  return {
    scheduler,
    bus,
    clock,
    events,
    mission: (spec = {}) =>
      Mission.create(
        { name: 'm', tasks: [task('a')], ...spec },
        { ids, now: clock.now() },
      ),
  };
};

describe('Scheduler', () => {
  it('runs a single task and settles the mission', async () => {
    const h = harness(() => Promise.resolve('done'));

    const result = await h.scheduler.submit(h.mission());

    expect(result.state).toBe('succeeded');
    expect(result.tasks[0]).toMatchObject({
      state: 'succeeded',
      result: 'done',
      attempts: 1,
    });
  });

  it('passes the task to the executor', async () => {
    const executor = vi.fn<TaskExecutor>().mockResolvedValue('ok');
    const h = harness(executor);

    await h.scheduler.submit(
      h.mission({ tasks: [task('only', [], { input: { x: 1 } })] }),
    );

    const seen = executor.mock.calls[0]?.[0];
    expect(seen?.name).toBe('only');
    expect(seen?.input).toEqual({ x: 1 });
  });

  it('honours dependency order', async () => {
    const order: string[] = [];
    const h = harness((t) => {
      order.push(t.name);
      return Promise.resolve(null);
    });

    await h.scheduler.submit(
      h.mission({ tasks: [task('c', ['b']), task('b', ['a']), task('a')] }),
    );

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('runs independent tasks concurrently, up to the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const h = harness(
      () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<void>((resolve) => {
          release.push(() => {
            inFlight -= 1;
            resolve();
          });
        });
      },
      { concurrency: 2 },
    );

    const settled = h.scheduler.submit(
      h.mission({ tasks: [task('a'), task('b'), task('c'), task('d')] }),
    );

    // Only two of the four start; the rest wait for a slot.
    await vi.waitFor(() => {
      expect(release).toHaveLength(2);
    });
    expect(h.scheduler.inFlight).toBe(2);

    // Release one at a time; each frees a slot the next task takes.
    for (let i = 0; i < 4; i += 1) {
      await vi.waitFor(() => {
        expect(release.length).toBeGreaterThan(0);
      });
      release.shift()?.();
    }

    const result = await settled;
    expect(result.state).toBe('succeeded');
    expect(peak).toBe(2);
  });

  it('runs the highest-priority ready task first', async () => {
    const order: string[] = [];
    const h = harness(
      (t) => {
        order.push(t.name);
        return Promise.resolve(null);
      },
      { concurrency: 1 },
    );

    await h.scheduler.submit(
      h.mission({
        tasks: [
          task('low', [], { priority: 1 }),
          task('high', [], { priority: 10 }),
          task('mid', [], { priority: 5 }),
        ],
      }),
    );

    expect(order).toEqual(['high', 'mid', 'low']);
  });

  it('emits the task lifecycle in order', async () => {
    const h = harness(() => Promise.resolve('ok'));

    await h.scheduler.submit(h.mission());

    expect(h.events).toEqual([
      'mission:submitted',
      'mission:started',
      'task:ready',
      'task:started',
      'task:succeeded',
      'mission:succeeded',
      'scheduler:idle',
    ]);
  });

  it('reports task duration from the clock', async () => {
    const h = harness(async () => {
      await h.clock.advance(500);
      return 'ok';
    });
    const durations: number[] = [];
    h.bus.on('task:succeeded', ({ durationMs }) => void durations.push(durationMs));

    await h.scheduler.submit(h.mission());

    expect(durations).toEqual([500]);
  });

  describe('failure', () => {
    it('fails the task and the mission when the executor rejects', async () => {
      const h = harness(() => Promise.reject(new Error('boom')));

      const result = await h.scheduler.submit(h.mission());

      expect(result.state).toBe('failed');
      expect(result.tasks[0]).toMatchObject({ state: 'failed' });
      expect(result.tasks[0]?.error?.message).toBe('boom');
    });

    it('resolves rather than rejects on failure, so the caller sees the whole picture', async () => {
      const h = harness(() => Promise.reject(new Error('boom')));

      await expect(h.scheduler.submit(h.mission())).resolves.toMatchObject({
        state: 'failed',
      });
    });

    it('coerces a non-Error throw', async () => {
      // Rejecting with a non-Error is the whole point of this test.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      const h = harness(() => Promise.reject('just a string'));

      const result = await h.scheduler.submit(h.mission());

      expect(result.tasks[0]?.error).toBeInstanceOf(Error);
    });

    it('skips dependents of a failed task', async () => {
      const h = harness((t) =>
        t.name === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
      );

      const result = await h.scheduler.submit(
        h.mission({ tasks: [task('a'), task('b', ['a'])] }),
      );

      expect(result.tasks.find((t) => t.name === 'b')?.state).toBe('skipped');
    });

    it('fail-fast cancels the independent branch too', async () => {
      const h = harness(
        (t) =>
          t.name === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
        { concurrency: 1 },
      );

      const result = await h.scheduler.submit(
        h.mission({
          failurePolicy: 'fail-fast',
          tasks: [task('a', [], { priority: 10 }), task('independent')],
        }),
      );

      expect(result.state).toBe('failed');
      expect(result.tasks.find((t) => t.name === 'independent')?.state).toBe(
        'cancelled',
      );
    });

    it('continue lets the independent branch finish', async () => {
      const h = harness(
        (t) =>
          t.name === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
        { concurrency: 1 },
      );

      const result = await h.scheduler.submit(
        h.mission({
          failurePolicy: 'continue',
          tasks: [
            task('a', [], { priority: 10 }),
            task('independent'),
            task('b', ['a']),
          ],
        }),
      );

      expect(result.state).toBe('failed');
      expect(result.tasks.find((t) => t.name === 'independent')?.state).toBe(
        'succeeded',
      );
      expect(result.tasks.find((t) => t.name === 'b')?.state).toBe('skipped');
    });
  });

  describe('retry', () => {
    it('retries up to maxAttempts and can still succeed', async () => {
      let calls = 0;
      const h = harness(() => {
        calls += 1;
        return calls < 3
          ? Promise.reject(new Error('flake'))
          : Promise.resolve('finally');
      });

      const result = await h.scheduler.submit(
        h.mission({ tasks: [task('a', [], { maxAttempts: 3 })] }),
      );

      expect(result.state).toBe('succeeded');
      expect(result.tasks[0]).toMatchObject({ result: 'finally', attempts: 3 });
    });

    it('gives up after the last attempt', async () => {
      let calls = 0;
      const h = harness(() => {
        calls += 1;
        return Promise.reject(new Error('always'));
      });

      const result = await h.scheduler.submit(
        h.mission({ tasks: [task('a', [], { maxAttempts: 2 })] }),
      );

      expect(calls).toBe(2);
      expect(result.tasks[0]).toMatchObject({ state: 'failed', attempts: 2 });
    });

    it('does not retry a task with the default maxAttempts of 1', async () => {
      const executor = vi.fn<TaskExecutor>().mockRejectedValue(new Error('boom'));
      const h = harness(executor);

      await h.scheduler.submit(h.mission());

      expect(executor).toHaveBeenCalledOnce();
    });

    it('emits task:retrying with the backoff delay', async () => {
      let calls = 0;
      const h = harness(
        () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error('flake'))
            : Promise.resolve('ok');
        },
        { retryDelay: () => 250 },
      );
      const retries: number[] = [];
      h.bus.on('task:retrying', ({ delayMs }) => void retries.push(delayMs));

      const settled = h.scheduler.submit(
        h.mission({ tasks: [task('a', [], { maxAttempts: 2 })] }),
      );
      await vi.waitFor(() => {
        expect(retries).toEqual([250]);
      });

      await h.clock.advance(250);
      await settled;
    });

    it('waits out the backoff before retrying', async () => {
      let calls = 0;
      const h = harness(
        () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error('flake'))
            : Promise.resolve('ok');
        },
        { retryDelay: () => 1_000 },
      );

      const settled = h.scheduler.submit(
        h.mission({ tasks: [task('a', [], { maxAttempts: 2 })] }),
      );
      await vi.waitFor(() => {
        expect(calls).toBe(1);
      });

      await h.clock.advance(999);
      expect(calls).toBe(1);

      await h.clock.advance(1);
      await settled;
      expect(calls).toBe(2);
    });

    it('does not hold a concurrency slot while backing off', async () => {
      const started: string[] = [];
      const h = harness(
        (t) => {
          started.push(`${t.name}#${String(t.attempts)}`);
          return t.name === 'flaky' && t.attempts === 1
            ? Promise.reject(new Error('flake'))
            : Promise.resolve('ok');
        },
        { concurrency: 1, retryDelay: () => 1_000 },
      );

      const retrying = new Promise<void>((resolve) =>
        h.bus.once('task:retrying', () => {
          resolve();
        }),
      );
      const settled = h.scheduler.submit(
        h.mission({
          tasks: [task('flaky', [], { maxAttempts: 2, priority: 10 }), task('other')],
        }),
      );

      // Wait for the backoff to actually be scheduled before moving the clock —
      // advancing past a timer that does not exist yet would strand it.
      await retrying;
      await vi.waitFor(() => {
        expect(h.clock.pendingTimers).toBe(1);
      });

      // The one slot went to 'other' rather than sitting idle behind the backoff.
      expect(started).toEqual(['flaky#1', 'other#1']);
      expect(h.scheduler.inFlight).toBe(0);

      await h.clock.advance(1_000);
      const result = await settled;

      expect(result.state).toBe('succeeded');
      expect(started).toEqual(['flaky#1', 'other#1', 'flaky#2']);
    });
  });

  describe('timeout', () => {
    it('fails a task that outruns its budget, and aborts its signal', async () => {
      let aborted = false;
      const h = harness((_t, signal) => {
        signal.addEventListener('abort', () => void (aborted = true));
        return new Promise<never>(() => undefined);
      });

      const settled = h.scheduler.submit(
        h.mission({ tasks: [task('slow', [], { timeoutMs: 100 })] }),
      );
      await vi.waitFor(() => {
        expect(h.scheduler.inFlight).toBe(1);
      });
      await h.clock.advance(100);

      const result = await settled;
      expect(result.tasks[0]?.state).toBe('failed');
      expect(result.tasks[0]?.error).toBeInstanceOf(TaskTimeoutError);
      expect(aborted).toBe(true);
    });

    it('leaves no timer behind when the work finishes first', async () => {
      const h = harness(() => Promise.resolve('quick'));

      const result = await h.scheduler.submit(
        h.mission({ tasks: [task('a', [], { timeoutMs: 10_000 })] }),
      );

      expect(result.state).toBe('succeeded');
      expect(h.clock.pendingTimers).toBe(0);
    });

    it('a timeout is retryable like any other failure', async () => {
      const h = harness(
        (t) =>
          t.attempts === 1
            ? new Promise<never>(() => undefined)
            : Promise.resolve('ok'),
        { retryDelay: () => 0 },
      );

      const settled = h.scheduler.submit(
        h.mission({ tasks: [task('a', [], { timeoutMs: 100, maxAttempts: 2 })] }),
      );
      await vi.waitFor(() => {
        expect(h.scheduler.inFlight).toBe(1);
      });
      await h.clock.advance(100);

      const result = await settled;
      expect(result.state).toBe('succeeded');
      expect(result.tasks[0]?.attempts).toBe(2);
    });
  });

  describe('cancellation', () => {
    it('aborts running tasks and cancels queued ones', async () => {
      const started: string[] = [];
      const h = harness(
        (t, signal) => {
          started.push(t.name);
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          });
        },
        { concurrency: 1 },
      );

      const mission = h.mission({
        tasks: [task('a', [], { priority: 10 }), task('b')],
      });
      const settled = h.scheduler.submit(mission);
      await vi.waitFor(() => {
        expect(started).toEqual(['a']);
      });

      await h.scheduler.cancelMission(mission.id, 'user asked');

      const result = await settled;
      expect(result.state).toBe('cancelled');
      expect(result.tasks.map((t) => t.state)).toEqual(['cancelled', 'cancelled']);
    });

    it('a cancelled task is not retried', async () => {
      let calls = 0;
      const h = harness((_t, signal) => {
        calls += 1;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      });

      const mission = h.mission({ tasks: [task('a', [], { maxAttempts: 5 })] });
      const settled = h.scheduler.submit(mission);
      await vi.waitFor(() => {
        expect(calls).toBe(1);
      });

      await h.scheduler.cancelMission(mission.id);
      await settled;

      expect(calls).toBe(1);
    });

    it('cancelling an unknown mission is a no-op', async () => {
      const h = harness(() => Promise.resolve(null));

      await expect(h.scheduler.cancelMission(h.mission().id)).resolves.toBeUndefined();
    });

    it('cancelAll settles every active mission', async () => {
      // Honours the signal: the kernel aborts cooperatively and cannot force-kill
      // an executor that ignores it.
      const h = harness(
        (_t, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      );
      const first = h.scheduler.submit(h.mission({ tasks: [task('a')] }));
      const second = h.scheduler.submit(h.mission({ tasks: [task('b')] }));
      await vi.waitFor(() => {
        expect(h.scheduler.inFlight).toBe(2);
      });

      await h.scheduler.cancelAll('shutting down');

      expect((await first).state).toBe('cancelled');
      expect((await second).state).toBe('cancelled');
      expect(h.scheduler.activeMissions).toBe(0);
    });
  });

  describe('start and stop', () => {
    it('dispatches nothing until started', async () => {
      const executor = vi.fn<TaskExecutor>().mockResolvedValue('ok');
      const h = harness(executor);
      h.scheduler.stop();

      void h.scheduler.submit(h.mission());
      await vi.waitFor(() => {
        expect(h.scheduler.activeMissions).toBe(1);
      });

      expect(executor).not.toHaveBeenCalled();

      h.scheduler.start();
      await vi.waitFor(() => {
        expect(executor).toHaveBeenCalledOnce();
      });
    });

    it('start is idempotent', async () => {
      const h = harness(() => Promise.resolve('ok'));
      h.scheduler.start();
      h.scheduler.start();

      await expect(h.scheduler.submit(h.mission())).resolves.toMatchObject({
        state: 'succeeded',
      });
    });
  });

  describe('drain', () => {
    it('resolves immediately when there is nothing to do', async () => {
      const h = harness(() => Promise.resolve('ok'));

      await expect(h.scheduler.drain()).resolves.toBeUndefined();
    });

    it('waits for in-flight work', async () => {
      let release = (): void => undefined;
      const h = harness(() => new Promise<void>((resolve) => (release = resolve)));
      const settled = h.scheduler.submit(h.mission());
      await vi.waitFor(() => {
        expect(h.scheduler.inFlight).toBe(1);
      });

      let drained = false;
      const draining = h.scheduler.drain().then(() => void (drained = true));
      await Promise.resolve();
      expect(drained).toBe(false);

      release();
      await settled;
      await draining;
      expect(drained).toBe(true);
    });
  });

  it('runs several missions at once', async () => {
    const h = harness((t) => Promise.resolve(t.name));

    const [first, second] = await Promise.all([
      h.scheduler.submit(h.mission({ name: 'first', tasks: [task('a')] })),
      h.scheduler.submit(h.mission({ name: 'second', tasks: [task('b')] })),
    ]);

    expect(first.state).toBe('succeeded');
    expect(second.state).toBe('succeeded');
    expect(h.scheduler.activeMissions).toBe(0);
  });
});
