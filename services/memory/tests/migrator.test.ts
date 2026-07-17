/**
 * The migration runner.
 *
 * Loading and checksumming are pure and tested without a database. Everything
 * else — locking, atomicity, drift — only means anything against a real
 * Postgres, so those tests take a real one.
 */

import { readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appliedMigrations,
  checksumOf,
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  migrate,
} from '../src/db/migrator.js';
import { MigrationDriftError, MigrationFailedError } from '../src/errors.js';
import type { Database } from '../src/db/database.js';
import { describeIntegration, withEmptySchema } from './helpers/database.js';

describe('checksumOf', () => {
  it('is stable for the same input', () => {
    expect(checksumOf('SELECT 1')).toBe(checksumOf('SELECT 1'));
  });

  it('changes when the SQL changes', () => {
    expect(checksumOf('SELECT 1')).not.toBe(checksumOf('SELECT 2'));
  });

  it('ignores line-ending differences', () => {
    // A checkout on Windows, or a stray editor setting, must not read as drift.
    expect(checksumOf('a\r\nb\r\n')).toBe(checksumOf('a\nb\n'));
  });

  it('does not ignore whitespace inside a statement', () => {
    // A file that is supposed to be immutable once applied really is immutable.
    expect(checksumOf('SELECT  1')).not.toBe(checksumOf('SELECT 1'));
  });
});

describe('loadMigrations', () => {
  it('loads the shipped migrations in version order', async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(4);

    const versions = migrations.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it('matches the .sql files on disk', async () => {
    // Guards the failure where a migration is added but the loader's glob or
    // naming rule quietly excludes it — the database then differs from the
    // repository with nothing to indicate it.
    const onDisk = (await readdir(DEFAULT_MIGRATIONS_DIR)).filter((name) =>
      name.endsWith('.sql'),
    );
    const loaded = (await loadMigrations()).map((migration) => migration.name);
    expect(loaded.sort()).toEqual(onDisk.sort());
  });

  it('gives every migration a checksum and non-empty SQL', async () => {
    for (const migration of await loadMigrations()) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(migration.sql.trim().length).toBeGreaterThan(0);
    }
  });

  it('resolves its directory from the module, not the working directory', async () => {
    // `../../migrations` must resolve identically from src/db/ and dist/db/,
    // which is why the path comes from import.meta.url. If this used cwd, the
    // service would break when started from anywhere but the package root.
    expect(DEFAULT_MIGRATIONS_DIR).toMatch(/services[/\\]memory[/\\]migrations$/);
    await expect(loadMigrations(DEFAULT_MIGRATIONS_DIR)).resolves.toBeDefined();
  });

  it('rejects a badly named file', async () => {
    await expect(
      loadMigrations(new URL('./fixtures/bad-name', import.meta.url).pathname),
    ).rejects.toThrow(MigrationFailedError);
  });

  it('rejects duplicate version numbers', async () => {
    // Two migrations sharing a number means file order and numeric order
    // disagree, so two developers' databases apply them in different orders and
    // diverge. Caught at load, not at 3am.
    await expect(
      loadMigrations(new URL('./fixtures/duplicate-version', import.meta.url).pathname),
    ).rejects.toThrow(/Duplicate migration version/);
  });
});

