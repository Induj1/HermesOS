/**
 * The integration-test harness: a private schema per test file.
 *
 * Each file calls `withTestDatabase()`, which creates a `test_<random>` schema,
 * migrates into it, and drops it afterwards. That gives isolation without a
 * second database, a Docker daemon, or a provisioning step — the tests run
 * against whatever `DATABASE_URL` points at, which locally is the same Postgres
 * as development, and cannot touch its data because they never leave their
 * schema.
 *
 * Why a schema rather than a database: creating a database needs CREATEDB rights
 * and cannot happen inside a transaction, while `CREATE SCHEMA` is cheap and
 * needs only ownership of the current one. Why not Testcontainers: it would make
 * `pnpm test` require Docker, which the repo deliberately does not (see
 * docker-compose.yml — "the default stack is intentionally EMPTY").
 *
 * ## When DATABASE_URL is unset
 *
 * These tests skip, loudly, rather than fail. A contributor without a database
 * should still get a green run of the pure tests, and CI is where the
 * integration suite is guaranteed to run. `describeIntegration` is the switch,
 * and `INTEGRATION_SKIP_REASON` explains itself in the runner's output.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe } from 'vitest';
import { TestClock } from '@hermes/kernel';
import { PgDatabase, quoteIdentifier, type Database } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrator.js';

/**
 * Reading env directly is fine *here*, and only here.
 *
 * The service itself never does — configuration is injected, per the kernel's
 * rule (RFC-0001 §3). A test harness is the composition root for its own tests,
 * so this is that root doing its job, not the library reaching for ambient state.
 */
const DATABASE_URL = process.env['DATABASE_URL'];

export const INTEGRATION_ENABLED = DATABASE_URL !== undefined && DATABASE_URL !== '';

export const INTEGRATION_SKIP_REASON =
  'DATABASE_URL is not set; skipping integration tests. Run `just db-init` (or set DATABASE_URL) to enable them.';

/**
 * `describe` that skips the whole block when there is no database to talk to.
 *
 * A function with an explicit signature rather than
 * `const describeIntegration = enabled ? describe : describe.skip`. That form
 * infers a type built from Vitest's internal, un-importable suite types, and
 * `declaration: true` in tsconfig.base.json then fails to write a .d.ts for it
 * (TS4023). Naming the signature keeps the exported type ours.
 */
export function describeIntegration(name: string, fn: () => void): void {
  if (INTEGRATION_ENABLED) describe(name, fn);
  else describe.skip(name, fn);
}

export interface TestDatabase {
  readonly db: Database;
  readonly schema: string;
  /** Frozen at a round epoch so timestamp assertions are exact, not approximate. */
  readonly clock: TestClock;
}

/** A schema name that is unique per run and safe to interpolate. */
function uniqueSchema(): string {
  return `test_${randomBytes(6).toString('hex')}`;
}

/**
 * The connection string, or a loud failure.
 *
 * Only reachable from inside a `describeIntegration` block, which does not run
 * without DATABASE_URL — so the throw is unreachable in practice. It exists so
 * that the unreachable case is an error naming the missing variable, rather than
 * a pool quietly trying to connect to the string "undefined".
 */
function connectionString(): string {
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error(INTEGRATION_SKIP_REASON);
  }
  return DATABASE_URL;
}

/**
 * Wire up a migrated, isolated database for the current test file.
 *
 * Call at the top of a `describeIntegration` block. Returns a handle whose
 * fields are populated in `beforeAll` — read them inside tests, never at module
 * scope.
 */
export function withTestDatabase(): TestDatabase {
  const schema = uniqueSchema();
  // `db` is genuinely absent until beforeAll runs, and the internal type says so
  // — the cast to TestDatabase happens once, on the way out, where the contract
  // is "read these inside a test, by which point beforeAll has run". The object
  // identity is stable so tests can close over it while its contents arrive
  // asynchronously.
  const handle: { db?: Database; schema: string; clock: TestClock } = {
    schema,
    clock: new TestClock(1_700_000_000_000),
  };

  let admin: PgDatabase | undefined;

  beforeAll(async () => {
    // Two connections: one on the default search_path to create the schema, and
    // one pinned to it for the tests. The pinned pool cannot create its own
    // schema — its search_path names something that does not exist yet.
    admin = new PgDatabase({
      connectionString: connectionString(),
      applicationName: 'hermes-memory-test-admin',
      maxConnections: 1,
    });
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);

    const db = new PgDatabase({
      connectionString: connectionString(),
      schema,
      applicationName: 'hermes-memory-test',
      maxConnections: 4,
    });
    handle.db = db;

    await migrate(db);
  });

  afterAll(async () => {
    // Close the test pool before dropping: an open connection whose search_path
    // names the schema does not block the DROP, but leaving the pool open leaks
    // handles and makes vitest hang on exit — the classic "tests passed but the
    // process never exited".
    await handle.db?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.close();
    }
  });

  return handle as TestDatabase;
}

/** A fresh, unmigrated schema for tests that drive the migrator itself. */
export async function withEmptySchema(): Promise<{
  db: Database;
  schema: string;
  drop: () => Promise<void>;
}> {
  const schema = uniqueSchema();
  const admin = new PgDatabase({
    connectionString: connectionString(),
    applicationName: 'hermes-memory-test-admin',
    maxConnections: 1,
  });
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);

  const db = new PgDatabase({
    connectionString: connectionString(),
    schema,
    applicationName: 'hermes-memory-test',
    maxConnections: 2,
  });

  return {
    db,
    schema,
    drop: async () => {
      await db.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.close();
    },
  };
}

/** Wipe every table between tests, without paying to re-migrate. */
export async function truncateAll(db: Database): Promise<void> {
  // CASCADE follows the FKs; RESTART IDENTITY resets mission_event's identity
  // column, so a test asserting on event ordering is not affected by whatever
  // ran before it.
  await db.query(`
    TRUNCATE conversation, memory_record, memory_embedding,
             mission, mission_task, mission_event
    RESTART IDENTITY CASCADE
  `);
}
