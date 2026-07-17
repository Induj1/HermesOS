/**
 * The in-memory checkpoint store.
 *
 * It is the reference implementation the port is defined against, so these are
 * really tests of the *contract* — last-write-wins, settled executions are not
 * pending, and above all that a checkpoint must be serialisable. That last one
 * is the reason this store round-trips through JSON rather than holding the
 * object, and it is what makes a laptop test fail on what Postgres would fail on.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryCheckpointStore } from '../src/ports/in-memory-checkpoint-store.js';
import { CheckpointCorruptError } from '../src/errors.js';
import {
  toExecutionId,
  type ExecutionCheckpoint,
  type ExecutionState,
} from '../src/model.js';
import { FIXED_NOW } from './helpers/fixtures.js';

function checkpoint(
  id: string,
  overrides: Partial<ExecutionCheckpoint> = {},
): ExecutionCheckpoint {
  return {
    id: toExecutionId(id),
    state: 'running',
    plan: {
      id: 'plan_1' as never,
      goal: { statement: 'Do the thing' },
      steps: [
        { name: 'a', intent: 'Do a', capability: { kind: 'tool', name: 'echo' } },
      ],
      strategy: 'test',
      rationale: 'because',
      confidence: 1,
      createdAt: FIXED_NOW,
      metadata: {},
    },
    steps: [
      {
        name: 'a',
        intent: 'Do a',
        capability: { kind: 'tool', name: 'echo' },
        state: 'pending',
        attempts: 0,
      },
    ],
    missions: [],
    attempts: 0,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    metadata: {},
    ...overrides,
  };
}

describe('save and load', () => {
  it('round-trips a checkpoint', async () => {
    const store = new InMemoryCheckpointStore();
    await store.save(checkpoint('exec_1'));

    expect(await store.load(toExecutionId('exec_1'))).toEqual(checkpoint('exec_1'));
  });

  it('reports nothing for an id it has never seen', async () => {
    expect(
      await new InMemoryCheckpointStore().load(toExecutionId('exec_nope')),
    ).toBeUndefined();
  });

  // A checkpoint is always complete rather than a delta, which is what makes
  // last-write-wins correct rather than merely convenient.
  it('replaces an earlier checkpoint for the same execution', async () => {
    const store = new InMemoryCheckpointStore();
    await store.save(checkpoint('exec_1'));
    await store.save(checkpoint('exec_1', { state: 'succeeded', attempts: 2 }));

    const loaded = await store.load(toExecutionId('exec_1'));
    expect(loaded?.state).toBe('succeeded');
    expect(loaded?.attempts).toBe(2);
    expect(store.size).toBe(1);
  });

  // Stored as text, so a caller cannot mutate a "saved" checkpoint afterwards.
  it('is not a window onto the caller object', async () => {
    const store = new InMemoryCheckpointStore();
    const mutable = { ...checkpoint('exec_1'), metadata: { touched: false } };
    await store.save(mutable);

    mutable.metadata.touched = true;

    expect((await store.load(toExecutionId('exec_1')))?.metadata).toEqual({
      touched: false,
    });
  });
});

// The requirement the whole design rests on: a checkpoint that cannot be
// serialised cannot be resumed after the process that wrote it has died.
describe('serialisability', () => {
  it('rejects a step result with a circular reference', async () => {
    const store = new InMemoryCheckpointStore();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const promise = store.save(
      checkpoint('exec_1', {
        steps: [
          {
            name: 'a',
            intent: 'Do a',
            capability: { kind: 'tool', name: 'echo' },
            state: 'succeeded',
            attempts: 1,
            result: circular,
          },
        ],
      }),
    );

    // Told now, at the save that would otherwise have silently lost it.
    await expect(promise).rejects.toThrow(CheckpointCorruptError);
    await expect(promise).rejects.toThrow(/must be plain JSON data/);
  });

  it('rejects a BigInt result, which JSON cannot hold', async () => {
    const store = new InMemoryCheckpointStore();

    await expect(
      store.save(
        checkpoint('exec_1', {
          steps: [
            {
              name: 'a',
              intent: 'Do a',
              capability: { kind: 'tool', name: 'echo' },
              state: 'succeeded',
              attempts: 1,
              result: 1n,
            },
          ],
        }),
      ),
    ).rejects.toThrow(CheckpointCorruptError);
  });
});

describe('delete', () => {
  it('forgets an execution and says it did', async () => {
    const store = new InMemoryCheckpointStore();
    await store.save(checkpoint('exec_1'));

    expect(await store.delete(toExecutionId('exec_1'))).toBe(true);
    expect(await store.load(toExecutionId('exec_1'))).toBeUndefined();
  });

  // "Already gone" is not an error, so a caller need not read first.
  it('says false for an execution that was not there', async () => {
    expect(await new InMemoryCheckpointStore().delete(toExecutionId('exec_nope'))).toBe(
      false,
    );
  });
});

describe('pending', () => {
  // What a supervisor asks on boot to find the work that needs picking up.
  it('returns executions that have not settled, oldest first', async () => {
    const store = new InMemoryCheckpointStore();
    await store.save(checkpoint('exec_2', { createdAt: FIXED_NOW + 100 }));
    await store.save(checkpoint('exec_1', { createdAt: FIXED_NOW }));
    await store.save(
      checkpoint('exec_3', { state: 'paused', createdAt: FIXED_NOW + 200 }),
    );

    expect((await store.pending()).map((c) => c.id)).toEqual([
      'exec_1',
      'exec_2',
      'exec_3',
    ]);
  });

  // Settled executions are history, and history belongs in @hermes/memory.
  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'excludes a %s execution, which is not work',
    async (state: ExecutionState) => {
      const store = new InMemoryCheckpointStore();
      await store.save(checkpoint('exec_1', { state }));

      expect(await store.pending()).toEqual([]);
    },
  );

  it('includes a recovering execution, which is still in flight', async () => {
    const store = new InMemoryCheckpointStore();
    await store.save(checkpoint('exec_1', { state: 'recovering' }));

    expect(await store.pending()).toHaveLength(1);
  });

  it('is empty for an empty store', async () => {
    expect(await new InMemoryCheckpointStore().pending()).toEqual([]);
  });
});