describeIntegration('migrate (integration)', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function freshSchema(): Promise<Database> {
    const { db, drop } = await withEmptySchema();
    cleanup = drop;
    return db;
  }

  it('applies every migration to an empty schema', async () => {
    const db = await freshSchema();
    const result = await migrate(db);

    expect(result.applied).toEqual([
      '0001_conversation.sql',
      '0002_memory.sql',
      '0003_mission.sql',
      '0004_pgvector.sql',
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('creates the expected tables', async () => {
    const db = await freshSchema();
    await migrate(db);

    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'conversation',
      'memory_embedding',
      'memory_record',
      'message',
      'mission',
      'mission_event',
      'mission_task',
      'schema_migrations',
    ]);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const db = await freshSchema();
    await migrate(db);
    const second = await migrate(db);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(4);
  });

  it('records each migration in the ledger with a checksum', async () => {
    const db = await freshSchema();
    await migrate(db);

    const applied = await appliedMigrations(db);
    const expected = await loadMigrations();

    expect(applied.map((entry) => entry.name)).toEqual(
      expected.map((migration) => migration.name),
    );
    for (const [index, entry] of applied.entries()) {
      expect(entry.checksum).toBe(expected[index]?.checksum);
    }
  });

  it('throws MigrationDriftError when an applied file has changed', async () => {
    // Drift is silent otherwise: the code expects a schema the database does not
    // have, and every query written against the new file is a guess.
    const db = await freshSchema();
    await migrate(db);

    await db.query(
      `UPDATE schema_migrations SET checksum = 'tampered' WHERE name = $1`,
      ['0001_conversation.sql'],
    );

    await expect(migrate(db)).rejects.toThrow(MigrationDriftError);
  });

  it('names the drifted migration and points at the fix', async () => {
    const db = await freshSchema();
    await migrate(db);
    await db.query(
      `UPDATE schema_migrations SET checksum = 'tampered' WHERE name = $1`,
      ['0002_memory.sql'],
    );

    await expect(migrate(db)).rejects.toThrow(
      /0002_memory\.sql.*Applied migrations are immutable/s,
    );
  });

  it('re-applies a drifted migration when repair is set', async () => {
    // The escape hatch for the legitimate case: 0004 is conditional on pgvector,
    // so installing the extension later means the same unchanged file must run
    // again. Every migration is guarded, which is what makes this safe.
    const db = await freshSchema();
    await migrate(db);
    await db.query(
      `UPDATE schema_migrations SET checksum = 'tampered' WHERE name = $1`,
      ['0004_pgvector.sql'],
    );

    const result = await migrate(db, { repair: true });

    expect(result.applied).toEqual(['0004_pgvector.sql']);
    const applied = await appliedMigrations(db);
    const repaired = applied.find((entry) => entry.name === '0004_pgvector.sql');
    const expected = (await loadMigrations()).find(
      (migration) => migration.name === '0004_pgvector.sql',
    );
    expect(repaired?.checksum).toBe(expected?.checksum);
  });

  it('rolls the whole run back when a migration fails', async () => {
    // The property that makes "correct the file and re-run" the only recovery
    // step there is: there is no such thing as half-migrated.
    const db = await freshSchema();
    const dir = new URL('./fixtures/failing', import.meta.url).pathname;

    await expect(migrate(db, { dir })).rejects.toThrow(MigrationFailedError);

    // 0001 in that fixture succeeds and 0002 throws. If the transaction is doing
    // its job, 0001's table is gone too.
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
    );
    expect(rows.map((row) => row.table_name)).not.toContain('fixture_one');
  });

  it('names the migration that failed', async () => {
    const db = await freshSchema();
    const dir = new URL('./fixtures/failing', import.meta.url).pathname;
    await expect(migrate(db, { dir })).rejects.toThrow(/0002_broken\.sql/);
  });

  it('survives concurrent runners', async () => {
    // Two processes booting at once — an API and a Telegram app, or two CI jobs.
    // Without the advisory lock both see the same pending list and both apply
    // it, and the second fails on "relation already exists".
    const db = await freshSchema();

    const results = await Promise.all([migrate(db), migrate(db), migrate(db)]);

    // Exactly one runner did the work; the others found nothing to do.
    const appliers = results.filter((result) => result.applied.length > 0);
    expect(appliers).toHaveLength(1);
    expect(appliers[0]?.applied).toHaveLength(4);

    const applied = await appliedMigrations(db);
    expect(applied).toHaveLength(4);
  });

  it('reports whether pgvector was adopted, either way', async () => {
    // 0004 is conditional and must leave a working schema on both kinds of
    // cluster. This test passes with and without the extension — asserting only
    // that the two columns agree about what happened.
    const db = await freshSchema();
    await migrate(db);

    const { rows } = await db.query<{ has_extension: boolean; has_column: boolean }>(`
      SELECT
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_extension,
        EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'memory_embedding'
             AND column_name = 'embedding_v'
        ) AS has_column
    `);

    // The column exists if and only if the extension does. Anything else means
    // 0004's guard is broken in one direction or the other.
    expect(rows[0]?.has_column).toBe(rows[0]?.has_extension);
  });
});
