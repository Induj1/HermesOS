/**
 * The `memory.*` tools, driven through a real kernel.
 *
 * These are how an agent reaches memory: through the kernel's registry, by name,
 * with no import of this package. So they are tested the way an agent uses them
 * — registered on a real `Runtime` and invoked as a mission task — rather than
 * by calling `execute` directly. Calling `execute` would skip the `input`
 * validator entirely, which is the half of these tools most worth testing:
 * their input may have come from a model, so it is parsed, not cast.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { defineAgent, Runtime, sequentialIds, type AgentContext } from '@hermes/kernel';
import { HashEmbeddingProvider } from '../src/embedding/hash-embedding-provider.js';
import { MemoryService } from '../src/memory-service.js';
import { toMemoryId } from '../src/model.js';
import { memoryPlugin } from '../src/plugin.js';
import {
  describeIntegration,
  truncateAll,
  withTestDatabase,
} from './helpers/database.js';

describeIntegration('the memory tools', () => {
  const test = withTestDatabase();
  let memory: MemoryService;

  beforeEach(async () => {
    await truncateAll(test.db);
    memory = await MemoryService.create({
      database: test.db,
      clock: test.clock,
      embeddings: new HashEmbeddingProvider({ dimensions: 64 }),
      migrateOnStart: false,
    });
  });

  /**
   * Call a tool the way the kernel does — through an agent that has the registry.
   *
   * Returns the tool's output, or throws whatever the tool threw. Routing through
   * a real agent means the `input` validator runs, which is the point.
   */
  async function callTool(
    tool: string,
    input: unknown,
    options: Parameters<typeof memoryPlugin>[0] = { memory },
  ): Promise<unknown> {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(memoryPlugin(options));
    runtime.use({
      name: 'caller',
      setup(ctx) {
        ctx.registerAgent(
          defineAgent<unknown, unknown>({
            name: 'caller',
            description: 'Calls one memory tool and returns what it returned',
            handle: (_input: unknown, agentCtx: AgentContext) =>
              agentCtx.tools.invoke(tool, input),
          }),
        );
      },
    });
    await runtime.start();

    try {
      const snapshot = await runtime.run({
        name: 'call',
        tasks: [{ name: 'call', handler: { kind: 'agent', name: 'caller' } }],
      });
      const task = snapshot.tasks[0];
      if (task?.error) throw task.error;
      return task?.result;
    } finally {
      await runtime.stop();
    }
  }

  describe('registration', () => {
    it('registers both tools, so an agent can reach memory by name alone', async () => {
      const runtime = Runtime.create({ ids: sequentialIds() });
      runtime.use(memoryPlugin({ memory }));
      await runtime.start();

      expect(
        runtime.tools
          .list()
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(['memory.recall', 'memory.remember']);

      await runtime.stop();
    });

    // The tools are the plugin's other job, independent of persistence. A host
    // that turns both projections off still gets memory as a capability.
    it('registers the tools even with persistence and the audit log off', async () => {
      const runtime = Runtime.create({ ids: sequentialIds() });
      runtime.use(memoryPlugin({ memory, persistMissions: false, auditLog: false }));
      await runtime.start();

      expect(runtime.tools.list()).toHaveLength(2);

      await runtime.stop();
    });
  });

  describe('memory.remember', () => {
    it('stores what it was given and reports the record it made', async () => {
      const result = (await callTool('memory.remember', {
        content: 'Ada prefers dark roast',
        subject: 'ada',
      })) as { id: string; importance: number };

      expect(result.id).toBeTruthy();
      expect(result.importance).toBeGreaterThan(0);

      const stored = await memory.memories.findById(toMemoryId(result.id));
      expect(stored?.content).toBe('Ada prefers dark roast');
      expect(stored?.subject).toBe('ada');
    });

    it('defaults the kind to a fact when the caller does not say', async () => {
      const result = (await callTool('memory.remember', {
        content: 'The sky is blue',
      })) as { id: string };

      expect((await memory.memories.findById(toMemoryId(result.id)))?.kind).toBe(
        'fact',
      );
    });

    it('stores against the configured default subject when none is given', async () => {
      const result = (await callTool(
        'memory.remember',
        { content: 'Something' },
        { memory, defaultSubject: 'house' },
      )) as { id: string };

      expect((await memory.memories.findById(toMemoryId(result.id)))?.subject).toBe(
        'house',
      );
    });

    it('honours an explicit kind, importance and pin', async () => {
      const result = (await callTool('memory.remember', {
        content: 'Never deploy on Friday',
        kind: 'preference',
        importance: 0.9,
        pinned: true,
      })) as { id: string; importance: number };

      const stored = await memory.memories.findById(toMemoryId(result.id));
      expect(stored?.kind).toBe('preference');
      expect(stored?.pinned).toBe(true);
      expect(result.importance).toBeCloseTo(0.9);
    });

    // Everything below here is the validator, and the validator exists because a
    // model wrote the input.
    it('rejects a missing content field', async () => {
      await expect(callTool('memory.remember', {})).rejects.toThrow(
        /content must be a non-empty string/,
      );
    });

    it('rejects blank content rather than storing an empty memory', async () => {
      await expect(callTool('memory.remember', { content: '   ' })).rejects.toThrow(
        /content must be a non-empty string/,
      );
    });

    it('rejects content that is not a string', async () => {
      await expect(callTool('memory.remember', { content: 42 })).rejects.toThrow(
        /content must be a non-empty string/,
      );
    });

    it('rejects a kind it does not have, and says which it has', async () => {
      // A model inventing a plausible-sounding kind is a normal Tuesday. The
      // message has to be actionable, so it lists the real ones.
      await expect(
        callTool('memory.remember', { content: 'x', kind: 'vibe' }),
      ).rejects.toThrow(/kind must be one of:/);
    });

    it.each([
      ['a string', 'not an object'],
      ['null', null],
      ['a number', 7],
    ])('rejects %s instead of an object', async (_label, input) => {
      await expect(callTool('memory.remember', input)).rejects.toThrow(
        /expects an object/,
      );
    });

    it('reports every input problem at once, not just the first', async () => {
      await expect(
        callTool('memory.remember', { content: '', kind: 'vibe' }),
      ).rejects.toThrow(/content must be a non-empty string; kind must be one of:/);
    });

    it('ignores fields of the wrong type rather than failing on them', async () => {
      // subject/importance/pinned are optional and narrowly typed. A model
      // sending `importance: "high"` should still get its memory stored under
      // the scorer's judgement, not a validation error it cannot act on.
      const result = (await callTool('memory.remember', {
        content: 'Stored anyway',
        subject: 12,
        importance: 'high',
        pinned: 'yes',
      })) as { id: string };

      const stored = await memory.memories.findById(toMemoryId(result.id));
      expect(stored?.content).toBe('Stored anyway');
      expect(stored?.subject).toBe('default');
      expect(stored?.pinned).toBe(false);
    });
  });

  describe('memory.recall', () => {
    beforeEach(async () => {
      await memory.remember({
        subject: 'ada',
        kind: 'preference',
        content: 'Ada prefers dark roast coffee',
      });
      await memory.remember({
        subject: 'ada',
        kind: 'fact',
        content: 'Ada lives in London',
      });
      await memory.remember({
        subject: 'grace',
        kind: 'fact',
        content: 'Grace prefers tea',
      });
    });

    it('returns memories for the subject, best first', async () => {
      const results = (await callTool('memory.recall', {
        query: 'coffee',
        subject: 'ada',
      })) as { id: string; content: string; score: number }[];

      expect(results.length).toBeGreaterThan(0);
      expect(results.map((r) => r.content).join(' ')).toContain('Ada');
      // Ranked, and the score is reported so a caller can threshold on it.
      const scores = results.map((r) => r.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });

    it('does not leak another subject memories', async () => {
      const results = (await callTool('memory.recall', {
        query: 'tea',
        subject: 'ada',
      })) as { content: string }[];

      expect(results.map((r) => r.content).join(' ')).not.toContain('Grace');
    });

    it('reads from the configured default subject when none is given', async () => {
      const results = (await callTool(
        'memory.recall',
        { query: 'coffee' },
        { memory, defaultSubject: 'ada' },
      )) as unknown[];

      expect(results.length).toBeGreaterThan(0);
    });

    it('honours a limit', async () => {
      const results = (await callTool('memory.recall', {
        query: 'Ada',
        subject: 'ada',
        limit: 1,
      })) as unknown[];

      expect(results).toHaveLength(1);
    });

    it('filters by kind', async () => {
      const results = (await callTool('memory.recall', {
        query: 'Ada',
        subject: 'ada',
        kinds: ['preference'],
      })) as { kind: string }[];

      expect(results.every((r) => r.kind === 'preference')).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    // Dropping rather than rejecting: a model asking for a kind that does not
    // exist should get the memories it *can* have, not an error it cannot act on.
    it('drops an unknown kind instead of rejecting the call', async () => {
      const results = (await callTool('memory.recall', {
        query: 'Ada',
        subject: 'ada',
        kinds: ['preference', 'vibe'],
      })) as { kind: string }[];

      expect(results.every((r) => r.kind === 'preference')).toBe(true);
    });

    it('returns nothing when every requested kind is unknown', async () => {
      // The filter empties, so nothing matches. Still not an error.
      const results = (await callTool('memory.recall', {
        query: 'Ada',
        subject: 'ada',
        kinds: ['vibe'],
      })) as unknown[];

      expect(results).toEqual([]);
    });

    it('returns an empty list for a subject with no memories', async () => {
      expect(
        await callTool('memory.recall', { query: 'anything', subject: 'nobody' }),
      ).toEqual([]);
    });

    it('rejects a missing or blank query', async () => {
      await expect(callTool('memory.recall', {})).rejects.toThrow(
        /query must be a non-empty string/,
      );
      await expect(callTool('memory.recall', { query: '  ' })).rejects.toThrow(
        /query must be a non-empty string/,
      );
    });

    it('rejects a non-object input', async () => {
      await expect(callTool('memory.recall', 'coffee')).rejects.toThrow(
        /expects an object/,
      );
    });
  });
});
