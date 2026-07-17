/**
 * Semantic search without pgvector: read the vectors, compute cosine in Node.
 *
 * This is the fallback, and it is honest about what it is. It reads every live
 * vector for a subject and scores each one, so it is O(memories × dimensions)
 * per query with the whole working set crossing the wire. At a personal-assistant
 * scale — thousands of memories per subject, not millions — that is a handful of
 * milliseconds and completely fine. It is not fine at 100k, and `maxCandidates`
 * exists so that the failure is a logged, bounded degradation rather than a slow
 * OOM.
 *
 * It exists because the native Homebrew Postgres 17 that HermesOS develops
 * against has no `vector` extension available, and because "semantic retrieval
 * only works if you first install an extension" is a bad property for the
 * subsystem the whole assistant depends on. See RFC-0002 §6.
 */

import type { Clock, Logger } from '@hermes/kernel';
import { noopLogger } from '@hermes/kernel';
import type { Queryable } from '../db/database.js';
import { DimensionMismatchError } from '../errors.js';
import type { ScoredMemory } from '../model.js';
import { mapMemory, MEMORY_COLUMNS, type MemoryRow } from '../repositories/mappers.js';
import {
  cosineSimilarity,
  DEFAULT_SEARCH_LIMIT,
  type SemanticIndex,
  type SemanticQuery,
} from './semantic-index.js';

export interface BruteForceOptions {
  /**
   * Most vectors to pull per query. Default 5,000.
   *
   * A ceiling on the damage, not a tuning knob. Exceeding it means results are
   * silently incomplete — the true nearest neighbour may be in the rows that were
   * not read — so crossing it logs a warning naming the subject. That warning is
   * the signal to install pgvector, and it is the whole reason this option is not
   * simply `LIMIT ALL`.
   */
  readonly maxCandidates?: number;
  readonly logger?: Logger;
}

export class BruteForceIndex implements SemanticIndex {
  readonly kind = 'brute-force' as const;
  readonly #db: Queryable;
  readonly #clock: Clock;
  readonly #maxCandidates: number;
  readonly #logger: Logger;

  constructor(db: Queryable, clock: Clock, options: BruteForceOptions = {}) {
    this.#db = db;
    this.#clock = clock;
    this.#maxCandidates = options.maxCandidates ?? 5_000;
    this.#logger = options.logger ?? noopLogger;
  }

  async search(query: SemanticQuery): Promise<readonly ScoredMemory[]> {
    const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;

    const conditions = [
      'm.subject = $1',
      'm.forgotten_at IS NULL',
      'e.model = $2',
      // Rows of another width cannot be compared and would throw in
      // cosineSimilarity. Excluded in SQL rather than skipped in the loop: this
      // is a normal state during a model migration, when old and new vectors
      // coexist, not an error.
      'e.dimensions = $3',
    ];
    const params: unknown[] = [query.subject, query.model, query.embedding.length];

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

    params.push(this.#maxCandidates + 1);
    const candidateLimit = `$${String(params.length)}`;

    const { rows } = await this.#db.query<MemoryRow & { embedding: number[] }>(
      `SELECT ${MEMORY_COLUMNS('m')}, e.embedding
         FROM memory_embedding e
         JOIN memory_record m ON m.id = e.memory_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.created_at DESC
        LIMIT ${candidateLimit}`,
      params,
    );

    // Fetching maxCandidates + 1 is how "we hit the ceiling" is distinguished
    // from "there were exactly that many". Without the extra row, a subject with
    // precisely 5,000 memories would warn every query, forever.
    const truncated = rows.length > this.#maxCandidates;
    const candidates = truncated ? rows.slice(0, this.#maxCandidates) : rows;
    if (truncated) {
      this.#logger.warn(
        'Brute-force semantic search truncated its candidate set; results may be incomplete. Install pgvector.',
        {
          subject: query.subject,
          model: query.model,
          maxCandidates: this.#maxCandidates,
        },
      );
    }

    const minSimilarity = query.minSimilarity ?? -1;
    const scored: ScoredMemory[] = [];

    for (const row of candidates) {
      // The `dimensions = $3` filter should make this impossible. It is checked
      // anyway because the alternative — a RangeError out of cosineSimilarity
      // with no row context — is how a corrupt vector would actually present,
      // and this names the memory instead.
      if (row.embedding.length !== query.embedding.length) {
        throw new DimensionMismatchError(
          `Stored embedding for memory ${row.id} under model "${query.model}"`,
          query.embedding.length,
          row.embedding.length,
        );
      }
      const similarity = cosineSimilarity(query.embedding, row.embedding);
      if (similarity < minSimilarity) continue;
      scored.push({ memory: mapMemory(row), score: similarity, similarity });
    }

    // A full sort of the survivors. A heap would be asymptotically better for
    // limit ≪ candidates, but at these sizes sort() is faster in practice and is
    // one line instead of forty.
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
