/**
 * Choosing a semantic index.
 *
 * The one place that decides between pgvector and brute force, by asking the
 * database rather than by reading configuration. A flag would be a second source
 * of truth about a fact the database already knows, and it would be wrong the
 * first time someone installed the extension without updating `.env` — silently
 * running brute force on a cluster that could have used an index.
 */

import type { Clock, Logger } from '@hermes/kernel';
import { noopLogger } from '@hermes/kernel';
import type { Database } from '../db/database.js';
import { BruteForceIndex } from './brute-force-index.js';
import { PgVectorIndex, PGVECTOR_DIMENSIONS } from './pgvector-index.js';
import type { SemanticIndex } from './semantic-index.js';

export interface CreateIndexOptions {
  readonly logger?: Logger;
  /**
   * The embedding width in use. When it disagrees with the pgvector column's
   * declared width, the vector column cannot serve the query and brute force is
   * the only correct choice.
   */
  readonly dimensions?: number;
  /** Force brute force even where pgvector exists. For A/B-ing the two paths in tests. */
  readonly forceBruteForce?: boolean;
  readonly maxCandidates?: number;
}

/**
 * Probe, then pick.
 *
 * Chooses `PgVectorIndex` only when the extension is installed, migration 0004
 * actually added the column (`Database.capabilities` checks both), and the
 * embedding width matches what that column was cut for. Otherwise
 * `BruteForceIndex`, which works everywhere and is width-agnostic.
 *
 * The result is logged at info, deliberately. "Why is recall slow" and "did my
 * pgvector install take effect" are the two questions this subsystem gets asked,
 * and one startup line answers both.
 */
export async function createSemanticIndex(
  db: Database,
  clock: Clock,
  options: CreateIndexOptions = {},
): Promise<SemanticIndex> {
  const { logger = noopLogger, dimensions, forceBruteForce = false } = options;
  const bruteForce = (): SemanticIndex =>
    new BruteForceIndex(db, clock, {
      logger,
      ...(options.maxCandidates === undefined
        ? {}
        : { maxCandidates: options.maxCandidates }),
    });

  if (forceBruteForce) {
    logger.info('Semantic index: brute force (forced)');
    return bruteForce();
  }

  const capabilities = await db.capabilities();

  if (!capabilities.pgvector) {
    logger.info(
      "Semantic index: brute force. pgvector is not installed (or predates this database's migration); " +
        'searches read every vector for a subject. Fine at personal scale; install pgvector to index them.',
      { serverVersion: capabilities.serverVersion },
    );
    return bruteForce();
  }

  if (dimensions !== undefined && dimensions !== PGVECTOR_DIMENSIONS) {
    logger.warn(
      "Semantic index: brute force. pgvector is available, but the embedding provider's width " +
        'does not match the vector column, so the HNSW index cannot serve these queries. ' +
        'Add a migration for this width, or use a provider that matches.',
      { providerDimensions: dimensions, columnDimensions: PGVECTOR_DIMENSIONS },
    );
    return bruteForce();
  }

  logger.info('Semantic index: pgvector (HNSW, cosine)', {
    serverVersion: capabilities.serverVersion,
  });
  return new PgVectorIndex(db, clock);
}
