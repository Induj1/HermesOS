/**
 * Pause and resume, against a real kernel.
 *
 * ## What is actually being tested
 *
 * That pause is **cancel-and-checkpoint**, and that resume is a *new mission for
 * the unfinished part*. The kernel has no pause and this does not add one: a
 * mission runs to settlement or is cancelled, and there is no way back from the
 * second (RFC-0001 §11.3).
 *
 * The rejected alternative — the envelope blocking at dispatch until un-paused —
 * would hold its concurrency slot, and a plan wider than the concurrency budget
 * would deadlock with every slot held by a step waiting for a resume that needs a
 * slot to happen. `deadlocks under the rejected design` below is the test that
 * would catch anyone reintroducing it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { defineTool, sequentialIds } from '@hermes/kernel';
import { ExecutionEngine } from '../src/engine.js';
import { InMemoryCheckpointStore } from '../src/ports/in-memory-checkpoint-store.js';
import { toExecutionId } from '../src/model.js';
import { fixture, plan, step, type Fixture } from './helpers/fixtures.js';

let open: Fixture | undefined;

afterEach(async () => {
  await open?.runtime.stop({ mode: 'cancel' });
  open = undefined;
});

/**
 * A runtime with a tool that blocks until the test releases it.
 *
 * Takes a checkpoint store so a second call can stand in for a **restarted
 * process**: a new runtime, a new engine, the same store. That is the honest
 * shape of crash recovery, and it is forced rather than chosen — the engine's
 * envelope is a plugin, the kernel takes plugins only before `start()`, so one
 * runtime hosts exactly one engine. Two engines sharing a started runtime is not
 * a scenario that exists.
 */
function gated(checkpoints = new InMemoryCheckpointStore()): {
  fx: Fixture;
  engine: ExecutionEngine;
  checkpoints: InMemoryCheckpointStore;
  release: () => void;
  reached: Promise<void>;
} {
  const fx = fixture();
  open = fx;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });

  fx.runtime.use({
    name: 'gate',
    setup(ctx) {
      ctx.registerTool(
        defineTool<unknown, string>({
          name: 'gated',
          description: 'Blocks until the test lets it go, or until it is cancelled',
          // Honours its signal, as RFC-0001 §11.1 expects long-running work to:
          // the kernel's cancellation is cooperative, and a tool that ignored it
          // would keep running after a pause cancelled its mission and report a
          // result for work nobody is waiting for.
          execute: (_input, toolCtx) =>
            new Promise<string>((resolve, reject) => {
              fx.calls.log.push({ tool: 'gated', input: undefined });
              arrive();
              const onAbort = (): void => {
                reject(new Error('cancelled'));
              };
              toolCtx.signal.addEventListener('abort', onAbort, { once: true });
              void gate.then(() => {
                toolCtx.signal.removeEventListener('abort', onAbort);
                resolve('let through');
              });
            }),
        }),
      );
    },
  });

  const engine = new ExecutionEngine({
    runtime: fx.runtime,
    checkpoints,
    clock: fx.clock,
    ids: sequentialIds(),
  });
  fx.runtime.use(engine.plugin());

  return { fx, engine, checkpoints, release, reached };
}

describe('pause', () => {
  it('cancels the mission and records the execution as paused', async () => {
    const { fx, engine, release, reached } = gated();
    await fx.runtime.start();

    const running = engine.execute(
      plan([step('slow', { capability: { kind: 'tool', name: 'gated' } })]),
    );
    await reached;

    const paused = await engine.pause(toExecutionId('exec_1'));

    expect(paused.state).toBe('paused');
    release();
    await running.catch(() => undefined);
  });

  it('writes a checkpoint that a different process could pick up', async () => {
    const { fx, engine, checkpoints, release, reached } = gated();
    await fx.runtime.start();

    const running = engine.execute(
      plan([step('slow', { capability: { kind: 'tool', name: 'gated' } })]),
    );
    await reached;
    await engine.pause(toExecutionId('exec_1'));

    const stored = await checkpoints.load(toExecutionId('exec_1'));
    expect(stored?.state).toBe('paused');
    // Carried whole, so resume needs no plan store and no strategy to re-plan.
    expect(stored?.plan.steps.map((s) => s.name)).toEqual(['slow']);

    release();
    await running.catch(() => undefined);
  });

  it('reports a paused execution as still pending work', async () => {
    const { fx, engine, checkpoints, release, reached } = gated();
    await fx.runtime.start();

    const running = engine.execute(
      plan([step('slow', { capability: { kind: 'tool', name: 'gated' } })]),
    );
    await reached;
    await engine.pause(toExecutionId('exec_1'));

    // What a supervisor asks on boot.
    expect((await checkpoints.pending()).map((c) => c.id)).toEqual(['exec_1']);

    release();
    await running.catch(() => undefined);
  });

  it('emits execution:paused, so an operator sees a decision rather than an incident', async () => {
    const { fx, engine, release, reached } = gated();
    await fx.runtime.start();
    const paused: string[] = [];
    engine.events.on('execution:paused', (payload) => {
      paused.push(payload.execution.id);
    });

    const running = engine.execute(
      plan([step('slow', { capability: { kind: 'tool', name: 'gated' } })]),
    );
    await reached;
    await engine.pause(toExecutionId('exec_1'));

    expect(paused).toEqual(['exec_1']);

    release();
    await running.catch(() => undefined);
  });

  it('returns the paused snapshot from execute rather than treating it as a failure', async () => {
    const { fx, engine, release, reached } = gated();
    await fx.runtime.start();

    const running = engine.execute(
      plan([step('slow', { capability: { kind: 'tool', name: 'gated' } })]),
    );
    await reached;
    await engine.pause(toExecutionId('exec_1'));
    release();

    // Pause is a decision. `execute` resolves rather than throwing.
    const settled = await running;
    expect(settled.state).toBe('paused');
  });
});

