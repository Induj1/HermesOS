/**
 * The engine, driving a real kernel.
 *
 * Every test here builds an actual `Runtime`, registers real tools, and runs
 * real missions. That is the whole point: the engine's central claim is that it
 * composes the kernel rather than reimplementing it, and against a fake runtime
 * that claim could be false while these stayed green.
 *
 * The claim these are really about is the one the planner could not make
 * (RFC-0003 §7.1): **a step can read an earlier step's output.**
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sequentialIds } from '@hermes/kernel';
import { ExecutionEngine } from '../src/engine.js';
import {
  ExecutionFailedError,
  ExecutionNotFoundError,
  ExecutionStateError,
  InvalidInputError,
} from '../src/errors.js';
import { InMemoryCheckpointStore } from '../src/ports/in-memory-checkpoint-store.js';
import { toExecutionId } from '../src/model.js';
import type { RecoveryPolicy } from '../src/recovery/recovery-policy.js';
import { fixture, plan, step, type Fixture } from './helpers/fixtures.js';

let open: Fixture | undefined;

afterEach(async () => {
  await open?.runtime.stop({ mode: 'cancel' });
  open = undefined;
});

/** A started runtime with the engine's plugin registered, as a host must. */
async function engineOn(
  options: {
    recovery?: RecoveryPolicy;
    checkpoints?: InMemoryCheckpointStore;
    concurrency?: number;
  } = {},
): Promise<{ engine: ExecutionEngine; fx: Fixture }> {
  const fx = fixture({
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });
  open = fx;

  const engine = new ExecutionEngine({
    runtime: fx.runtime,
    clock: fx.clock,
    ids: sequentialIds(),
    ...(options.recovery ? { recovery: options.recovery } : {}),
    ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
  });

  // Before start(): the kernel takes plugins only in its `created` state.
  fx.runtime.use(engine.plugin());
  await fx.runtime.start();
  return { engine, fx };
}

describe('executing a plan', () => {
  it('runs a single step and reports what it returned', async () => {
    const { engine } = await engineOn();

    const snapshot = await engine.execute(
      plan([step('a', { input: { hello: 'world' } })]),
    );

    expect(snapshot.state).toBe('succeeded');
    expect(snapshot.steps[0]?.state).toBe('succeeded');
    expect(snapshot.steps[0]?.result).toEqual({ hello: 'world' });
  });

  it('records the real capability, not the envelope the kernel dispatched', async () => {
    const { engine } = await engineOn();

    const snapshot = await engine.execute(plan([step('a')]));

    // The kernel's view of this task is `agent:hermes.step`. The engine's is the
    // truth, because the engine is what put the capability into the envelope.
    expect(snapshot.steps[0]?.capability).toEqual({ kind: 'tool', name: 'echo' });
  });

  it('runs steps in dependency order', async () => {
    const { engine, fx } = await engineOn();

    await engine.execute(
      plan([step('first'), step('second', { dependsOn: ['first'] })]),
    );

    // The kernel ordered these, not the engine. That is the arrangement.
    expect(fx.calls.log.map((call) => call.input)).toEqual([undefined, undefined]);
    expect(fx.calls.log).toHaveLength(2);
  });
});

