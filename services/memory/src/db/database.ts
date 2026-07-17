/**
 * The database seam.
 *
 * Everything above this file — repositories, retrieval, pruning — depends on
 * {@link Queryable}, an interface with one method. Nothing above it imports
 * `pg`. That is not ceremony: it is what lets a repository be unit-tested
 * against a fake that records SQL, and what keeps the choice of driver a
 * decision in one file rather than in thirty.
 *
 * The interface is deliberately SQL-in, rows-out rather than a query builder.
 * The schema (RFC-0002 §5) is hand-written SQL, reviewed as SQL, and indexed for
 * queries written as SQL; a builder in between would obscure the one thing most
 * worth reading.
 */

import pg from 'pg';
import { toError } from '../errors.js';

/** A row as the driver hands it back, before a mapper gives it a type. */
export type QueryRow = Record<string, unknown>;

export interface QueryResult<R extends QueryRow = QueryRow> {
  readonly rows: readonly R[];
  readonly rowCount: number;
}

/**
 * Anything that can run parameterised SQL: a pool, a single connection, or a
 * transaction. Repositories take this rather than a `Database`, so the same
 * repository code works inside and outside a transaction with no flag.
 */
export interface Queryable {
  query<R extends QueryRow = QueryRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface Database extends Queryable {
  /**
   * Run `fn` inside a transaction on a single connection, committing on return
   * and rolling back on throw.
   *
   * The `tx` handed to `fn` is the only thing that participates. Using the outer
   * `Database` inside the callback takes a *different* connection from the pool
   * and silently escapes the transaction — the classic pooled-transaction bug.
   * That is why the callback receives its own handle instead of relying on
   * ambient state.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /**
   * What this cluster can actually do. Probed once and cached.
   *
   * `refresh` re-probes. Needed after migrating, which can install pgvector's
   * column and change the answer — a cached `false` would otherwise persist for
   * the life of the process and keep writing NULL vectors after the upgrade
   * that was supposed to fix exactly that.
   */
  capabilities(options?: { readonly refresh?: boolean }): Promise<DatabaseCapabilities>;
  close(): Promise<void>;
}

export interface DatabaseCapabilities {
  /**
   * Whether the `vector` extension is installed *and* the pgvector column exists.
   * Both, because migration 0004 is conditional: an installed extension on a
   * database migrated before it was installed still has no `embedding_v`.
   */
  readonly pgvector: boolean;
  readonly serverVersion: string;
}

export interface PgDatabaseOptions {
  /** libpq connection string. Usually `process.env.DATABASE_URL`. */
  readonly connectionString: string;
  /**
   * Schema to place at the head of `search_path`.
   *
   * The isolation unit for integration tests: each run migrates into a private
   * `test_<random>` schema and drops it afterwards, so tests need no separate
   * database and cannot corrupt development data. `public` stays on the path
   * behind it because extensions (pgcrypto's `gen_random_uuid`, pg_trgm's
   * operator classes) live there and are cluster-wide, not per-schema.
   */
  readonly schema?: string;
  readonly maxConnections?: number;
  /** Fail a checkout rather than hang forever when the pool is exhausted. */
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly applicationName?: string;
}

/**
 * Postgres, via `pg`.
 *
 * The one place in this package that knows a driver exists.
 */
export class PgDatabase implements Database {
  readonly #pool: pg.Pool;
  #capabilities: Promise<DatabaseCapabilities> | undefined;
  #closed = false;

  constructor(options: PgDatabaseOptions) {
    const schema = options.schema;
    this.#pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
      application_name: options.applicationName ?? 'hermes-memory',
      // Set on the connection rather than per-query. A pooled connection is
      // reused across many queries, and a search_path set by one query would
      // leak into every unrelated one that follows on the same connection.
      ...(schema === undefined
        ? {}
        : { options: `-c search_path=${quoteIdentifier(schema)},public` }),
    });

