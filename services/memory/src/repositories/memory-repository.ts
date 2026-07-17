/**
 * Memory records and their embeddings.
 *
 * Reads default to live memories only (`forgotten_at IS NULL`). Pruning is a
 * soft delete, and a repository that made callers remember to filter tombstones
 * would leak forgotten memories back into retrieval the first time someone
 * forgot to — so the filter lives here, and seeing tombstones is the thing you
 * have to ask for.
 */

import type { Clock } from '@hermes/kernel';
import type { Queryable } from '../db/database.js';
import type { Embedding } from '../embedding/provider.js';
import {
  DimensionMismatchError,
  InvalidInputError,
  MemoryNotFoundError,
} from '../errors.js';
import type { ImportanceScorer } from '../importance.js';
import { clamp01 } from '../importance.js';
import type {
  MemoryId,
  MemoryKind,
  MemoryRecord,
  NewMemory,
  Subject,
} from '../model.js';
import { mapMemory, toTimestampParam, type MemoryRow } from './mappers.js';

export interface ListMemoriesOptions {
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
  readonly offset?: number;
  /** Include soft-deleted rows. Off by default; see the file header. */
  readonly includeForgotten?: boolean;
  /** Include rows whose `expires_at` has passed. Default true — see `search`. */
  readonly includeExpired?: boolean;
  readonly order?: 'recent' | 'importance';
}

export interface StoredEmbedding {
  readonly memoryId: MemoryId;
  readonly model: string;
  readonly dimensions: number;
  readonly embedding: Embedding;
}

export class MemoryRepository {
  readonly #db: Queryable;
  readonly #clock: Clock;
  readonly #scorer: ImportanceScorer;

  constructor(db: Queryable, clock: Clock, scorer: ImportanceScorer) {
    this.#db = db;
    this.#clock = clock;
    this.#scorer = scorer;
  }

  withQueryable(db: Queryable): MemoryRepository {
    return new MemoryRepository(db, this.#clock, this.#scorer);
  }

  /**
   * Write a memory, scoring it if the caller did not.
   *
   * The scorer runs here rather than in the service layer so that *every* path
   * into the table is scored — a memory written by a future ingestion job that
   * bypassed the service would otherwise land with the column default (0.5) and
   * quietly outrank real episodes.
   */
  async create(input: NewMemory): Promise<MemoryRecord> {
    const issues: string[] = [];
    if (input.subject.trim().length === 0) issues.push('subject must not be empty');
    if (input.content.trim().length === 0) issues.push('content must not be empty');
    if (input.importance !== undefined && !Number.isFinite(input.importance)) {
      issues.push('importance must be a finite number');
    }
    if (issues.length > 0) throw new InvalidInputError(issues);

    const importance =
      input.importance === undefined
        ? this.#scorer.score({
            kind: input.kind,
            content: input.content,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          })
        : // Clamped, not rejected: the CHECK constraint would turn a caller's
          // 1.5 into a database error three layers down, and "as important as
          // possible" is an unambiguous reading of it.
          clamp01(input.importance);

