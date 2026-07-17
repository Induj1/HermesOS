/**
 * Conversation memory, against a real Postgres.
 *
 * These are integration tests by necessity, not by preference. The properties
 * worth testing here — that `seq` stays dense under concurrent appends, that a
 * cascade fires, that a CTE is atomic — are properties of the *database*, and a
 * fake would only prove that the fake agrees with my assumptions about it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidInputError, MemoryNotFoundError } from '../src/errors.js';
import { toConversationId } from '../src/model.js';
import { ConversationRepository } from '../src/repositories/conversation-repository.js';
import {
  describeIntegration,
  truncateAll,
  withTestDatabase,
} from './helpers/database.js';

describeIntegration('ConversationRepository', () => {
  const test = withTestDatabase();
  let repository: ConversationRepository;

  beforeEach(async () => {
    await truncateAll(test.db);
    repository = new ConversationRepository(test.db, test.clock);
  });

  describe('create', () => {
    it('stores a conversation with its metadata', async () => {
      const conversation = await repository.create({
        subject: 'ada',
        title: 'Morning brief',
        metadata: { channel: 'telegram' },
      });

      expect(conversation).toMatchObject({
        subject: 'ada',
        title: 'Morning brief',
        metadata: { channel: 'telegram' },
        messageCount: 0,
        closedAt: undefined,
      });
      expect(conversation.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('defaults title and metadata', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      expect(conversation.title).toBeUndefined();
      expect(conversation.metadata).toEqual({});
    });

    it('timestamps from the injected clock, not the wall clock', async () => {
      // The kernel makes time an injected capability so tests are deterministic
      // (RFC-0001 §12). A repository calling Date.now() would break that for
      // every host driving Hermes with a TestClock.
      const conversation = await repository.create({ subject: 'ada' });
      expect(conversation.createdAt).toBe(test.clock.now());
    });

    it('rejects an empty subject', async () => {
      await expect(repository.create({ subject: '   ' })).rejects.toThrow(
        InvalidInputError,
      );
    });
  });

  describe('appendMessage', () => {
    it('assigns dense, 1-based seq numbers', async () => {
      const conversation = await repository.create({ subject: 'ada' });

      const first = await repository.appendMessage(conversation.id, {
        role: 'user',
        content: 'Hello',
      });
      const second = await repository.appendMessage(conversation.id, {
        role: 'assistant',
        content: 'Hi',
      });

      expect(first.seq).toBe(1);
      expect(second.seq).toBe(2);
    });

    it('returns seq as a number, not a string', async () => {
      // int8 arrives from `pg` as a string, and "1" + 1 is "11". The mapper
      // converts; this is what proves it.
      const conversation = await repository.create({ subject: 'ada' });
      const message = await repository.appendMessage(conversation.id, {
        role: 'user',
        content: 'Hello',
      });
      expect(typeof message.seq).toBe('number');
    });

    it('keeps seq dense under concurrent appends', async () => {
      // The race the CTE exists to prevent. SELECT MAX(seq)+1 then INSERT would
      // have two appends read the same max; one then dies on the UNIQUE
      // constraint. This is the single most important test in the file.
      const conversation = await repository.create({ subject: 'ada' });

      const messages = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          repository.appendMessage(conversation.id, {
            role: 'user',
            content: `Message ${String(i)}`,
          }),
        ),
      );

      const seqs = messages.map((message) => message.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    });

    it('does not contend across different conversations', async () => {
      // The other half of the locking design: appends to different conversations
      // take different row locks, so they must not serialise on each other.
      const [a, b] = await Promise.all([
        repository.create({ subject: 'ada' }),
        repository.create({ subject: 'grace' }),
      ]);

      const messages = await Promise.all([
        repository.appendMessage(a.id, { role: 'user', content: 'a1' }),
        repository.appendMessage(b.id, { role: 'user', content: 'b1' }),
        repository.appendMessage(a.id, { role: 'user', content: 'a2' }),
        repository.appendMessage(b.id, { role: 'user', content: 'b2' }),
      ]);

      // Each conversation numbers from 1 independently.
      expect(messages.map((m) => m.seq).sort()).toEqual([1, 1, 2, 2]);
    });

    it('increments the conversation message_count', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      await repository.appendMessage(conversation.id, {
        role: 'user',
        content: 'Hello',
      });
      await repository.appendMessage(conversation.id, {
        role: 'user',
        content: 'Again',
      });

      const reloaded = await repository.getById(conversation.id);
      expect(reloaded.messageCount).toBe(2);
    });

    it('refreshes updated_at, which findOpenBySubject orders by', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      await test.clock.advance(60_000);
      await repository.appendMessage(conversation.id, {
        role: 'user',
        content: 'Hello',
      });

      const reloaded = await repository.getById(conversation.id);
      expect(reloaded.updatedAt).toBeGreaterThan(conversation.updatedAt);
    });

    it('throws for an unknown conversation rather than silently doing nothing', async () => {
      // The one failure mode of INSERT ... SELECT from a CTE: the UPDATE matches
      // nothing, the SELECT yields nothing, the INSERT succeeds having inserted
      // nothing, and the caller thinks it worked.
      await expect(
        repository.appendMessage(
          toConversationId('00000000-0000-0000-0000-000000000000'),
          {
            role: 'user',
            content: 'Hello',
          },
        ),
      ).rejects.toThrow(MemoryNotFoundError);
    });

    it('rejects empty content', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      await expect(
        repository.appendMessage(conversation.id, { role: 'user', content: '' }),
      ).rejects.toThrow(InvalidInputError);
    });

    it('accepts every valid role', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      for (const role of ['user', 'assistant', 'system', 'tool'] as const) {
        const message = await repository.appendMessage(conversation.id, {
          role,
          content: `from ${role}`,
        });
        expect(message.role).toBe(role);
      }
    });

    it('stores message metadata', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      const message = await repository.appendMessage(conversation.id, {
        role: 'assistant',
        content: 'Done',
        metadata: { model: 'llama3.2', tokens: 42 },
      });
      expect(message.metadata).toEqual({ model: 'llama3.2', tokens: 42 });
    });
  });

  describe('transcript', () => {
    async function seed(count: number): Promise<ReturnType<typeof repository.create>> {
      const conversation = await repository.create({ subject: 'ada' });
      for (let i = 1; i <= count; i++) {
        await repository.appendMessage(conversation.id, {
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Message ${String(i)}`,
        });
      }
      return conversation;
    }

    it('returns the whole transcript oldest-first by default', async () => {
      const conversation = await seed(5);
      const messages = await repository.transcript(conversation.id);
      expect(messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    it('returns the LAST n messages when limited, still oldest-first', async () => {
      // The shape a model's context window wants, and the reason for the nested
      // query: ORDER BY seq ASC LIMIT 3 would return the *first* three — the
      // wrong end of the conversation entirely.
      const conversation = await seed(10);
      const messages = await repository.transcript(conversation.id, { limit: 3 });
      expect(messages.map((m) => m.seq)).toEqual([8, 9, 10]);
    });

    it('returns newest-first on request', async () => {
      const conversation = await seed(10);
      const messages = await repository.transcript(conversation.id, {
        limit: 3,
        order: 'desc',
      });
      expect(messages.map((m) => m.seq)).toEqual([10, 9, 8]);
    });

    it('pages incrementally with afterSeq', async () => {
      const conversation = await seed(5);
      const messages = await repository.transcript(conversation.id, { afterSeq: 3 });
      expect(messages.map((m) => m.seq)).toEqual([4, 5]);
    });

    it('combines afterSeq with a limit', async () => {
      const conversation = await seed(10);
      const messages = await repository.transcript(conversation.id, {
        afterSeq: 2,
        limit: 3,
      });
      expect(messages.map((m) => m.seq)).toEqual([8, 9, 10]);
    });

    it('returns nothing for an empty conversation', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      expect(await repository.transcript(conversation.id)).toEqual([]);
    });

    it('does not leak other conversations', async () => {
      const mine = await seed(3);
      const theirs = await seed(3);

      const messages = await repository.transcript(mine.id);
      expect(messages).toHaveLength(3);
      expect(messages.every((m) => m.conversationId === mine.id)).toBe(true);
      expect(messages.every((m) => m.conversationId !== theirs.id)).toBe(true);
    });
  });

  describe('findOpenBySubject', () => {
    it('returns the most recently updated open conversation', async () => {
      const older = await repository.create({ subject: 'ada' });
      await test.clock.advance(1_000);
      const newer = await repository.create({ subject: 'ada' });

      const found = await repository.findOpenBySubject('ada');
      expect(found?.id).toBe(newer.id);
      expect(found?.id).not.toBe(older.id);
    });

    it('ignores closed conversations', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      await repository.close(conversation.id);
      expect(await repository.findOpenBySubject('ada')).toBeUndefined();
    });

    it('scopes to the subject', async () => {
      await repository.create({ subject: 'grace' });
      expect(await repository.findOpenBySubject('ada')).toBeUndefined();
    });

    it('returns undefined rather than creating one', async () => {
      // Deciding when a new conversation starts is the host's judgement — a
      // Telegram chat and a CLI session draw that line differently.
      expect(await repository.findOpenBySubject('nobody')).toBeUndefined();
    });
  });

  describe('close', () => {
    it('marks a conversation closed', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      const closed = await repository.close(conversation.id);
      expect(closed.closedAt).toBe(test.clock.now());
    });

    it('is idempotent, because retries exist', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      const first = await repository.close(conversation.id);
      await test.clock.advance(1_000);
      const second = await repository.close(conversation.id);

      // The second close must not move the timestamp: the conversation closed
      // when it closed.
      expect(second.closedAt).toBe(first.closedAt);
    });

    it('throws for an unknown conversation', async () => {
      await expect(
        repository.close(toConversationId('00000000-0000-0000-0000-000000000000')),
      ).rejects.toThrow(MemoryNotFoundError);
    });
  });

  describe('findById / getById', () => {
    it('findById returns undefined for an unknown id', async () => {
      expect(
        await repository.findById(
          toConversationId('00000000-0000-0000-0000-000000000000'),
        ),
      ).toBeUndefined();
    });

    it('getById throws for an unknown id', async () => {
      await expect(
        repository.getById(toConversationId('00000000-0000-0000-0000-000000000000')),
      ).rejects.toThrow(MemoryNotFoundError);
    });
  });

  describe('listBySubject', () => {
    it('returns conversations newest-first', async () => {
      const first = await repository.create({ subject: 'ada' });
      await test.clock.advance(1_000);
      const second = await repository.create({ subject: 'ada' });

      const listed = await repository.listBySubject('ada');
      expect(listed.map((c) => c.id)).toEqual([second.id, first.id]);
    });

    it('includes closed conversations', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      await repository.close(conversation.id);
      expect(await repository.listBySubject('ada')).toHaveLength(1);
    });

    it('honours the limit', async () => {
      for (let i = 0; i < 5; i++) {
        await repository.create({ subject: 'ada' });
        await test.clock.advance(1_000);
      }
      expect(await repository.listBySubject('ada', 2)).toHaveLength(2);
    });
  });

  describe('delete', () => {
    it('deletes the conversation and cascades to its messages', async () => {
      const conversation = await repository.create({ subject: 'ada' });
      await repository.appendMessage(conversation.id, {
        role: 'user',
        content: 'Hello',
      });

      expect(await repository.delete(conversation.id)).toBe(true);
      expect(await repository.findById(conversation.id)).toBeUndefined();

      const { rows } = await test.db.query<{ count: string }>(
        'SELECT count(*) AS count FROM message WHERE conversation_id = $1',
        [conversation.id],
      );
      expect(Number(rows[0]?.count)).toBe(0);
    });

    it('reports false for an unknown id', async () => {
      expect(
        await repository.delete(
          toConversationId('00000000-0000-0000-0000-000000000000'),
        ),
      ).toBe(false);
    });
  });

  describe('withQueryable', () => {
    it('binds the repository to a transaction', async () => {
      // Repositories take a Queryable, not a Database, so the same code works
      // inside and outside a transaction. This proves the rollback reaches it.
      await test.db
        .transaction(async (tx) => {
          const scoped = repository.withQueryable(tx);
          await scoped.create({ subject: 'rollback-me' });
          throw new Error('abort');
        })
        .catch(() => undefined);

      expect(await repository.listBySubject('rollback-me')).toHaveLength(0);
    });

    it('commits on success', async () => {
      await test.db.transaction(async (tx) => {
        await repository.withQueryable(tx).create({ subject: 'keep-me' });
      });
      expect(await repository.listBySubject('keep-me')).toHaveLength(1);
    });
  });
});
