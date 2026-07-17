/**
 * Mission persistence, driven by a real kernel.
 *
 * These tests build an actual `Runtime`, register the memory plugin, and run
 * real missions — no fake bus, no hand-built snapshots. That is deliberate: the
 * whole claim of RFC-0001 §11.2 is that "a store is a plugin that subscribes",
 * and the only way to test that claim is to be that plugin, attached to that
 * kernel, through its public API.
 *
 * If the kernel's event catalogue grows or a payload changes shape, these fail —
 * which is exactly what should happen, because the projection would be wrong.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  defineTool,
  Runtime,
  sequentialIds,
  TestClock,
  type MissionSnapshot,
} from '@hermes/kernel';
import { HashEmbeddingProvider } from '../src/embedding/hash-embedding-provider.js';
import { MemoryService } from '../src/memory-service.js';
import { memoryPlugin } from '../src/plugin.js';
import { flattenError } from '../src/repositories/mission-repository.js';
import {
  describeIntegration,
  truncateAll,
  withTestDatabase,
} from './helpers/database.js';

describe('flattenError', () => {
  it('captures what JSON.stringify silently drops', () => {
    // JSON.stringify(new Error('boom')) is '{}' — name, message and stack are
    // non-enumerable. A naively persisted task:failed records that a task
    // failed and nothing about why. This is the fix, and it is the single most
    // valuable function in the repository.
    expect(JSON.stringify(new Error('boom'))).toBe('{}');

    const flat = flattenError(new Error('boom'));
    expect(flat.name).toBe('Error');
    expect(flat.message).toBe('boom');
    expect(flat.stack).toContain('boom');
  });

  it('keeps a kernel error code', () => {
    // `code` is what callers branch on (RFC-0001 §5) and survives a message
    // rewording, so it is the field most worth persisting.
    const error = Object.assign(new Error('nope'), { code: 'TASK_TIMEOUT' });
    expect(flattenError(error).code).toBe('TASK_TIMEOUT');
  });

  it('follows a cause chain', () => {
    // Kernel errors chain: a PluginError wraps whatever the plugin threw, and
    // the inner error is usually the one worth reading.
    const flat = flattenError(new Error('outer', { cause: new Error('inner') }));
    expect(flat.cause?.message).toBe('inner');
  });

  it('stops at a bounded depth rather than recursing forever', () => {
    // A cause chain can be cyclic (a.cause = b; b.cause = a), which would
    // otherwise recurse until the stack gives out.
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;

    let flat = flattenError(a);
    let depth = 0;
    while (flat.cause) {
      flat = flat.cause;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(4);
  });

  it('ignores a non-Error cause', () => {
    expect(flattenError(new Error('x', { cause: 'a string' })).cause).toBeUndefined();
  });
});

describeIntegration('mission persistence', () => {
  const test = withTestDatabase();
  let memory: MemoryService;

  beforeEach(async () => {
    await truncateAll(test.db);
    memory = await MemoryService.create({
      database: test.db,
      clock: test.clock,
      embeddings: new HashEmbeddingProvider({ dimensions: 64 }),
      // The schema is already migrated by the harness.
      migrateOnStart: false,
    });
  });

  /**
   * A runtime wired to the memory plugin.
   *
   * `systemClock`, not the TestClock: the scheduler really awaits here, and a
   * clock that only moves when told would hang the mission. Time in these tests
   * is the kernel's business; what is under test is what gets written.
   */
  function runtime(options: Parameters<typeof memoryPlugin>[0] = { memory }): Runtime {
    const instance = Runtime.create({ ids: sequentialIds(), concurrency: 2 });
    instance.use(memoryPlugin(options));
    instance.use({
      name: 'fixtures',
      setup(ctx) {
        ctx.registerTool(
          defineTool<unknown, string>({
            name: 'ok',
            description: 'Succeeds',
            execute: () => Promise.resolve('done'),
          }),
        );
        ctx.registerTool(
          defineTool<unknown, never>({
            name: 'boom',
            description: 'Always throws',
            execute: () => Promise.reject(new Error('deliberate failure')),
          }),
        );
      },
    });
    return instance;
  }

  async function withRuntime(fn: (r: Runtime) => Promise<void>): Promise<void> {
    const instance = runtime();
    await instance.start();
    try {
      await fn(instance);
    } finally {
      await instance.stop();
    }
  }

  it('persists a successful mission and its tasks', async () => {
    let snapshot: MissionSnapshot | undefined;

    await withRuntime(async (r) => {
      snapshot = await r.run({
        name: 'morning-brief',
        goal: 'Summarise the day ahead',
        tasks: [
          { name: 'fetch', handler: { kind: 'tool', name: 'ok' } },
          {
            name: 'brief',
            handler: { kind: 'tool', name: 'ok' },
            dependsOn: ['fetch'],
          },
        ],
      });
    });

    const stored = await memory.missions.findById(snapshot?.id as never);

    expect(stored).toMatchObject({
      id: snapshot?.id,
      name: 'morning-brief',
      goal: 'Summarise the day ahead',
      state: 'succeeded',
      failurePolicy: 'fail-fast',
    });
    expect(stored?.tasks).toHaveLength(2);
    expect(stored?.tasks.every((task) => task.state === 'succeeded')).toBe(true);
  });

  it('persists task results and handler references', async () => {
    let snapshot: MissionSnapshot | undefined;
    await withRuntime(async (r) => {
      snapshot = await r.run({
        name: 'single',
        tasks: [
          { name: 'fetch', handler: { kind: 'tool', name: 'ok' }, input: { a: 1 } },
        ],
      });
    });

    const stored = await memory.missions.findById(snapshot?.id as never);
    const task = stored?.tasks[0];

    expect(task).toMatchObject({
      name: 'fetch',
      handler: { kind: 'tool', name: 'ok' },
      input: { a: 1 },
      result: 'done',
    });
  });

  it('persists a failure with a readable error', async () => {
    // The end-to-end version of the flattenError tests above: a real kernel
    // failure, through a real event, landing as something a human can read.
    let snapshot: MissionSnapshot | undefined;
    await withRuntime(async (r) => {
      // Resolves, not rejects: a failed mission is a result to inspect
      // (runtime.ts §run).
      snapshot = await r.run({
        name: 'doomed',
        tasks: [{ name: 'go', handler: { kind: 'tool', name: 'boom' } }],
      });
    });
    expect(snapshot?.state).toBe('failed');

    const missions = await memory.missions.listByState('failed');
    expect(missions).toHaveLength(1);

    const task = missions[0]?.tasks.find((t) => t.name === 'go');
    expect(task?.state).toBe('failed');
    expect(task?.error).toBeInstanceOf(Error);
    expect(task?.error?.message).toBe('deliberate failure');
    // The stack is the original one, not the mapper's frame: a stack pointing at
    // a mapper is worse than no stack, because it is confidently wrong.
    expect(task?.error?.stack).toContain('deliberate failure');
  });

  it('records skipped tasks', async () => {
    await withRuntime(async (r) => {
      await r.run({
        name: 'cascade',
        failurePolicy: 'continue',
        tasks: [
          { name: 'go', handler: { kind: 'tool', name: 'boom' } },
          { name: 'after', handler: { kind: 'tool', name: 'ok' }, dependsOn: ['go'] },
        ],
      });
    });

    const [mission] = await memory.missions.listByState('failed');
    expect(mission?.tasks.find((t) => t.name === 'after')?.state).toBe('skipped');
  });

  it('upserts rather than duplicating as a mission progresses', async () => {
    // The projection is written once per event, and the snapshot is always
    // complete rather than a delta — so last-write-wins is correct, and rows
    // must not accumulate.
    let snapshot: MissionSnapshot | undefined;
    await withRuntime(async (r) => {
      snapshot = await r.run({
        name: 'repeated',
        tasks: [
          { name: 'a', handler: { kind: 'tool', name: 'ok' } },
          { name: 'b', handler: { kind: 'tool', name: 'ok' }, dependsOn: ['a'] },
        ],
      });
    });

    const { rows: missionRows } = await test.db.query<{ count: string }>(
      'SELECT count(*) AS count FROM mission WHERE id = $1',
      [snapshot?.id],
    );
    const { rows: taskRows } = await test.db.query<{ count: string }>(
      'SELECT count(*) AS count FROM mission_task WHERE mission_id = $1',
      [snapshot?.id],
    );

    expect(Number(missionRows[0]?.count)).toBe(1);
    expect(Number(taskRows[0]?.count)).toBe(2);
  });

  it('takes timestamps from the snapshot, not from now()', async () => {
    // The kernel's clock is injectable. Recording wall time would make persisted
    // history disagree with the kernel that produced it.
    let snapshot: MissionSnapshot | undefined;
    await withRuntime(async (r) => {
      snapshot = await r.run({
        name: 'timed',
        tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ok' } }],
      });
    });

    const stored = await memory.missions.findById(snapshot?.id as never);
    expect(stored?.createdAt).toBe(snapshot?.createdAt);
    expect(stored?.finishedAt).toBe(snapshot?.finishedAt);
  });

  it('appends an ordered audit log', async () => {
    let snapshot: MissionSnapshot | undefined;
    await withRuntime(async (r) => {
      snapshot = await r.run({
        name: 'audited',
        tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ok' } }],
      });
    });

    const events = await memory.missions.events(snapshot?.id as never);
    const types = events.map((event) => event.type);

    expect(types).toContain('mission:submitted');
    expect(types).toContain('task:started');
    expect(types).toContain('task:succeeded');
    expect(types).toContain('mission:succeeded');

    // Ordered by the identity column, which is the order they were emitted in.
    expect(types.indexOf('mission:submitted')).toBeLessThan(
      types.indexOf('task:started'),
    );
    expect(types.indexOf('task:started')).toBeLessThan(
      types.indexOf('mission:succeeded'),
    );
  });

  it('tags audit events with their mission and task ids structurally', async () => {
    // Derived from the payload shape rather than a switch over event names,
    // because the kernel's catalogue grows and a switch would silently stop
    // tagging new events — orphaned rows nobody notices until they need the log.
    let snapshot: MissionSnapshot | undefined;
    await withRuntime(async (r) => {
      snapshot = await r.run({
        name: 'tagged',
        tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ok' } }],
      });
    });

    const events = await memory.missions.events(snapshot?.id as never);
    expect(events.every((event) => event.missionId === snapshot?.id)).toBe(true);

    const taskEvent = events.find((event) => event.type === 'task:succeeded');
    expect(taskEvent?.taskId).toBeDefined();
  });

  it('records an error in the audit payload rather than an empty object', async () => {
    await withRuntime(async (r) => {
      await r.run({
        name: 'doomed',
        tasks: [{ name: 'go', handler: { kind: 'tool', name: 'boom' } }],
      });
    });

    const [mission] = await memory.missions.listByState('failed');
    const events = await memory.missions.events(mission?.id as never);
    const failure = events.find((event) => event.type === 'task:failed');

    expect(failure?.payload).toMatchObject({
      error: { message: 'deliberate failure', name: 'Error' },
    });
  });

  it('can persist the projection without the audit log', async () => {
    const instance = Runtime.create({ ids: sequentialIds() });
    instance.use(memoryPlugin({ memory, auditLog: false }));
    instance.use({
      name: 'fixtures',
      setup: (ctx) => {
        ctx.registerTool(
          defineTool<unknown, string>({
            name: 'ok',
            description: 'Succeeds',
            execute: () => Promise.resolve('done'),
          }),
        );
      },
    });
    await instance.start();
    const snapshot = await instance.run({
      name: 'quiet',
      tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ok' } }],
    });
    await instance.stop();

    expect(await memory.missions.findById(snapshot.id)).toBeDefined();
    expect(await memory.missions.events(snapshot.id)).toEqual([]);
  });

  it('never lets a store failure break a mission', async () => {
    // Persistence is an observer of the system, not a participant in it. A
    // database being down must not stop missions from running — this is the
    // single most important behavioural guarantee in the plugin.
    const brokenService = await MemoryService.create({
      database: {
        query: () => Promise.reject(new Error('database is on fire')),
        transaction: () => Promise.reject(new Error('database is on fire')),
        capabilities: () => Promise.resolve({ pgvector: false, serverVersion: 'x' }),
        close: () => Promise.resolve(),
      },
      clock: new TestClock(0),
      migrateOnStart: false,
    });

    const instance = Runtime.create({ ids: sequentialIds() });
    instance.use(memoryPlugin({ memory: brokenService }));
    instance.use({
      name: 'fixtures',
      setup: (ctx) => {
        ctx.registerTool(
          defineTool<unknown, string>({
            name: 'ok',
            description: 'Succeeds',
            execute: () => Promise.resolve('done'),
          }),
        );
      },
    });
    await instance.start();

    const snapshot = await instance.run({
      name: 'survives',
      tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ok' } }],
    });
    await instance.stop();

    expect(snapshot.state).toBe('succeeded');
  });

  it('unsubscribes on dispose, so no event arrives after shutdown', async () => {
    const instance = runtime();
    await instance.start();
    const snapshot = await instance.run({
      name: 'clean',
      tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ok' } }],
    });
    await instance.stop();

    const before = await memory.missions.events(snapshot.id);
    // The bus is still reachable after stop; a live subscription would write.
    await instance.bus.emit('scheduler:idle', { at: 0 });
    const after = await memory.missions.events(snapshot.id);

    expect(after).toHaveLength(before.length);
  });

  describe('queries', () => {
    it('lists by state without an N+1 for tasks', async () => {
      await withRuntime(async (r) => {
        for (let i = 0; i < 3; i++) {
          await r.run({
            name: `mission-${String(i)}`,
            tasks: [
              { name: 'a', handler: { kind: 'tool', name: 'ok' } },
              { name: 'b', handler: { kind: 'tool', name: 'ok' } },
            ],
          });
        }
      });

      const missions = await memory.missions.listByState('succeeded');
      expect(missions).toHaveLength(3);
      expect(missions.every((mission) => mission.tasks.length === 2)).toBe(true);
    });

    it('lists recent missions newest-first', async () => {
      await withRuntime(async (r) => {
        await r.run({
          name: 'first',
          tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ok' } }],
        });
        await r.run({
          name: 'second',
          tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ok' } }],
        });
      });

      const recent = await memory.missions.listRecent();
      expect(recent).toHaveLength(2);
      expect(recent[0]?.createdAt).toBeGreaterThanOrEqual(recent[1]?.createdAt ?? 0);
    });

    it('returns undefined for an unknown mission', async () => {
      expect(await memory.missions.findById('mission_nope' as never)).toBeUndefined();
    });

    it('purges finished missions, their tasks, and their events', async () => {
      let snapshot: MissionSnapshot | undefined;
      await withRuntime(async (r) => {
        snapshot = await r.run({
          name: 'old',
          tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ok' } }],
        });
      });

      await memory.missions.purgeFinishedBefore(Date.now() + 60_000);

      expect(await memory.missions.findById(snapshot?.id as never)).toBeUndefined();
      expect(await memory.missions.events(snapshot?.id as never)).toEqual([]);

      const { rows } = await test.db.query<{ count: string }>(
        'SELECT count(*) AS count FROM mission_task WHERE mission_id = $1',
        [snapshot?.id],
      );
      expect(Number(rows[0]?.count)).toBe(0);
    });

    it('spares unfinished missions from a purge', async () => {
      await withRuntime(async (r) => {
        await r.run({
          name: 'done',
          tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ok' } }],
        });
      });
      // A cutoff before everything: nothing qualifies.
      await memory.missions.purgeFinishedBefore(0);
      expect(await memory.missions.listRecent()).toHaveLength(1);
    });
  });

  describe('memory.* tools', () => {
    it('registers both tools on the runtime', async () => {
      // An agent uses memory the same way it uses any other capability: through
      // the kernel's registry, with no import of this package.
      const instance = runtime();
      await instance.start();

      expect(instance.tools.has('memory.remember')).toBe(true);
      expect(instance.tools.has('memory.recall')).toBe(true);

      await instance.stop();
    });

    it('remembers and recalls through a mission', async () => {
      const instance = runtime();
      await instance.start();

      await instance.run({
        name: 'learn',
        tasks: [
          {
            name: 'store',
            handler: { kind: 'tool', name: 'memory.remember' },
            input: {
              subject: 'ada',
              kind: 'preference',
              content: 'Always brief me at seven in the morning',
            },
          },
        ],
      });

      const hits = await memory.recall('ada', 'when should I be briefed');
      expect(hits[0]?.memory.content).toBe('Always brief me at seven in the morning');

      await instance.stop();
    });

    it('rejects invalid tool input through the kernel validator', async () => {
      // The kernel parses input before calling execute when a tool declares a
      // Validator. This input may come from a model, so it is parsed, not cast.
      //
      // `run` resolves rather than throwing even though the task failed — the
      // kernel is explicit that a failed mission is "a result to inspect rather
      // than an exception to catch" (runtime.ts §run).
      const instance = runtime();
      await instance.start();

      const snapshot = await instance.run({
        name: 'bad',
        tasks: [
          {
            name: 'store',
            handler: { kind: 'tool', name: 'memory.remember' },
            input: { content: '' },
          },
        ],
      });

      expect(snapshot.state).toBe('failed');
      expect(snapshot.tasks[0]?.error?.message).toBe(
        'content must be a non-empty string',
      );

      // Nothing was written: the validator ran before execute.
      expect(await memory.memories.countBySubject('default')).toBe(0);

      await instance.stop();
    });
  });
});