    const now = this.#clock.now() / 1000;
    const { rows } = await this.#db.query<MemoryRow>(
      `INSERT INTO memory_record (
         subject, kind, content, source_conversation_id, source_message_id,
         metadata, importance, pinned, expires_at, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, to_timestamp($9), to_timestamp($10), to_timestamp($10))
       RETURNING *`,
      [
        input.subject,
        input.kind,
        input.content,
        input.sourceConversationId ?? null,
        input.sourceMessageId ?? null,
        JSON.stringify(input.metadata ?? {}),
        importance,
        input.pinned ?? false,
        toTimestampParam(input.expiresAt),
        now,
      ],
    );

    const row = rows[0];
    if (!row) throw new Error('INSERT into memory_record returned no row');
    return mapMemory(row);
  }

  async findById(id: MemoryId): Promise<MemoryRecord | undefined> {
    const { rows } = await this.#db.query<MemoryRow>(
      'SELECT * FROM memory_record WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? mapMemory(row) : undefined;
  }

  async getById(id: MemoryId): Promise<MemoryRecord> {
    const found = await this.findById(id);
    if (!found) throw new MemoryNotFoundError('memory', id);
    return found;
  }

  async findByIds(ids: readonly MemoryId[]): Promise<readonly MemoryRecord[]> {
    if (ids.length === 0) return [];
    // `= ANY($1)` rather than a built IN-list: one parameter, one plan in the
    // prepared-statement cache regardless of how many ids, and no string
    // concatenation anywhere near user data.
    const { rows } = await this.#db.query<MemoryRow>(
      'SELECT * FROM memory_record WHERE id = ANY($1::uuid[])',
      [ids],
    );
    return rows.map(mapMemory);
  }

  async list(
    subject: Subject,
    options: ListMemoriesOptions = {},
  ): Promise<readonly MemoryRecord[]> {
    const {
      kinds,
      limit = 50,
      offset = 0,
      includeForgotten = false,
      includeExpired = true,
      order = 'recent',
    } = options;

    const conditions = ['subject = $1'];
    const params: unknown[] = [subject];

    if (!includeForgotten) conditions.push('forgotten_at IS NULL');
    if (!includeExpired) {
      params.push(this.#clock.now() / 1000);
      conditions.push(
        `(expires_at IS NULL OR expires_at > to_timestamp($${String(params.length)}))`,
      );
    }
    if (kinds && kinds.length > 0) {
      params.push(kinds);
      conditions.push(`kind = ANY($${String(params.length)}::text[])`);
    }

    params.push(limit, offset);
    const limitParam = String(params.length - 1);
    const offsetParam = String(params.length);

    const orderBy =
      order === 'importance' ? 'importance DESC, created_at DESC' : 'created_at DESC';

    const { rows } = await this.#db.query<MemoryRow>(
      `SELECT * FROM memory_record
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params,
    );
    return rows.map(mapMemory);
  }

  /**
   * Lexical search, via the pg_trgm index on `content`.
   *
   * The retrieval that works on any cluster the init script has touched —
   * pg_trgm is always available, pgvector may not be. It is what makes a
   * HermesOS with no embeddings degrade to "worse search" instead of "no
   * search", and what `HybridRetriever` blends with semantic results.
   *
   * Expired memories are excluded here but not from `list`. A retrieval feeding
   * a model must not surface a fact that has passed its shelf life; an operator
   * listing what is stored should still see it, until pruning collects it.
   */
  async search(
    subject: Subject,
    query: string,
    limit = 10,
  ): Promise<readonly { memory: MemoryRecord; similarity: number }[]> {
    if (query.trim().length === 0) return [];
    const { rows } = await this.#db.query<MemoryRow & { similarity: number }>(
      `SELECT *, similarity(content, $2) AS similarity
         FROM memory_record
        WHERE subject = $1
          AND forgotten_at IS NULL
          AND (expires_at IS NULL OR expires_at > to_timestamp($4))
          AND content % $2
        ORDER BY similarity DESC, importance DESC
        LIMIT $3`,
      [subject, query, limit, this.#clock.now() / 1000],
    );
    return rows.map((row) => ({ memory: mapMemory(row), similarity: row.similarity }));
  }

  /**
   * Record that these memories were retrieved.
   *
   * The feedback loop that lets use correct the scorer's guesses: both columns
   * feed `retentionScore`, so a memory that keeps coming back keeps surviving.
   *
   * One statement for the whole batch, and deliberately not awaited on the
   * retrieval path — see `MemoryService.recall`.
   */
  async touch(ids: readonly MemoryId[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#db.query(
      `UPDATE memory_record
          SET access_count = access_count + 1,
              last_accessed_at = to_timestamp($2)
        WHERE id = ANY($1::uuid[])`,
      [ids, this.#clock.now() / 1000],
    );
  }

  async update(
    id: MemoryId,
    patch: Partial<
      Pick<MemoryRecord, 'content' | 'importance' | 'pinned' | 'expiresAt' | 'metadata'>
    >,
  ): Promise<MemoryRecord> {
    const assignments: string[] = [];
    const params: unknown[] = [id];

    const push = (column: string, value: unknown, cast = ''): void => {
      params.push(value);
      assignments.push(`${column} = $${String(params.length)}${cast}`);
    };

    if (patch.content !== undefined) push('content', patch.content);
    if (patch.importance !== undefined) push('importance', clamp01(patch.importance));
    if (patch.pinned !== undefined) push('pinned', patch.pinned);
    if (patch.metadata !== undefined) {
      push('metadata', JSON.stringify(patch.metadata), '::jsonb');
    }
    if ('expiresAt' in patch) {
      // `in` rather than `!== undefined`: undefined is how a caller says "clear
      // the expiry", and exactOptionalPropertyTypes makes that distinction real
      // rather than accidental.
      params.push(toTimestampParam(patch.expiresAt));
      assignments.push(`expires_at = to_timestamp($${String(params.length)})`);
    }

    if (assignments.length === 0) return this.getById(id);

    params.push(this.#clock.now() / 1000);
    assignments.push(`updated_at = to_timestamp($${String(params.length)})`);

    const { rows } = await this.#db.query<MemoryRow>(
      `UPDATE memory_record SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    const row = rows[0];
    if (!row) throw new MemoryNotFoundError('memory', id);
    return mapMemory(row);
  }

  /** Soft-delete. What pruning calls; recoverable by `remember`. */
  async forget(ids: readonly MemoryId[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await this.#db.query(
      `UPDATE memory_record
          SET forgotten_at = to_timestamp($2), updated_at = to_timestamp($2)
        WHERE id = ANY($1::uuid[]) AND forgotten_at IS NULL`,
      [ids, this.#clock.now() / 1000],
    );
    return rowCount;
  }

  /** Undo a soft-delete. The reason `forget` does not DELETE. */
  async remember(ids: readonly MemoryId[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await this.#db.query(
      `UPDATE memory_record
          SET forgotten_at = NULL, updated_at = to_timestamp($2)
        WHERE id = ANY($1::uuid[]) AND forgotten_at IS NOT NULL`,
      [ids, this.#clock.now() / 1000],
    );
    return rowCount;
  }

  /**
   * Hard-delete tombstones forgotten longer ago than `olderThanMs`.
   *
   * The only irreversible operation in this file, which is why it is separate
   * from `forget`, takes an explicit age, and is never called automatically.
   */
  async purgeForgotten(olderThanMs: number): Promise<number> {
    const cutoff = (this.#clock.now() - olderThanMs) / 1000;
    const { rowCount } = await this.#db.query(
      'DELETE FROM memory_record WHERE forgotten_at IS NOT NULL AND forgotten_at < to_timestamp($1)',
      [cutoff],
    );
    return rowCount;
  }

  async countBySubject(subject: Subject, includeForgotten = false): Promise<number> {
    const { rows } = await this.#db.query<{ count: string }>(
      `SELECT count(*) AS count FROM memory_record
        WHERE subject = $1 ${includeForgotten ? '' : 'AND forgotten_at IS NULL'}`,
      [subject],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // --- embeddings ---------------------------------------------------------

  /**
   * Store a vector for a memory under a model.
   *
   * Upsert on (memory_id, model), so re-embedding under the same model replaces
   * and re-embedding under a new one adds. Both are correct: a memory's text can
   * be edited, and a deployment can change models without discarding the vectors
   * it already has.
   *
   * Writes `embedding_v` too when the column exists (migration 0004), inside the
   * same statement — the two columns must never disagree, and a second UPDATE
   * could fail on its own and leave them that way.
   */
  async putEmbedding(input: StoredEmbedding, hasPgvector: boolean): Promise<void> {
    if (input.embedding.length !== input.dimensions) {
      throw new DimensionMismatchError(
        `Embedding for memory ${input.memoryId}`,
        input.dimensions,
        input.embedding.length,
      );
    }

    const vectorColumns = hasPgvector
      ? {
          insert: ', embedding_v',
          // The `dimensions =` guard matches the vector column's declared width:
          // a 384-wide vector cast to vector(768) is an error, not a truncation,
          // so a mixed-model deployment would fail every write without it.
          values: `, CASE WHEN $4 = 768 THEN $3::real[]::vector(768) ELSE NULL END`,
          update: ', embedding_v = EXCLUDED.embedding_v',
        }
      : { insert: '', values: '', update: '' };

    await this.#db.query(
      `INSERT INTO memory_embedding (memory_id, model, dimensions, embedding${vectorColumns.insert})
       VALUES ($1, $2, $4, $3::real[]${vectorColumns.values})
       ON CONFLICT (memory_id, model) DO UPDATE
         SET embedding = EXCLUDED.embedding,
             dimensions = EXCLUDED.dimensions,
             created_at = now()${vectorColumns.update}`,
      [input.memoryId, input.model, input.embedding, input.dimensions],
    );
  }

  async getEmbedding(
    memoryId: MemoryId,
    model: string,
  ): Promise<StoredEmbedding | undefined> {
    const { rows } = await this.#db.query<{
      memory_id: string;
      model: string;
      dimensions: number;
      embedding: number[];
    }>(
      'SELECT memory_id, model, dimensions, embedding FROM memory_embedding WHERE memory_id = $1 AND model = $2',
      [memoryId, model],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      memoryId: row.memory_id as MemoryId,
      model: row.model,
      dimensions: row.dimensions,
      embedding: row.embedding,
    };
  }

  /**
   * Live memories for a subject that have no vector under `model`.
   *
   * The backfill query: what to embed after adopting a new model, or after a
   * write whose embedding failed. Its existence is why embedding is allowed to
   * fail without failing the write it accompanied — see `MemoryService.remember`.
   */
  async findUnembedded(
    subject: Subject,
    model: string,
    limit = 100,
  ): Promise<readonly MemoryRecord[]> {
    const { rows } = await this.#db.query<MemoryRow>(
      `SELECT m.* FROM memory_record m
        WHERE m.subject = $1
          AND m.forgotten_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM memory_embedding e
             WHERE e.memory_id = m.id AND e.model = $2
          )
        ORDER BY m.created_at DESC
        LIMIT $3`,
      [subject, model, limit],
    );
    return rows.map(mapMemory);
  }
}
