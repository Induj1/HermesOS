/**
 * Memory records and embeddings, against a real Postgres.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DimensionMismatchError,
  InvalidInputError,
  MemoryNotFoundError,
} from '../src/errors.js';
import {
  ConstantImportanceScorer,
  HeuristicImportanceScorer,
} from '../src/importance.js';
import { toMemoryId, type MemoryRecord } from '../src/model.js';
import { MemoryRepository } from '../src/repositories/memory-repository.js';
import { ConversationRepository } from '../src/repositories/conversation-repository.js';
import {
  describeIntegration,
  truncateAll,
  withTestDatabase,
} from './helpers/database.js';

const MISSING = toMemoryId('00000000-0000-0000-0000-000000000000');
const DAY = 24 * 60 * 60 * 1000;

describeIntegration('MemoryRepository', () => {
  const test = withTestDatabase();
  let repository: MemoryRepository;
  let hasPgvector = false;

  beforeEach(async () => {
    await truncateAll(test.db);
    repository = new MemoryRepository(
      test.db,
      test.clock,
      new HeuristicImportanceScorer(),
    );
    ({ pgvector: hasPgvector } = await test.db.capabilities());
  });

  describe('create', () => {
    it('stores a memory', async () => {
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Their sister is called Mara',
        metadata: { source: 'chat' },
      });

      expect(memory).toMatchObject({
        subject: 'ada',
        kind: 'fact',
        content: 'Their sister is called Mara',
        metadata: { source: 'chat' },
        accessCount: 0,
        pinned: false,
        forgottenAt: undefined,
      });
      expect(memory.createdAt).toBe(test.clock.now());
    });

    it('scores importance when the caller gives none', async () => {
      const preference = await repository.create({
        subject: 'ada',
        kind: 'preference',
        content: 'Always brief me at seven in the morning',
      });
      const episode = await repository.create({
        subject: 'ada',
        kind: 'episode',
        content: 'Ate a sandwich at some point',
      });

      expect(preference.importance).toBeGreaterThan(episode.importance);
    });

    it('honours an explicit importance', async () => {
      const memory = await repository.create({
        subject: 'ada',
        kind: 'episode',
        content: 'Ate a sandwich',
        importance: 0.99,
      });
      expect(memory.importance).toBeCloseTo(0.99, 5);
    });

    it('clamps an out-of-range importance instead of hitting the CHECK constraint', async () => {
      // "As important as possible" is an unambiguous reading of 1.5. Letting it
      // through would surface as a constraint violation three layers down.
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Something',
        importance: 1.5,
      });
      expect(memory.importance).toBe(1);
    });

    it('uses the injected scorer', async () => {
      const fixed = new MemoryRepository(
        test.db,
        test.clock,
        new ConstantImportanceScorer(0.25),
      );
      const memory = await fixed.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Anything',
      });
      expect(memory.importance).toBeCloseTo(0.25, 5);
    });

    it('records provenance', async () => {
      const conversations = new ConversationRepository(test.db, test.clock);
      const conversation = await conversations.create({ subject: 'ada' });
      const message = await conversations.appendMessage(conversation.id, {
        role: 'user',
        content: 'My sister is Mara',
      });

      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Their sister is called Mara',
        sourceConversationId: conversation.id,
        sourceMessageId: message.id,
      });

      expect(memory.sourceConversationId).toBe(conversation.id);
      expect(memory.sourceMessageId).toBe(message.id);
    });

    it('outlives the conversation it came from', async () => {
      // Forgetting where you learned something is normal; forgetting the thing
      // because the transcript was pruned is a bug. This is the ON DELETE SET
      // NULL contract.
      const conversations = new ConversationRepository(test.db, test.clock);
      const conversation = await conversations.create({ subject: 'ada' });
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Their sister is called Mara',
        sourceConversationId: conversation.id,
      });

      await conversations.delete(conversation.id);

      const survivor = await repository.getById(memory.id);
      expect(survivor.content).toBe('Their sister is called Mara');
      expect(survivor.sourceConversationId).toBeUndefined();
    });

    it('rejects empty subject and content', async () => {
      await expect(
        repository.create({ subject: '  ', kind: 'fact', content: 'x' }),
      ).rejects.toThrow(InvalidInputError);
      await expect(
        repository.create({ subject: 'ada', kind: 'fact', content: '  ' }),
      ).rejects.toThrow(InvalidInputError);
    });

    it('reports every input problem at once', async () => {
      // Same contract as the kernel's MissionValidationError: an author fixing a
      // spec wants all the issues, not one per run.
      await expect(
        repository.create({ subject: '', kind: 'fact', content: '' }),
      ).rejects.toThrow(/subject must not be empty; content must not be empty/);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Fact one',
        importance: 0.9,
      });
      await test.clock.advance(1_000);
      await repository.create({
        subject: 'ada',
        kind: 'episode',
        content: 'Episode one',
        importance: 0.2,
      });
      await test.clock.advance(1_000);
      await repository.create({
        subject: 'grace',
        kind: 'fact',
        content: 'Someone else',
      });
    });

    it('scopes to the subject', async () => {
      const memories = await repository.list('ada');
      expect(memories).toHaveLength(2);
      expect(memories.every((memory) => memory.subject === 'ada')).toBe(true);
    });

    it('orders newest-first by default', async () => {
      const memories = await repository.list('ada');
      expect(memories.map((m) => m.content)).toEqual(['Episode one', 'Fact one']);
    });

    it('orders by importance on request', async () => {
      const memories = await repository.list('ada', { order: 'importance' });
      expect(memories.map((m) => m.content)).toEqual(['Fact one', 'Episode one']);
    });

    it('filters by kind', async () => {
      const memories = await repository.list('ada', { kinds: ['episode'] });
      expect(memories.map((m) => m.content)).toEqual(['Episode one']);
    });

    it('pages with limit and offset', async () => {
      expect(await repository.list('ada', { limit: 1 })).toHaveLength(1);
      const second = await repository.list('ada', { limit: 1, offset: 1 });
      expect(second[0]?.content).toBe('Fact one');
    });

    it('hides forgotten memories by default', async () => {
      const [first] = await repository.list('ada');
      await repository.forget([first?.id as never]);

      expect(await repository.list('ada')).toHaveLength(1);
      expect(await repository.list('ada', { includeForgotten: true })).toHaveLength(2);
    });

    it('shows expired memories by default but can exclude them', async () => {
      // An operator listing what is stored should still see an expired memory,
      // until pruning collects it. A retrieval feeding a model must not.
      await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Parked in bay 14',
        expiresAt: test.clock.now() - 1,
      });

      expect(await repository.list('ada')).toHaveLength(3);
      expect(await repository.list('ada', { includeExpired: false })).toHaveLength(2);
    });
  });

  describe('search (lexical)', () => {
    it('finds a memory by trigram similarity', async () => {
      await repository.create({
        subject: 'ada',
        kind: 'episode',
        content: 'The dentist appointment is on Tuesday',
      });

      const hits = await repository.search('ada', 'dentist appointment');
      expect(hits).toHaveLength(1);
      expect(hits[0]?.similarity).toBeGreaterThan(0);
    });

    it('scopes to the subject', async () => {
      await repository.create({
        subject: 'grace',
        kind: 'fact',
        content: 'dentist appointment',
      });
      expect(await repository.search('ada', 'dentist appointment')).toEqual([]);
    });

    it('excludes forgotten and expired memories', async () => {
      const forgotten = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'dentist appointment forgotten',
      });
      await repository.forget([forgotten.id]);
      await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'dentist appointment expired',
        expiresAt: test.clock.now() - 1,
      });

      expect(await repository.search('ada', 'dentist appointment')).toEqual([]);
    });

    it('returns nothing for an empty query without hitting the database', async () => {
      expect(await repository.search('ada', '   ')).toEqual([]);
    });
  });

  describe('touch', () => {
    it('increments access_count and stamps last_accessed_at', async () => {
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Something',
      });
      await test.clock.advance(5_000);

      await repository.touch([memory.id]);

      const touched = await repository.getById(memory.id);
      expect(touched.accessCount).toBe(1);
      expect(touched.lastAccessedAt).toBe(test.clock.now());
    });

    it('handles a batch in one statement', async () => {
      const memories = await Promise.all([
        repository.create({ subject: 'ada', kind: 'fact', content: 'One' }),
        repository.create({ subject: 'ada', kind: 'fact', content: 'Two' }),
      ]);

      await repository.touch(memories.map((memory) => memory.id));

      for (const memory of memories) {
        expect((await repository.getById(memory.id)).accessCount).toBe(1);
      }
    });

    it('is a no-op for an empty list', async () => {
      await expect(repository.touch([])).resolves.toBeUndefined();
    });
  });

  describe('update', () => {
    let memory: MemoryRecord;

    beforeEach(async () => {
      memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Original',
        importance: 0.5,
      });
    });

    it('patches only what it is given', async () => {
      const updated = await repository.update(memory.id, { content: 'Revised' });
      expect(updated.content).toBe('Revised');
      expect(updated.importance).toBeCloseTo(0.5, 5);
    });

    it('pins and unpins', async () => {
      expect((await repository.update(memory.id, { pinned: true })).pinned).toBe(true);
      expect((await repository.update(memory.id, { pinned: false })).pinned).toBe(
        false,
      );
    });

    it('sets an expiry', async () => {
      const at = test.clock.now() + DAY;
      expect((await repository.update(memory.id, { expiresAt: at })).expiresAt).toBe(
        at,
      );
    });

    it('clears an expiry when passed undefined explicitly', async () => {
      // `'expiresAt' in patch` rather than `!== undefined`: undefined is how a
      // caller says "clear it", and exactOptionalPropertyTypes makes that
      // distinction real rather than accidental.
      await repository.update(memory.id, { expiresAt: test.clock.now() + DAY });
      const cleared = await repository.update(memory.id, { expiresAt: undefined });
      expect(cleared.expiresAt).toBeUndefined();
    });

    it('refreshes updated_at', async () => {
      await test.clock.advance(1_000);
      const updated = await repository.update(memory.id, { content: 'Revised' });
      expect(updated.updatedAt).toBeGreaterThan(memory.updatedAt);
    });

    it('returns the record unchanged for an empty patch', async () => {
      const updated = await repository.update(memory.id, {});
      expect(updated).toEqual(memory);
    });

    it('throws for an unknown id', async () => {
      await expect(repository.update(MISSING, { content: 'x' })).rejects.toThrow(
        MemoryNotFoundError,
      );
    });
  });

  describe('forget / remember', () => {
    it('soft-deletes, so the row survives', async () => {
      // The whole reason forget() is not DELETE: a pruning bug is recoverable by
      // clearing a column, not by restoring a backup.
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Something',
      });

      expect(await repository.forget([memory.id])).toBe(1);

      const tombstone = await repository.getById(memory.id);
      expect(tombstone.forgottenAt).toBe(test.clock.now());
      expect(tombstone.content).toBe('Something');
    });

    it('is idempotent', async () => {
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Something',
      });
      expect(await repository.forget([memory.id])).toBe(1);
      expect(await repository.forget([memory.id])).toBe(0);
    });

    it('undoes a forget', async () => {
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Something',
      });
      await repository.forget([memory.id]);

      expect(await repository.remember([memory.id])).toBe(1);
      expect((await repository.getById(memory.id)).forgottenAt).toBeUndefined();
    });

    it('handles empty lists', async () => {
      expect(await repository.forget([])).toBe(0);
      expect(await repository.remember([])).toBe(0);
    });
  });

  describe('purgeForgotten', () => {
    it('hard-deletes tombstones older than the cutoff', async () => {
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Something',
      });
      await repository.forget([memory.id]);
      await test.clock.advance(30 * DAY);

      expect(await repository.purgeForgotten(7 * DAY)).toBe(1);
      expect(await repository.findById(memory.id)).toBeUndefined();
    });

    it('spares recent tombstones', async () => {
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Something',
      });
      await repository.forget([memory.id]);
      await test.clock.advance(DAY);

      expect(await repository.purgeForgotten(7 * DAY)).toBe(0);
      expect(await repository.findById(memory.id)).toBeDefined();
    });

    it('never touches live memories', async () => {
      await repository.create({ subject: 'ada', kind: 'fact', content: 'Alive' });
      await test.clock.advance(365 * DAY);
      expect(await repository.purgeForgotten(0)).toBe(0);
    });
  });

  describe('countBySubject', () => {
    it('counts live memories, and optionally tombstones', async () => {
      const a = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'One',
      });
      await repository.create({ subject: 'ada', kind: 'fact', content: 'Two' });
      await repository.forget([a.id]);

      expect(await repository.countBySubject('ada')).toBe(1);
      expect(await repository.countBySubject('ada', true)).toBe(2);
    });
  });

  describe('findByIds', () => {
    it('returns the requested memories', async () => {
      const a = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'One',
      });
      const b = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Two',
      });

      const found = await repository.findByIds([a.id, b.id]);
      expect(found.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    });

    it('returns nothing for an empty list without hitting the database', async () => {
      expect(await repository.findByIds([])).toEqual([]);
    });
  });

  describe('embeddings', () => {
    async function subject(): Promise<MemoryRecord> {
      return repository.create({ subject: 'ada', kind: 'fact', content: 'Something' });
    }

    it('stores and reads back a vector', async () => {
      const memory = await subject();
      await repository.putEmbedding(
        {
          memoryId: memory.id,
          model: 'test-3',
          dimensions: 3,
          embedding: [0.1, 0.2, 0.3],
        },
        hasPgvector,
      );

      const stored = await repository.getEmbedding(memory.id, 'test-3');
      expect(stored?.dimensions).toBe(3);
      // real (float4) is single-precision, so 0.1 does not round-trip exactly.
      // That is a property of the column type, not a bug — and the reason to
      // compare approximately rather than with toEqual.
      expect(stored?.embedding[0]).toBeCloseTo(0.1, 5);
      expect(stored?.embedding).toHaveLength(3);
    });

    it('upserts on (memory_id, model)', async () => {
      const memory = await subject();
      await repository.putEmbedding(
        { memoryId: memory.id, model: 'test-3', dimensions: 3, embedding: [1, 0, 0] },
        hasPgvector,
      );
      await repository.putEmbedding(
        { memoryId: memory.id, model: 'test-3', dimensions: 3, embedding: [0, 1, 0] },
        hasPgvector,
      );

      const stored = await repository.getEmbedding(memory.id, 'test-3');
      expect(stored?.embedding[1]).toBeCloseTo(1, 5);

      const { rows } = await test.db.query<{ count: string }>(
        'SELECT count(*) AS count FROM memory_embedding WHERE memory_id = $1',
        [memory.id],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it('keeps vectors from different models side by side', async () => {
      // (memory_id, model) is the key precisely so a deployment can change models
      // without discarding the vectors it already has.
      const memory = await subject();
      await repository.putEmbedding(
        { memoryId: memory.id, model: 'old', dimensions: 3, embedding: [1, 0, 0] },
        hasPgvector,
      );
      await repository.putEmbedding(
        { memoryId: memory.id, model: 'new', dimensions: 2, embedding: [0, 1] },
        hasPgvector,
      );

      expect((await repository.getEmbedding(memory.id, 'old'))?.dimensions).toBe(3);
      expect((await repository.getEmbedding(memory.id, 'new'))?.dimensions).toBe(2);
    });

    it('rejects a vector whose length disagrees with its declared dimension', async () => {
      // Caught before the database, because a truncated vector makes cosine
      // similarity return a plausible number rather than an error.
      const memory = await subject();
      await expect(
        repository.putEmbedding(
          { memoryId: memory.id, model: 'test', dimensions: 5, embedding: [1, 2, 3] },
          hasPgvector,
        ),
      ).rejects.toThrow(DimensionMismatchError);
    });

    it('cascades when its memory is hard-deleted', async () => {
      const memory = await subject();
      await repository.putEmbedding(
        { memoryId: memory.id, model: 'test-3', dimensions: 3, embedding: [1, 0, 0] },
        hasPgvector,
      );

      await repository.forget([memory.id]);
      await repository.purgeForgotten(-1);

      expect(await repository.getEmbedding(memory.id, 'test-3')).toBeUndefined();
    });

    it('returns undefined for a memory with no vector under that model', async () => {
      const memory = await subject();
      expect(await repository.getEmbedding(memory.id, 'nope')).toBeUndefined();
    });
  });

  describe('findUnembedded', () => {
    it('finds live memories with no vector under the model', async () => {
      const embedded = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Has one',
      });
      const bare = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Has none',
      });
      await repository.putEmbedding(
        { memoryId: embedded.id, model: 'test-3', dimensions: 3, embedding: [1, 0, 0] },
        hasPgvector,
      );

      const pending = await repository.findUnembedded('ada', 'test-3');
      expect(pending.map((m) => m.id)).toEqual([bare.id]);
    });

    it('treats a memory embedded under another model as unembedded', async () => {
      // The backfill query after adopting a new model.
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Old vector',
      });
      await repository.putEmbedding(
        { memoryId: memory.id, model: 'old', dimensions: 3, embedding: [1, 0, 0] },
        hasPgvector,
      );

      const pending = await repository.findUnembedded('ada', 'new');
      expect(pending.map((m) => m.id)).toEqual([memory.id]);
    });

    it('ignores forgotten memories', async () => {
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Gone',
      });
      await repository.forget([memory.id]);
      expect(await repository.findUnembedded('ada', 'test-3')).toEqual([]);
    });
  });
});
