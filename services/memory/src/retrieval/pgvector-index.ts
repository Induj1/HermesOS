/**
 * Semantic search in the database, via pgvector.
 *
 * The fast path. `ORDER BY embedding_v <=> $query LIMIT n` is answered by the
 * HNSW index built in migration 0004, so the database touches a few hundred
 * vectors rather than all of them and returns them already ranked.
 *
 * Only constructible where migration 0004 actually did something — see
 * `createSemanticIndex`, which probes rather than assumes.
 */

import type { Clock } from '@hermes/kernel';
import type { Queryable } from '../db/database.js';
import { UnsupportedError } from '../errors.js';
import type { ScoredMemory } from '../model.js';
import { mapMemory, MEMORY_COLUMNS, type MemoryRow } from '../repositories/mappers.js';
import {
  DEFAULT_SEARCH_LIMIT,
  type SemanticIndex,
  type SemanticQuery,
} from './semantic-index.js';

/** The width of `memory_embedding.embedding_v`. Must match migration 0004. */
export const PGVECTOR_DIMENSIONS = 768;

export class PgVectorIndex implements SemanticIndex {
  readonly kind = 'pgvector' as const;
  readonly #db: Queryable;
  readonly #clock: Clock;

  constructor(db: Queryable, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  async search(query: SemanticQuery): Promise<readonly ScoredMemory[]> {
    const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;

    if (query.embedding.length !== PGVECTOR_DIMENSIONS) {
      // Postgres would reject the cast anyway, but with "expected 768 dimensions,
      // not 384" from inside a query the caller never wrote. Refusing here names
      // the real problem: this index is cut for one width, and a provider of
      // another width needs the brute-force path (or a new migration).
      throw new UnsupportedError(
        `PgVectorIndex is built for vector(${String(PGVECTOR_DIMENSIONS)}) but was given ` +
          `a ${String(query.embedding.length)}-dimensional query. Either use an embedding ` +
          `provider of that width, or use BruteForceIndex, which is width-agnostic.`,
      );
    }

    const conditions = [
      'm.subject = $1',
      'm.forgotten_at IS NULL',
      'e.model = $2',
      'e.embedding_v IS NOT NULL',
    ];
    // pgvector has no binding for a JS array; the literal form is '[1,2,3]', cast
    // to vector. Built from numbers that came out of Float arithmetic, never from
    // caller text, so there is nothing to inject — but it stays a bound parameter
    // rather than an interpolation, so that stays true if the caller changes.
    const params: unknown[] = [
      query.subject,
      query.model,
      `[${query.embedding.join(',')}]`,
      limit,
    ];

    if (query.kinds && query.kinds.length > 0) {
      params.push(query.kinds);
      conditions.push(`m.kind = ANY($${String(params.length)}::text[])`);
    }
    if (query.includeExpired !== true) {
      params.push(this.#clock.now() / 1000);
      conditions.push(
        `(m.expires_at IS NULL OR m.expires_at > to_timestamp($${String(params.length)}))`,
      );
    }

    // `1 - (embedding_v <=> $3)` converts cosine *distance* to cosine
    // *similarity*, which is what the SemanticIndex contract returns. The ORDER
    // BY uses the raw `<=>` operator rather than the derived column: HNSW is only
    // consulted for an ORDER BY that matches its operator class exactly, and
    // ordering by `similarity DESC` — mathematically identical — would silently
    // fall back to a sequential scan over every vector.
    const sql = `
      SELECT ${MEMORY_COLUMNS('m')},
             1 - (e.embedding_v <=> $3::vector) AS similarity
        FROM memory_embedding e
        JOIN memory_record m ON m.id = e.memory_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.embedding_v <=> $3::vector
       LIMIT $4
    `;

    const { rows } = await this.#db.query<MemoryRow & { similarity: number }>(
      sql,
      params,
    );

    return (
      rows
        .map((row) => ({
          memory: mapMemory(row),
          score: row.similarity,
          similarity: row.similarity,
        }))
        // Applied after the query, not as a WHERE clause. A predicate on the
        // distance would not be index-assisted and would make HNSW scan to find
        // enough survivors; filtering `limit` already-ranked rows in JS costs
        // nothing and keeps the plan intact.
        .filter((result) => result.similarity >= (query.minSimilarity ?? -1))
    );
  }
}
