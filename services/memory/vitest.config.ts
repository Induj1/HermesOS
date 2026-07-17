import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Read the repo-root .env into a plain object.
 *
 * The integration suite needs DATABASE_URL, which lives in the root .env — the
 * same file `just dev` and every app read. Vitest does not load it.
 *
 * Hand-rolled rather than reaching for dotenv, and rather than Vite's `loadEnv`,
 * which `vitest/config` does not re-export. Enough parser for the file this repo
 * actually has: `KEY=value`, `#` comments, optional quotes. It is not a shell,
 * and deliberately does not try to be — no interpolation, no `export`, no
 * multi-line values. If .env ever needs those, use a real parser rather than
 * growing this one.
 *
 * A missing .env is not an error: a contributor with DATABASE_URL exported in
 * their shell, or CI with it in the job environment, is a normal setup. The
 * integration tests skip with an explanation when it is absent either way.
 */
function readRootEnv(): Record<string, string> {
  const path = resolve(import.meta.dirname, '../../.env');

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return {};
  }

  const env: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    const value = (match[2] ?? '').trim();
    // Strip one layer of matching quotes, so DATABASE_URL="postgres://..." and
    // the bare form both work.
    env[match[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return env;
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The real environment wins over the file, so CI can point the suite at its
    // own database without editing anything.
    env: { ...readRootEnv(), ...process.env },
    // Integration tests create a schema, migrate it, and drop it. That is real
    // I/O against a real Postgres, so the kernel's 5s budget is too tight — but
    // a test that needs more than 30s is stuck on a lock, not being thorough.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every integration file owns a private schema, but they share one Postgres.
    // Serial execution keeps a failure diagnosable: the connection count stays
    // flat and `pg_stat_activity` shows one suspect, not eight.
    fileParallelism: false,
  },
});