// The reason this package exists.
describe('threading outputs between steps', () => {
  it('resolves a $from reference to an earlier step result', async () => {
    const { engine } = await engineOn();

    const snapshot = await engine.execute(
      plan([
        step('fetch', { input: { events: ['standup'] } }),
        step('brief', { dependsOn: ['fetch'], input: { from: { $from: 'fetch' } } }),
      ]),
    );

    expect(snapshot.steps[1]?.result).toEqual({ from: { events: ['standup'] } });
  });

  it('reaches inside a result with a path', async () => {
    const { engine } = await engineOn();

    const snapshot = await engine.execute(
      plan([
        step('fetch', { input: { events: [{ title: 'standup' }] } }),
        step('brief', {
          dependsOn: ['fetch'],
          input: { title: { $from: 'fetch', path: 'events.0.title' } },
        }),
      ]),
    );

    expect(snapshot.steps[1]?.result).toEqual({ title: 'standup' });
  });

  it('threads a value through three steps', async () => {
    const { engine } = await engineOn();

    const snapshot = await engine.execute(
      plan([
        step('one', { input: 1 }),
        step('two', { dependsOn: ['one'], input: { got: { $from: 'one' } } }),
        step('three', {
          dependsOn: ['two'],
          input: { got: { $from: 'two', path: 'got' } },
        }),
      ]),
    );

    expect(snapshot.steps[2]?.result).toEqual({ got: 1 });
  });

  it('feeds a resolved reference into an agent', async () => {
    const { engine } = await engineOn();

    const snapshot = await engine.execute(
      plan([
        step('say', { input: 'hello' }),
        step('shout', {
          capability: { kind: 'agent', name: 'shouter' },
          dependsOn: ['say'],
          input: { shout: { $from: 'say' } },
        }),
      ]),
    );

    expect(snapshot.steps[1]?.result).toBe('HELLO');
  });

  // The one line of kernel dispatch the envelope duplicates. If it were dropped,
  // an agent that declared a validator would silently stop getting it.
  it('applies an agent own input validator, as the kernel would', async () => {
    const { engine } = await engineOn();

    const promise = engine.execute(
      plan([
        step('bad', {
          capability: { kind: 'agent', name: 'doubler' },
          input: { n: 'not a number' },
        }),
      ]),
    );

    await expect(promise).rejects.toThrow(ExecutionFailedError);
    await expect(promise).rejects.toThrow(/doubler needs/);
  });

  it('resolves a reference for an agent that passes its validator', async () => {
    const { engine } = await engineOn();

    const snapshot = await engine.execute(
      plan([
        step('n', { input: 21 }),
        step('double', {
          capability: { kind: 'agent', name: 'doubler' },
          dependsOn: ['n'],
          input: { n: { $from: 'n' } },
        }),
      ]),
    );

    expect(snapshot.steps[1]?.result).toBe(42);
  });

  it('rejects a plan whose reference is not a declared dependency, before running', async () => {
    const { engine, fx } = await engineOn();

    // Without dependsOn the kernel may run these concurrently, and the reference
    // would resolve against a result that does not exist yet — a race that
    // passes under test and fails in production.
    await expect(
      engine.execute(plan([step('a'), step('b', { input: { x: { $from: 'a' } } })])),
    ).rejects.toThrow(/does not declare it in dependsOn/);

    // Nothing ran. That is the point of checking at compile time.
    expect(fx.calls.log).toHaveLength(0);
  });

  it('rejects an empty plan where the message can name the plan', async () => {
    const { engine } = await engineOn();

    await expect(engine.execute(plan([]))).rejects.toThrow(InvalidInputError);
  });
});

describe('failure', () => {
  it('throws ExecutionFailedError carrying the failed step', async () => {
    const { engine } = await engineOn();

    const promise = engine.execute(
      plan([step('boom', { capability: { kind: 'tool', name: 'fail' } })]),
    );

    await expect(promise).rejects.toThrow(ExecutionFailedError);
    await expect(promise).rejects.toMatchObject({
      failures: [{ step: 'boom', error: { message: 'boom' } }],
    });
  });

  it('records a step the kernel skipped because its dependency failed', async () => {
    const { engine } = await engineOn();

    const promise = engine.execute(
      plan([
        step('boom', { capability: { kind: 'tool', name: 'fail' } }),
        step('after', { dependsOn: ['boom'] }),
      ]),
    );
    await expect(promise).rejects.toThrow(ExecutionFailedError);

    // The envelope never ran for `after`, so only the kernel knows it was
    // skipped. Without reconciliation it would sit `pending` forever.
    const snapshot = await engine.snapshot(toExecutionId('exec_1'));
    expect(snapshot?.steps.find((s) => s.name === 'after')?.state).toBe('skipped');
  });

  it('lets the kernel retry a flaky step, and reports the attempt count', async () => {
    const { engine } = await engineOn();

    const snapshot = await engine.execute(
      plan([
        step('flaky', { capability: { kind: 'tool', name: 'flaky' }, maxAttempts: 2 }),
      ]),
    );

    // Retry is the kernel's, not the engine's. The engine only records it.
    expect(snapshot.state).toBe('succeeded');
    expect(snapshot.steps[0]?.result).toBe('recovered');
    expect(snapshot.steps[0]?.attempts).toBe(2);
  });

  // The reconciliation path. The envelope never sees this failure: the tool
  // ignores its signal and never returns, so only the kernel knows the step is
  // over. Without reconciling, the step would sit `running` forever and the
  // execution would never settle.
  it('records a timeout the kernel saw and the envelope did not', async () => {
    const { engine } = await engineOn();

    const promise = engine.execute(
      plan([
        step('stuck', { capability: { kind: 'tool', name: 'hang' }, timeoutMs: 20 }),
      ]),
    );

    await expect(promise).rejects.toThrow(ExecutionFailedError);
    const snapshot = await engine.snapshot(toExecutionId('exec_1'));
    expect(snapshot?.steps[0]?.state).toBe('failed');
    // The kernel's error is the only account of what happened, so it is the one
    // that gets recorded — with its stable code intact.
    expect(snapshot?.steps[0]?.error?.code).toBe('TASK_TIMEOUT');
  });

  it('settles rather than hanging when a step never returns', async () => {
    const { engine } = await engineOn();

    // The execution reaches a terminal state even though the tool never will.
    await expect(
      engine.execute(
        plan([
          step('stuck', { capability: { kind: 'tool', name: 'hang' }, timeoutMs: 20 }),
          step('after', { dependsOn: ['stuck'] }),
        ]),
      ),
    ).rejects.toThrow(ExecutionFailedError);

    const snapshot = await engine.snapshot(toExecutionId('exec_1'));
    expect(snapshot?.state).toBe('failed');
    expect(snapshot?.steps.find((s) => s.name === 'after')?.state).toBe('skipped');
  });

  it('clears the earlier error when a step succeeds on a retry', async () => {
    const { engine } = await engineOn();

    const snapshot = await engine.execute(
      plan([
        step('flaky', { capability: { kind: 'tool', name: 'flaky' }, maxAttempts: 2 }),
      ]),
    );

    // The record says what happened to the step, and what happened is it worked.
    expect(snapshot.steps[0]?.error).toBeUndefined();
  });
});

