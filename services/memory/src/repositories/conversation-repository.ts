/**
 * Conversation memory: the verbatim record of what was said.
 *
 * This is the only part of the memory stack that is not derived and not lossy.
 * Nothing here summarises, scores, or forgets — `memory_record` does all of that
 * on top. Keep the split: a change that wants to compress a transcript in place
 * wants to write a `summary` memory, not to edit these rows.
 */

import type { Clock } from '@hermes/kernel';
import type { Queryable } from '../db/database.js';
import { InvalidInputError, MemoryNotFoundError } from '../errors.js';
import type {
  Conversation,
  ConversationId,
  Message,
  NewConversation,
  NewMessage,
  Subject,
} from '../model.js';
import {
  mapConversation,
  mapMessage,
  type ConversationRow,
  type MessageRow,
} from './mappers.js';

export interface TranscriptOptions {
  /** Most recent N messages. Omit for the whole transcript. */
  readonly limit?: number;
  /** Return oldest-first (`asc`, the default) or newest-first (`desc`). */
  readonly order?: 'asc' | 'desc';
  /** Only messages after this seq. For incremental reads. */
  readonly afterSeq?: number;
}

export class ConversationRepository {
  readonly #db: Queryable;
  readonly #clock: Clock;

  /**
   * `clock` is the kernel's injectable {@link Clock}, not `Date.now`. It is used
   * only where a timestamp is *chosen* rather than read back from a column, so
   * that a host driving Hermes with a `TestClock` sees one consistent notion of
   * time rather than two that disagree.
   */
  constructor(db: Queryable, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Bind these repositories to a transaction handle. See `Database.transaction`. */
  withQueryable(db: Queryable): ConversationRepository {
    return new ConversationRepository(db, this.#clock);
  }

  async create(input: NewConversation): Promise<Conversation> {
    const subject = requireSubject(input.subject);
    const { rows } = await this.#db.query<ConversationRow>(
      `INSERT INTO conversation (subject, title, metadata, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, to_timestamp($4), to_timestamp($4))
       RETURNING *`,
      [
        subject,
        input.title ?? null,
        JSON.stringify(input.metadata ?? {}),
        this.#clock.now() / 1000,
      ],
    );
    return mapConversation(expectOne(rows, 'conversation'));
  }

  async findById(id: ConversationId): Promise<Conversation | undefined> {
    const { rows } = await this.#db.query<ConversationRow>(
      'SELECT * FROM conversation WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? mapConversation(row) : undefined;
  }

  async getById(id: ConversationId): Promise<Conversation> {
    const found = await this.findById(id);
    if (!found) throw new MemoryNotFoundError('conversation', id);
    return found;
  }

  /**
   * The most recently updated open conversation for a subject, if any.
   *
   * The lookup behind "keep talking in the same thread". Returns undefined
   * rather than creating one: deciding when a new conversation starts is the
   * host's judgement (a Telegram chat and a CLI session draw that line
   * differently), and this service has no basis for guessing.
   */
  async findOpenBySubject(subject: Subject): Promise<Conversation | undefined> {
    const { rows } = await this.#db.query<ConversationRow>(
      `SELECT * FROM conversation
        WHERE subject = $1 AND closed_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [subject],
    );
    const row = rows[0];
    return row ? mapConversation(row) : undefined;
  }

  async listBySubject(subject: Subject, limit = 50): Promise<readonly Conversation[]> {
    const { rows } = await this.#db.query<ConversationRow>(
      `SELECT * FROM conversation
        WHERE subject = $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [subject, limit],
    );
    return rows.map(mapConversation);
  }

  /**
   * Append a message, assigning its `seq`.
   *
   * ## Why this is one statement
   *
   * `seq` must be dense and per-conversation, which rules out a sequence (global
   * and gappy). The obvious implementation — `SELECT MAX(seq)+1` then `INSERT` —
   * is a lost-update race: two concurrent appends read the same max and one
   * fails on the UNIQUE constraint, or worse, both succeed under a weaker
   * constraint and the transcript silently loses a message.
   *
   * Instead the `UPDATE ... RETURNING message_count` takes a row lock on the
   * conversation, so concurrent appends to the *same* conversation serialise on
   * it and each observes the other's increment. Appends to *different*
   * conversations lock different rows and do not contend at all, which is the
   * property that matters — Hermes has many subjects and one thread each.
   *
   * The CTE makes it a single statement, so it is atomic with no explicit
   * transaction and no chance of a caller forgetting one. It also refreshes
   * `updated_at`, which is what `findOpenBySubject` orders by.
   */
  async appendMessage(
    conversationId: ConversationId,
    message: NewMessage,
  ): Promise<Message> {
    const issues: string[] = [];
    if (message.content.length === 0) issues.push('message content must not be empty');
    if (issues.length > 0) throw new InvalidInputError(issues);

    const { rows } = await this.#db.query<MessageRow>(
      `WITH bumped AS (
         UPDATE conversation
            SET message_count = message_count + 1,
                updated_at = to_timestamp($5)
          WHERE id = $1
         RETURNING id, message_count
       )
       INSERT INTO message (conversation_id, seq, role, content, metadata, created_at)
       SELECT bumped.id, bumped.message_count, $2, $3, $4::jsonb, to_timestamp($5)
         FROM bumped
       RETURNING *`,
      [
        conversationId,
        message.role,
        message.content,
        JSON.stringify(message.metadata ?? {}),
        this.#clock.now() / 1000,
      ],
    );

