/**
 * The migration runner.
 *
 * ~200 lines instead of a dependency, for the same reason the kernel has no
 * dependencies: this is the code that decides what shape the data is in, and it
 * is worth being able to read all of it. It does four things a hand-rolled
 * runner usually gets wrong, and each is the reason it exists rather than a
 * `for` loop over some `.sql` files:
 *
 * 1. **It locks.** Two processes booting at once (an API and a Telegram app, or
 *    two CI jobs) would otherwise both see the same pending list and both apply
 *    it. `pg_advisory_xact_lock` makes the second wait and then find nothing to
 *    do.
 * 2. **It checksums.** An applied migration whose file later changed is drift,
 *    and drift is silent: the code expects a schema the database does not have.
 *    That is an error here, not a warning (see {@link MigrationDriftError}).
 * 3. **It is atomic.** Postgres has transactional DDL, so the whole run — every
 *    migration *and* the ledger rows recording them — commits or rolls back
 *    together. See §"Why one transaction" below.
 * 4. **It records.** `schema_migrations` is the ledger; nothing else is.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@hermes/kernel';
import { MigrationDriftError, MigrationFailedError, toError } from '../errors.js';
import type { Database, Queryable } from './database.js';

/**
 * Where the .sql files live.
 *
 * `../../migrations` resolves to the same directory from `src/db/migrator.ts` and
 * from `dist/db/migrator.js`, because dist mirrors src and migrations sits beside
 * both. That is why the path is computed from `import.meta.url` rather than from
 * `process.cwd()`, which would depend on where the host was started from.
 */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

/**
 * A 64-bit key for `pg_advisory_xact_lock`. Advisory locks share one namespace
 * per database, so this constant must not collide with another subsystem's.
 * Derived from the first 8 bytes of sha256('hermes.memory.migrations') and then
 * pinned as a literal — deriving it at runtime would mean a hash change silently
 * became a lock change, which is the one thing a lock key must never do.
 */
const MIGRATION_LOCK_KEY = 7_749_301_154_620_119_000n;

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface Migration {
  /** File name, e.g. `0002_memory.sql`. The ledger's primary key. */
  readonly name: string;
  /** The leading 4 digits. Must be unique and gapless-ish; ordering is by this. */
  readonly version: number;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly durationMs: number;
}

export interface MigrateOptions {
  readonly dir?: string;
  readonly logger?: Logger;
  /**
   * Re-apply and re-record migrations whose checksum has drifted, instead of
   * throwing.
   *
   * The escape hatch for the one case where drift is legitimate: migration 0004
   * is conditional on pgvector being installed, so installing the extension
   * later means the same unchanged file must run again to add the vector column.
   * Every migration is written to be idempotent (`IF NOT EXISTS`, `DO $$` guards)
   * so that this is safe — but it is opt-in, because "just re-run it" is exactly
   * the reflex that turns a drift warning into a dropped table.
   */
  readonly repair?: boolean;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly durationMs: number;
}