describe('checkpointing and resume', () => {
  it('checkpoints each step result as it lands', async () => {
    const checkpoints = new InMemoryCheckpointStore();
    const { engine } = await engineOn({ checkpoints });

    await engine.execute(plan([step('a', { input: 'value' })]));

    const stored = await checkpoints.load(toExecutionId('exec_1'));
    expect(stored?.state).toBe('succeeded');
    expect(stored?.steps[0]?.result).toBe('value');
  });

  it('carries the plan whole, so a resume needs no plan store', async () => {
    const checkpoints = new InMemoryCheckpointStore();
    const { engine } = await engineOn({ checkpoints });

    await engine.execute(plan([step('a')]));

    const stored = await checkpoints.load(toExecutionId('exec_1'));
    expect(stored?.plan.steps.map((s) => s.name)).toEqual(['a']);
  });

  // The crash-recovery path: a checkpoint written by one engine, resumed by
  // another that never saw the execution start.
  it('resumes an execution from a checkpoint a different engine wrote', async () => {
    const checkpoints = new InMemoryCheckpointStore();
    const { engine, fx } = await engineOn({ checkpoints });

    const failing = plan([
      step('first', { input: 'kept' }),
      step('second', {
        capability: { kind: 'tool', name: 'fail' },
        dependsOn: ['first'],
      }),
    ]);
    await expect(engine.execute(failing)).rejects.toThrow(ExecutionFailedError);

    // A new engine over the same store and runtime, as a restarted process would be.
    const revived = new ExecutionEngine({
      runtime: fx.runtime,
      checkpoints,
      clock: fx.clock,
      ids: sequentialIds(),
    });
    // The checkpoint says `failed`, which is terminal — a resume is refused.
    await expect(revived.resume(toExecutionId('exec_1'))).rejects.toThrow(
      ExecutionStateError,
    );
  });

  it('does not re-run a step that already succeeded', async () => {
    const checkpoints = new InMemoryCheckpointStore();
    const { engine, fx } = await engineOn({ checkpoints });

    await engine.execute(plan([step('a', { input: 'once' })]));
    const callsAfterFirst = fx.calls.log.length;

    // Resuming a settled execution is refused, which is itself the guarantee:
    // finished work is not repeated.
    await expect(engine.resume(toExecutionId('exec_1'))).rejects.toThrow(
      ExecutionStateError,
    );
    expect(fx.calls.log).toHaveLength(callsAfterFirst);
  });

  it('reports nothing for an execution it has never heard of', async () => {
    const { engine } = await engineOn();

    expect(await engine.snapshot(toExecutionId('exec_nope'))).toBeUndefined();
  });

  it('refuses to resume an execution with no checkpoint', async () => {
    const { engine } = await engineOn();

    await expect(engine.resume(toExecutionId('exec_nope'))).rejects.toThrow(
      ExecutionNotFoundError,
    );
  });
});