describe('resume', () => {
  it('does not re-run a step that already succeeded', async () => {
    const { fx, engine, release, reached } = gated();
    await fx.runtime.start();

    const running = engine.execute(
      plan([
        step('done', { input: 'first' }),
        step('slow', {
          capability: { kind: 'tool', name: 'gated' },
          dependsOn: ['done'],
        }),
      ]),
    );
    await reached;
    await engine.pause(toExecutionId('exec_1'));
    release();
    await running;

    expect(fx.calls.log.filter((call) => call.tool === 'echo')).toHaveLength(1);

    const resumed = await engine.resume(toExecutionId('exec_1'));

    // `done` was excluded from the resume mission; its result came from the
    // context, which is exactly why the context outlives the mission.
    expect(fx.calls.log.filter((call) => call.tool === 'echo')).toHaveLength(1);
    // `slow` was cancelled by the pause, so the resume really did re-run it —
    // without which this test would pass by doing nothing at all.
    expect(fx.calls.log.filter((call) => call.tool === 'gated')).toHaveLength(2);
    expect(resumed.state).toBe('succeeded');
    expect(resumed.steps.find((s) => s.name === 'slow')?.result).toBe('let through');
  });

  it('still resolves a $from into a step the resume did not re-run', async () => {
    const { fx, engine, release, reached } = gated();
    await fx.runtime.start();

    const running = engine.execute(
      plan([
        step('fetch', { input: { value: 'threaded' } }),
        step('slow', {
          capability: { kind: 'tool', name: 'gated' },
          dependsOn: ['fetch'],
        }),
        step('use', {
          dependsOn: ['fetch'],
          input: { got: { $from: 'fetch', path: 'value' } },
        }),
      ]),
    );
    await reached;
    await engine.pause(toExecutionId('exec_1'));
    release();
    await running;

    const resumed = await engine.resume(toExecutionId('exec_1'));

    // The whole reason a checkpoint stores results rather than just states.
    expect(resumed.steps.find((s) => s.name === 'use')?.result).toEqual({
      got: 'threaded',
    });
  });

  it('emits execution:resumed', async () => {
    const { fx, engine, release, reached } = gated();
    await fx.runtime.start();
    const resumed: string[] = [];
    engine.events.on('execution:resumed', (payload) => {
      resumed.push(payload.execution.id);
    });

    const running = engine.execute(
      plan([step('slow', { capability: { kind: 'tool', name: 'gated' } })]),
    );
    await reached;
    await engine.pause(toExecutionId('exec_1'));
    release();
    await running;

    await engine.resume(toExecutionId('exec_1'));

    expect(resumed).toEqual(['exec_1']);
  });

  // The crash-recovery path, which is the same code path as pause. That is the
  // payoff for making pause a cancel rather than a special state.
  it('is picked up by a restarted process that never saw it start', async () => {
    const first = gated();
    await first.fx.runtime.start();

    const running = first.engine.execute(
      plan([
        step('done', { input: 'kept' }),
        step('slow', {
          capability: { kind: 'tool', name: 'gated' },
          dependsOn: ['done'],
        }),
      ]),
    );
    await first.reached;
    await first.engine.pause(toExecutionId('exec_1'));
    first.release();
    await running;

    // The process dies. Its runtime goes with it — an engine's envelope is a
    // plugin, and a plugin belongs to the runtime it was registered on.
    await first.fx.runtime.stop({ mode: 'cancel' });

    // A new process: new runtime, new engine, same store. The checkpoint is its
    // only input, which is exactly what it carries the plan whole for.
    const second = gated(first.checkpoints);
    second.release();
    await second.fx.runtime.start();

    const resumed = await second.engine.resume(toExecutionId('exec_1'));

    expect(resumed.state).toBe('succeeded');
    // Recovered from the checkpoint, not re-run: `done` never executed in this
    // process, and its result still resolved.
    expect(resumed.steps.find((s) => s.name === 'done')?.result).toBe('kept');
    expect(second.fx.calls.log.filter((call) => call.tool === 'echo')).toHaveLength(0);
  });

  it('refuses to pause an execution that is not running', async () => {
    const { fx, engine, release, reached } = gated();
    await fx.runtime.start();

    const running = engine.execute(
      plan([step('slow', { capability: { kind: 'tool', name: 'gated' } })]),
    );
    await reached;
    await engine.pause(toExecutionId('exec_1'));

    // Pausing a paused execution is a state error, not a second cancel.
    await expect(engine.pause(toExecutionId('exec_1'))).rejects.toThrow(/it is paused/);

    release();
    await running.catch(() => undefined);
  });
});