    // A pooled connection can die while idle — a network blip, a server restart,
    // an admin's pg_terminate_backend. `pg` emits that as an 'error' on the pool
    // with no query attached, and an unhandled 'error' on an EventEmitter takes
    // the process down. Swallowing it here is correct: the pool has already
    // discarded the connection, and the next checkout gets a fresh one. A real
    // outage still surfaces, as a failure of the next actual query.
    this.#pool.on('error', () => undefined);
  }

  async query<R extends QueryRow = QueryRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    return runQuery<R>(this.#pool, sql, params);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(wrapClient(client));
      await client.query('COMMIT');
      return value;
    } catch (thrown) {
      // A ROLLBACK that itself throws means the connection is already broken.
      // Report the original failure — the reason the rollback happened is the
      // useful error, and masking it with "rollback failed" loses the cause.
      try {
        await client.query('ROLLBACK');
      } catch {
        // Intentionally swallowed; see above.
      }
      throw toError(thrown);
    } finally {
      // Must run even if COMMIT threw, or the pool leaks a connection per
      // failure and the service dies of exhaustion rather than of the bug.
      client.release();
    }
  }

  capabilities(
    options: { readonly refresh?: boolean } = {},
  ): Promise<DatabaseCapabilities> {
    if (options.refresh === true) this.#capabilities = undefined;
    // Memoised on the promise, not on the resolved value: two concurrent callers
    // during startup would otherwise both probe.
    this.#capabilities ??= this.#probe();
    return this.#capabilities;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }

  async #probe(): Promise<DatabaseCapabilities> {
    const { rows } = await this.query<{
      has_vector: boolean;
      server_version: string;
    }>(`
      SELECT
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'memory_embedding' AND column_name = 'embedding_v'
        ) AS has_vector,
        current_setting('server_version') AS server_version
    `);
    const row = rows[0];
    return {
      pgvector: row?.has_vector ?? false,
      serverVersion: row?.server_version ?? 'unknown',
    };
  }
}

function wrapClient(client: pg.PoolClient): Queryable {
  return {
    query: <R extends QueryRow = QueryRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> => runQuery<R>(client, sql, params),
  };
}

/** The subset of `pg.Pool` and `pg.PoolClient` this file needs. */
interface PgQueryable {
  query: pg.ClientBase['query'];
}

/**
 * Run one query and normalise what `pg` hands back.
 *
 * Two driver behaviours are handled here, and both are the kind of thing that
 * silently returns the wrong shape rather than throwing:
 *
 * 1. **Passing `values` forces the extended query protocol**, which permits
 *    exactly one statement. A migration file is many statements, so passing an
 *    empty array — rather than passing nothing — would make every migration fail
 *    with "cannot insert multiple commands into a prepared statement". Hence the
 *    branch: no params, no values argument.
 *
 * 2. **A multi-statement simple query returns an array of results**, one per
 *    statement, not a single result. `result.rows` is then `undefined`, and the
 *    obvious `result.rowCount ?? result.rows.length` throws on it. The last
 *    statement's result is the useful one — that is what a caller running a
 *    script means by "the result".
 */
async function runQuery<R extends QueryRow>(
  executor: PgQueryable,
  sql: string,
  params: readonly unknown[],
): Promise<QueryResult<R>> {
  const result: unknown =
    params.length === 0
      ? await executor.query(sql)
      : await executor.query(sql, params as unknown[]);

  if (Array.isArray(result)) {
    const last: unknown = result.at(-1);
    return normaliseResult<R>(last);
  }
  return normaliseResult<R>(result);
}

function normaliseResult<R extends QueryRow>(result: unknown): QueryResult<R> {
  const typed = result as pg.QueryResult<R> | undefined;
  // A statement that returns no rows at all (e.g. a bare `SET`) can leave `rows`
  // absent rather than empty.
  const rows = typed?.rows ?? [];
  return { rows, rowCount: typed?.rowCount ?? rows.length };
}

/**
 * Quote an identifier for interpolation into SQL.
 *
 * Identifiers cannot be parameterised — `SET search_path TO $1` is not a thing —
 * so schema names are the one string this package ever concatenates into SQL.
 * Rejecting the quote character outright rather than escaping it keeps the
 * blast radius at zero: no legitimate Hermes schema name contains one, and a
 * caller passing something that does is trying to do something else.
 */
export function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(
      `Unsafe SQL identifier: ${JSON.stringify(name)}. ` +
        `Identifiers must match /^[A-Za-z_][A-Za-z0-9_$]*$/.`,
    );
  }
  return `"${name}"`;
}