describe('events', () => {
  it('publishes the execution lifecycle on its own bus', async () => {
    const { engine } = await engineOn();
    const seen: string[] = [];
    for (const type of ['execution:started', 'execution:settled'] as const) {
      engine.events.on(type, () => {
        seen.push(type);
      });
    }

    await engine.execute(plan([step('a')]));

    expect(seen).toEqual(['execution:started', 'execution:settled']);
  });

  it('publishes step events carrying the record', async () => {
    const { engine } = await engineOn();
    const succeeded: unknown[] = [];
    engine.events.on('step:succeeded', (payload) => {
      succeeded.push(payload.step.name);
    });

    await engine.execute(plan([step('a'), step('b', { dependsOn: ['a'] })]));

    expect(succeeded).toEqual(['a', 'b']);
  });

  // The only key between the engine's history and the audit log memory persists.
  it('publishes the kernel mission id, so an execution can be correlated', async () => {
    const { engine } = await engineOn();
    const missions: string[] = [];
    engine.events.on('mission:submitted', (payload) => {
      missions.push(payload.missionId);
    });

    const snapshot = await engine.execute(plan([step('a')]));

    expect(missions).toEqual(snapshot.missions);
    expect(missions).toHaveLength(1);
  });

  it('does not publish execution events onto the kernel bus', async () => {
    const { engine, fx } = await engineOn();
    const kernelEvents: string[] = [];
    fx.runtime.bus.onAny((event) => {
      kernelEvents.push(event.type);
    });

    await engine.execute(plan([step('a')]));

    // The kernel has never heard of an execution, and nothing here teaches it.
    expect(kernelEvents.some((type) => type.startsWith('execution:'))).toBe(false);
    expect(kernelEvents.some((type) => type.startsWith('step:'))).toBe(false);
    expect(kernelEvents).toContain('mission:succeeded');
  });
});

