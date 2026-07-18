/**
 * The MemoryService facade — the surface a host actually touches.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@hermes/kernel';
import { HashEmbeddingProvider } from '../src/embedding/hash-embedding-provider.js';
import type { EmbeddingProvider } from '../src/embedding/provider.js';
import { ConstantImportanceScorer } from '../src/importance.js';
import { MemoryService } from '../src/memory-service.js';
import { NeverPruneStrategy, RetentionPruningStrategy } from '../src/pruning.js';
import {
  describeIntegration,
  truncateAll,
  withTestDatabase,
} from './helpers/database.js';

const DAY = 24 * 60 * 60 * 1000;

describe('MemoryService.create (argument checking)', () => {
  it('refuses both a database and a connection string', async () => {
    // Silently ignoring one of two contradictory arguments is how a service ends
    // up talking to a database nobody expected.
    await expect(
      MemoryService.create({
        connectionString: 'postgres://x',
        database: {} as never,
      }),
    ).rejects.toThrow(/not both/);
  });

  it('refuses neither', async () => {
    await expect(MemoryService.create({})).rejects.toThrow(
      /needs a `connectionString`/,
    );
  });
});

describeIntegration('MemoryService', () => {
  const test = withTestDatabase();
  let memory: MemoryService;

  beforeEach(async () => {
    await truncateAll(test.db);
    memory = await MemoryService.create({
      database: test.db,
      clock: test.clock,
      embeddings: new HashEmbeddingProvider({ dimensions: 768 }),
      scorer: new ConstantImportanceScorer(0.5),
      migrateOnStart: false,
    });
  });

  describe('remember', () => {
    it('stores and embeds in one call', async () => {
      const record = await memory.remember({
        subject: 'ada',
        kind: 'fact',
        content: 'Their sister is called Mara',
      });

      const stored = await memory.memories.getEmbedding(
        record.id,
        memory.embeddings.model,
      );
      expect(stored?.dimensions).toBe(768);
    });

    it('stores the memory even when embedding fails', async () => {
      // The most important behaviour in this file. A local model being
      // unavailable must not mean Hermes silently stops remembering: an
      // un-embedded memory is still findable lexically and can be backfilled,
      // whereas a memory never written is gone.
      const broken: EmbeddingProvider = {
        model: 'broken',
        dimensions: 8,
        embed: () => Promise.reject(new Error('Ollama is not running')),
      };
      const warnings: string[] = [];
      const logger = {
        ...noopLogger,
        warn: (m: string) => warnings.push(m),
        child: () => logger,
      };

      const service = await MemoryService.create({
        database: test.db,
        clock: test.clock,
        embeddings: broken,
        logger,
        migrateOnStart: false,
      });

      const record = await service.remember({
        subject: 'ada',
        kind: 'fact',
        content: 'Survives the outage',
      });

      expect(await service.memories.getById(record.id)).toMatchObject({
        content: 'Survives the outage',
      });
      // A warning about storing without an embedding must be emitted. Match by
      // content, not position: when pgvector is present, MemoryService.create
      // also logs a semantic-index-status warning first, so this one is not
      // guaranteed to be warnings[0].
      expect(warnings.some((w) => w.includes('without an embedding'))).toBe(true);
    });

    it('leaves a failed embedding discoverable for backfill', async () => {
      const broken: EmbeddingProvider = {
        model: 'hash-768',
        dimensions: 768,
        embed: () => Promise.reject(new Error('down')),
      };
      const service = await MemoryService.create({
        database: test.db,
        clock: test.clock,
        embeddings: broken,
        migrateOnStart: false,
      });
      await service.remember({
        subject: 'ada',
        kind: 'fact',
        content: 'Needs a vector',
      });

      const pending = await service.memories.findUnembedded('ada', 'hash-768');
      expect(pending.map((m) => m.content)).toEqual(['Needs a vector']);
    });
  });

  describe('backfillEmbeddings', () => {
    it('embeds what the outage missed', async () => {
      // The repair path that makes "embedding failure does not fail the write"
      // an honest tradeoff rather than a way to lose data quietly.
      await memory.memories.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Never embedded',
      });

      expect(await memory.backfillEmbeddings('ada')).toBe(1);
      expect(
        await memory.memories.findUnembedded('ada', memory.embeddings.model),
      ).toEqual([]);
    });

    it('is a no-op when everything is embedded', async () => {
      await memory.remember({ subject: 'ada', kind: 'fact', content: 'Already done' });
      expect(await memory.backfillEmbeddings('ada')).toBe(0);
    });

    it('embeds the backlog in one batch call, not one per memory', async () => {
      // Every real provider is batch-shaped, and this is the path that runs
      // after an outage, when there is a backlog to clear.
      const provider = new HashEmbeddingProvider({ dimensions: 768 });
      const embed = vi.spyOn(provider, 'embed');
      const service = await MemoryService.create({
        database: test.db,
        clock: test.clock,
        embeddings: provider,
        migrateOnStart: false,
      });

      for (let i = 0; i < 5; i++) {
        await service.memories.create({
          subject: 'ada',
          kind: 'fact',
          content: `Memory ${String(i)}`,
        });
      }
      embed.mockClear();

      expect(await service.backfillEmbeddings('ada')).toBe(5);
      expect(embed).toHaveBeenCalledTimes(1);
    });

    it('honours its limit', async () => {
      for (let i = 0; i < 5; i++) {
        await memory.memories.create({
          subject: 'ada',
          kind: 'fact',
          content: `Memory ${String(i)}`,
        });
      }
      expect(await memory.backfillEmbeddings('ada', 2)).toBe(2);
    });
  });

  describe('recall', () => {
    beforeEach(async () => {
      await memory.remember({
        subject: 'ada',
        kind: 'episode',
        content: 'The dentist appointment is on Tuesday afternoon',
      });
      await memory.remember({
        subject: 'ada',
        kind: 'fact',
        content: 'Ships sail across the wide open ocean',
      });
    });

    it('returns the relevant memory first', async () => {
      const hits = await memory.recall('ada', 'when is my dentist appointment');
      expect(hits[0]?.memory.content).toMatch(/dentist/);
    });

    it('scopes to the subject', async () => {
      expect(await memory.recall('nobody', 'dentist')).toEqual([]);
    });

    it('honours limit and kinds', async () => {
      expect(await memory.recall('ada', 'anything', { limit: 1 })).toHaveLength(1);

      const facts = await memory.recall('ada', 'anything', { kinds: ['fact'] });
      expect(facts.every((hit) => hit.memory.kind === 'fact')).toBe(true);
    });

    it('records the access, so use feeds retention', async () => {
      const hits = await memory.recall('ada', 'dentist appointment');
      const id = hits[0]?.memory.id;

      // touch() is fire-and-forget on the read path: a write must never add
      // latency to a retrieval. So poll rather than assume it has landed.
      await vi.waitFor(async () => {
        expect((await memory.memories.getById(id as never)).accessCount).toBe(1);
      });
    });

    it('survives a touch failure without failing the read', async () => {
      // Usage bookkeeping is a rounding error in a ranking weight. Losing one
      // increment must not cost the caller their retrieval.
      vi.spyOn(memory.memories, 'touch').mockRejectedValueOnce(
        new Error('write failed'),
      );
      const hits = await memory.recall('ada', 'dentist appointment');
      expect(hits.length).toBeGreaterThan(0);
    });
  });

  describe('conversation sugar', () => {
    it('opens a conversation, then continues the same one', async () => {
      const first = await memory.openConversation({ subject: 'ada' });
      const second = await memory.openConversation({ subject: 'ada' });
      expect(second.id).toBe(first.id);
    });

    it('opens a new conversation once the last was closed', async () => {
      const first = await memory.openConversation({ subject: 'ada' });
      await memory.conversations.close(first.id);
      const second = await memory.openConversation({ subject: 'ada' });
      expect(second.id).not.toBe(first.id);
    });

    it('returns the last n messages oldest-first for a context window', async () => {
      const conversation = await memory.openConversation({ subject: 'ada' });
      for (let i = 1; i <= 30; i++) {
        await memory.appendMessage(conversation.id, {
          role: 'user',
          content: `Message ${String(i)}`,
        });
      }

      const context = await memory.context(conversation.id, 5);
      expect(context.map((m) => m.seq)).toEqual([26, 27, 28, 29, 30]);
    });
  });

  describe('prune', () => {
    it('forgets what the strategy condemns', async () => {
      // importance 0.05 deliberately. Retention is a weighted sum in which
      // importance contributes `importance * 0.5` unconditionally, so a memory
      // at importance 0.5 has a retention floor of 0.25 and can NEVER decay
      // below the default 0.15 threshold, however old it gets. That is the
      // "importance leads" design working as intended (see importance.ts), not
      // a bug — but it means a decay test has to use a memory the scorer
      // actually thought little of.
      const doomed = await memory.remember({
        subject: 'ada',
        kind: 'episode',
        content: 'Ate a sandwich',
        importance: 0.05,
      });
      await test.clock.advance(3650 * DAY);

      const plan = await memory.prune('ada');

      expect(plan.forget.map((entry) => entry.id)).toContain(doomed.id);
      expect((await memory.memories.getById(doomed.id)).forgottenAt).toBeDefined();
    });

    it('uses the injected strategy', async () => {
      const service = await MemoryService.create({
        database: test.db,
        clock: test.clock,
        pruningStrategy: new NeverPruneStrategy(),
        migrateOnStart: false,
      });
      await service.remember({
        subject: 'ada',
        kind: 'episode',
        content: 'Ate a sandwich',
      });
      await test.clock.advance(3650 * DAY);

      expect((await service.prune('ada')).forget).toHaveLength(0);
    });

    it('spares a pinned memory', async () => {
      const pinned = await memory.remember({
        subject: 'ada',
        kind: 'episode',
        content: 'Ate a sandwich',
        importance: 0.05,
        pinned: true,
      });
      await test.clock.advance(3650 * DAY);

      await memory.prune('ada');
      expect((await memory.memories.getById(pinned.id)).forgottenAt).toBeUndefined();
    });

    it('removes a pruned memory from recall', async () => {
      // The end-to-end consequence: forgetting must actually take effect on the
      // read path, or the soft delete is decorative.
      const target = await memory.remember({
        subject: 'ada',
        kind: 'episode',
        content: 'The dentist appointment is Tuesday',
        importance: 0.05,
      });
      expect(await memory.recall('ada', 'dentist appointment')).not.toEqual([]);

      // Wait for recall's fire-and-forget touch to land before moving the clock.
      // Otherwise it races the advance: a touch that commits afterwards stamps
      // lastAccessedAt at the *new* now, resetting recency to 1 and sparing the
      // memory — a genuinely flaky test rather than a wrong one.
      await vi.waitFor(async () => {
        expect((await memory.memories.getById(target.id)).accessCount).toBe(1);
      });

      await test.clock.advance(3650 * DAY);
      await memory.prune('ada');

      expect(await memory.recall('ada', 'dentist appointment')).toEqual([]);
    });

    it('honours a custom retention strategy', async () => {
      const service = await MemoryService.create({
        database: test.db,
        clock: test.clock,
        pruningStrategy: new RetentionPruningStrategy({
          maxPerSubject: 2,
          minRetention: 0,
        }),
        scorer: new ConstantImportanceScorer(0.5),
        migrateOnStart: false,
      });
      for (let i = 0; i < 5; i++) {
        await service.remember({
          subject: 'ada',
          kind: 'episode',
          content: `Memory ${String(i)}`,
        });
        await test.clock.advance(1_000);
      }
      await test.clock.advance(2 * DAY);

      const plan = await service.prune('ada');
      expect(plan.kept).toBe(2);
    });
  });

  describe('lifecycle', () => {
    it('does not close a database it did not open', async () => {
      // A caller's database is theirs. Closing it here would take down every
      // other service sharing the pool.
      const service = await MemoryService.create({
        database: test.db,
        clock: test.clock,
        migrateOnStart: false,
      });
      await service.close();

      // Still usable: the pool is alive.
      await expect(test.db.query('SELECT 1')).resolves.toBeDefined();
    });

    it('exposes which index it chose', () => {
      expect(['pgvector', 'brute-force']).toContain(memory.index.kind);
    });

    it('re-probes capabilities after migrating', async () => {
      // Capabilities are cached, so a stale `false` would keep the service
      // writing NULL vectors for the life of the process after a pgvector
      // upgrade. `migrate()` must refresh them.
      const spy = vi.spyOn(test.db, 'capabilities');
      await memory.migrate();
      expect(spy).toHaveBeenCalledWith({ refresh: true });
    });
  });
});