/** Load and validate the migration files, in order. */
export async function loadMigrations(
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<readonly Migration[]> {
  const entries = await readdir(dir);
  const files = entries.filter((name) => name.endsWith('.sql')).sort();

  const migrations: Migration[] = [];
  const seenVersions = new Map<number, string>();

  for (const name of files) {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (!match?.[1]) {
      throw new MigrationFailedError(
        name,
        new Error(
          `Migration file names must match NNNN_lower_snake.sql (e.g. 0005_add_tags.sql)`,
        ),
      );
    }
    const version = Number(match[1]);

    // Two migrations sharing a number is not a style problem: file order and
    // numeric order disagree from that point on, so two developers' databases
    // apply them in different orders and diverge. Catch it at load, not at 3am.
    const clash = seenVersions.get(version);
    if (clash !== undefined) {
      throw new MigrationFailedError(
        name,
        new Error(`Duplicate migration version ${match[1]}: also used by "${clash}"`),
      );
    }
    seenVersions.set(version, name);

    const sql = await readFile(join(dir, name), 'utf8');
    migrations.push({ name, version, sql, checksum: checksumOf(sql) });
  }

  return migrations;
}

/**
 * Apply every migration not yet recorded in the ledger.
 *
 * Idempotent: running it against an up-to-date database is one lock, one select,
 * and a commit.
 *
 * ## Why one transaction
 *
 * Every migration in the run shares a single transaction, rather than each
 * getting its own. Postgres allows this because its DDL is transactional (unlike
 * MySQL's), and it buys the property that matters most for a schema: there is no
 * such thing as half-migrated. If 0003 fails, 0001 and 0002 roll back with it
 * and the database is exactly as it was — so the fix is "correct the file and
 * re-run", never "work out which of these five ran and hand-repair the rest".
 *
 * The cost is that a failing run wastes the work of the migrations before it,
 * and that the whole run holds the lock. Both are irrelevant at this scale and
 * would stop being irrelevant if a migration ever needed to rewrite a large
 * table or run `CREATE INDEX CONCURRENTLY` — which cannot run in a transaction
 * at all. If that day comes, the honest change is a per-migration transaction
 * plus a session-level advisory lock, and this comment is the argument to beat.
 */
export async function migrate(
  db: Database,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const { dir = DEFAULT_MIGRATIONS_DIR, logger, repair = false } = options;
  const started = Date.now();
  const migrations = await loadMigrations(dir);

  return db.transaction(async (tx) => {
    // Before anything else, including reading the ledger: a concurrent runner
    // must not be allowed to observe the same pending list we are about to act
    // on. Transaction-scoped, so it releases on commit or rollback with no
    // unlock call to forget.
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY.toString()]);

    await ensureLedger(tx);
    const applied = await readLedger(tx);

    const appliedNames: string[] = [];
    const skippedNames: string[] = [];

    for (const migration of migrations) {
      const record = applied.get(migration.name);

      if (record) {
        if (record.checksum === migration.checksum) {
          skippedNames.push(migration.name);
          continue;
        }
        if (!repair) {
          throw new MigrationDriftError(
            migration.name,
            record.checksum,
            migration.checksum,
          );
        }
        logger?.warn('Re-applying drifted migration', {
          migration: migration.name,
          recorded: record.checksum,
          actual: migration.checksum,
        });
      }

      const at = Date.now();
      try {
        // No parameters, so `pg` uses the simple query protocol and the file may
        // contain many statements — which is what lets a migration be a readable
        // .sql file rather than an array of strings.
        await tx.query(migration.sql);
      } catch (thrown) {
        throw new MigrationFailedError(migration.name, toError(thrown));
      }
      const durationMs = Date.now() - at;

      await tx.query(
        `INSERT INTO schema_migrations (name, version, checksum, applied_at, duration_ms)
         VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (name) DO UPDATE
           SET checksum = EXCLUDED.checksum,
               applied_at = EXCLUDED.applied_at,
               duration_ms = EXCLUDED.duration_ms`,
        [migration.name, migration.version, migration.checksum, durationMs],
      );

      appliedNames.push(migration.name);
      logger?.info('Applied migration', { migration: migration.name, durationMs });
    }

    return {
      applied: appliedNames,
      skipped: skippedNames,
      durationMs: Date.now() - started,
    };
  });
}

/** What the ledger says is applied, in order. For diagnostics and tests. */
export async function appliedMigrations(
  db: Queryable,
): Promise<readonly AppliedMigration[]> {
  await ensureLedger(db);
  return [...(await readLedger(db)).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

async function ensureLedger(tx: Queryable): Promise<void> {
  // Not a migration itself, for the obvious reason: the thing that records which
  // migrations ran cannot be recorded by the mechanism it bootstraps.
  await tx.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      version     integer NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    )
  `);
}

async function readLedger(tx: Queryable): Promise<Map<string, AppliedMigration>> {
  const { rows } = await tx.query<{
    name: string;
    checksum: string;
    applied_at: Date;
    duration_ms: number;
  }>('SELECT name, checksum, applied_at, duration_ms FROM schema_migrations');

  return new Map(
    rows.map((row) => [
      row.name,
      {
        name: row.name,
        checksum: row.checksum,
        appliedAt: row.applied_at,
        durationMs: row.duration_ms,
      },
    ]),
  );
}

/**
 * Checksum of a migration's bytes.
 *
 * Line endings are normalised first so that a checkout on Windows, or a stray
 * editor setting, does not read as drift. Nothing else is normalised: a
 * whitespace change inside a statement is a real change to a file that is
 * supposed to be immutable once applied.
 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}