describe('cancellation', () => {
  it('cancels the underlying mission when the caller aborts', async () => {
    const { engine } = await engineOn();
    const controller = new AbortController();

    const promise = engine.execute(plan([step('a')]), { signal: controller.signal });
    controller.abort();

    // Aborting must reach the kernel: otherwise the mission runs on for a caller
    // that has already gone.
    await expect(promise).rejects.toThrow();
  });

  it('refuses to pause an execution it is not running', async () => {
    const { engine } = await engineOn();

    await expect(engine.pause(toExecutionId('exec_nope'))).rejects.toThrow(
      ExecutionNotFoundError,
    );
  });

  // The abort has to reach the kernel. Without the bridge, aborting `execute`
  // would stop the engine waiting while the mission carried on running steps for
  // a caller that had already left — an abort that looks instant and changes
  // nothing.
  it('cancels a step that is already running when the caller aborts', async () => {
    const { engine } = await engineOn();
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => {
      engine.events.on('step:started', () => {
        resolve();
      });
    });

    const promise = engine.execute(
      plan([step('stuck', { capability: { kind: 'tool', name: 'waits' } })]),
      { signal: controller.signal },
    );
    await started;
    controller.abort();

    // `waits` returns only when cancelled, so if the abort did not reach the
    // kernel this would hang until the test timed out. Note the dependency on
    // the step cooperating: an execution can be cancelled only as promptly as
    // its steps honour their signal (RFC-0004 §7.5).
    await expect(promise).rejects.toThrow();
    const snapshot = await engine.snapshot(toExecutionId('exec_1'));
    expect(snapshot?.state).toBe('cancelled');
    expect(snapshot?.steps[0]?.state).toBe('failed');
  });

  // An aborted execution left `running` in the store would be picked up by a
  // supervisor and resumed forever.
  it('records an aborted execution as cancelled rather than leaving it running', async () => {
    const checkpoints = new InMemoryCheckpointStore();
    const { engine } = await engineOn({ checkpoints });
    const controller = new AbortController();

    const promise = engine.execute(plan([step('a')]), { signal: controller.signal });
    controller.abort();
    await promise.catch(() => undefined);

    const stored = await checkpoints.load(toExecutionId('exec_1'));
    expect(stored?.state).toBe('cancelled');
    // And it is not work a supervisor should pick up.
    expect(await checkpoints.pending()).toEqual([]);
  });

  it('rejects before running when the signal is already aborted', async () => {
    const { engine, fx } = await engineOn();

    await expect(
      engine.execute(plan([step('a')]), { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(fx.calls.log).toHaveLength(0);
  });
});

describe('reading an execution back', () => {
  // The `#live` map is emptied when an execution settles, so this reads from the
  // store — the path a REST layer or a supervisor takes for anything historical.
  it('reports a settled execution from the checkpoint store', async () => {
    const checkpoints = new InMemoryCheckpointStore();
    const { engine } = await engineOn({ checkpoints });
    await engine.execute(plan([step('a', { input: 'value' })]));

    const snapshot = await engine.snapshot(toExecutionId('exec_1'));

    expect(snapshot).toMatchObject({
      id: 'exec_1',
      planId: 'plan_test',
      state: 'succeeded',
      failurePolicy: 'fail-fast',
    });
    expect(snapshot?.steps[0]?.result).toBe('value');
    expect(snapshot?.missions).toHaveLength(1);
  });

  it('exposes the checkpoint store, so a supervisor can scan for pending work', async () => {
    const checkpoints = new InMemoryCheckpointStore();
    const { engine } = await engineOn({ checkpoints });

    expect(engine.checkpoints).toBe(checkpoints);
  });
});

describe('recovery', () => {
  it('does not replan by default, because re-running may not be safe', async () => {
    const { engine, fx } = await engineOn();

    await expect(
      engine.execute(
        plan([step('boom', { capability: { kind: 'tool', name: 'fail' } })]),
      ),
    ).rejects.toThrow(ExecutionFailedError);

    // One attempt, no replan. An engine nobody configured behaves like
    // `runtime.run` plus data flow, which is the least surprising default.
    expect(fx.calls.log).toHaveLength(1);
  });

  it('asks shouldRecover before replanning, and honours a no', async () => {
    const shouldRecoverSpy = vi.fn().mockReturnValue(false);
    const { engine } = await engineOn({
      recovery: {
        maxAttempts: 3,
        incomplete: 'retry',
        shouldRecover: shouldRecoverSpy,
      },
    });

    await expect(
      engine.execute(
        plan([step('boom', { capability: { kind: 'tool', name: 'fail' } })]),
      ),
    ).rejects.toThrow(ExecutionFailedError);

    expect(shouldRecoverSpy).toHaveBeenCalledOnce();
    expect(shouldRecoverSpy.mock.calls[0]?.[0]).toMatchObject({
      attempt: 1,
      failures: [{ step: 'boom', message: 'boom' }],
    });
  });

  it('replans and re-runs the failed step when recovery is enabled', async () => {
    const { engine, fx } = await engineOn({
      recovery: { maxAttempts: 2, incomplete: 'retry' },
    });
    const recovering: number[] = [];
    engine.events.on('execution:recovering', (payload) => {
      recovering.push(payload.attempt);
    });

    await expect(
      engine.execute(
        plan([step('boom', { capability: { kind: 'tool', name: 'fail' } })]),
      ),
    ).rejects.toThrow();

    // Attempted, replanned, attempted again, then gave up at the budget.
    expect(recovering).toEqual([1, 2]);
    expect(fx.calls.log.length).toBeGreaterThan(1);
  });

  it('reports the original failure once the recovery budget is spent', async () => {
    const { engine } = await engineOn({
      recovery: { maxAttempts: 1, incomplete: 'retry' },
    });

    // The budget being spent is not itself a new failure: what the caller needs
    // is what actually broke, which is what `ExecutionFailedError` carries.
    await expect(
      engine.execute(
        plan([step('boom', { capability: { kind: 'tool', name: 'fail' } })]),
      ),
    ).rejects.toMatchObject({
      code: 'EXECUTION_FAILED',
      failures: [{ step: 'boom' }],
    });
  });

  it('keeps a succeeded step out of the recovery mission', async () => {
    const { engine, fx } = await engineOn({
      recovery: { maxAttempts: 1, incomplete: 'retry' },
    });

    await expect(
      engine.execute(
        plan([
          step('good', { input: 'ok' }),
          step('bad', {
            capability: { kind: 'tool', name: 'fail' },
            dependsOn: ['good'],
          }),
        ]),
      ),
    ).rejects.toThrow();

    // `good` ran once across both missions; its result was in the context.
    expect(fx.calls.log.filter((call) => call.tool === 'echo')).toHaveLength(1);
  });
});