    // Zero rows means the CTE's UPDATE matched nothing, i.e. no such
    // conversation — the INSERT ... SELECT then has nothing to insert and
    // succeeds silently. That is the one failure mode of this shape, and it
    // would otherwise look like "the append worked" to the caller.
    const row = rows[0];
    if (!row) throw new MemoryNotFoundError('conversation', conversationId);
    return mapMessage(row);
  }

  /**
   * Read a transcript.
   *
   * `limit` with `order: 'asc'` means *the last N messages, oldest-first* — the
   * shape a model's context window wants. Getting there needs the inner query to
   * sort DESC (to find the newest N against the `message_conversation_recent_idx`
   * index) and the outer one to flip it back; sorting ASC with a LIMIT would
   * return the *first* N messages, which is the wrong end of the conversation.
   */
  async transcript(
    conversationId: ConversationId,
    options: TranscriptOptions = {},
  ): Promise<readonly Message[]> {
    const { limit, order = 'asc', afterSeq } = options;

    const conditions = ['conversation_id = $1'];
    const params: unknown[] = [conversationId];
    if (afterSeq !== undefined) {
      params.push(afterSeq);
      conditions.push(`seq > $${String(params.length)}`);
    }

    // No limit: one plain, ordered scan.
    if (limit === undefined) {
      const { rows } = await this.#db.query<MessageRow>(
        `SELECT * FROM message
          WHERE ${conditions.join(' AND ')}
          ORDER BY seq ${order === 'desc' ? 'DESC' : 'ASC'}`,
        params,
      );
      return rows.map(mapMessage);
    }

    params.push(limit);
    const limitParam = `$${String(params.length)}`;
    const { rows } = await this.#db.query<MessageRow>(
      `SELECT * FROM (
         SELECT * FROM message
          WHERE ${conditions.join(' AND ')}
          ORDER BY seq DESC
          LIMIT ${limitParam}
       ) AS recent
       ORDER BY seq ${order === 'desc' ? 'DESC' : 'ASC'}`,
      params,
    );
    return rows.map(mapMessage);
  }

  async close(id: ConversationId): Promise<Conversation> {
    const { rows } = await this.#db.query<ConversationRow>(
      `UPDATE conversation
          SET closed_at = to_timestamp($2), updated_at = to_timestamp($2)
        WHERE id = $1 AND closed_at IS NULL
       RETURNING *`,
      [id, this.#clock.now() / 1000],
    );
    const row = rows[0];
    if (row) return mapConversation(row);

    // Zero rows is ambiguous — no such conversation, or already closed. Only the
    // first is an error; closing twice is something a retry does and must be
    // idempotent.
    const existing = await this.findById(id);
    if (!existing) throw new MemoryNotFoundError('conversation', id);
    return existing;
  }

  /**
   * Delete a conversation and its messages.
   *
   * Derived `memory_record`s survive: their FK is ON DELETE SET NULL, so they
   * lose their provenance but not themselves. Forgetting where you learned
   * something is normal; forgetting the thing is not.
   */
  async delete(id: ConversationId): Promise<boolean> {
    const { rowCount } = await this.#db.query(
      'DELETE FROM conversation WHERE id = $1',
      [id],
    );
    return rowCount > 0;
  }
}

function requireSubject(subject: string): Subject {
  if (subject.trim().length === 0) {
    throw new InvalidInputError(['subject must not be empty']);
  }
  return subject;
}

function expectOne<T>(rows: readonly T[], kind: string): T {
  const row = rows[0];
  // A RETURNING clause on a successful INSERT always yields a row. This is here
  // for noUncheckedIndexedAccess, and to fail loudly rather than as `undefined`
  // three frames away if that assumption ever stops holding.
  if (!row) throw new Error(`INSERT into ${kind} returned no row`);
  return row;
}
