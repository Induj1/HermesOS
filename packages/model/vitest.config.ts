import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // This package is pure contracts and small helpers: no network, no model,
    // no I/O. A test that needs more than 5s is deadlocked, not thorough — the
    // same budget every other package sets, for the same reason.

    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      // `src` only, and `all` so a module nobody imported still counts. Without
      // it, a file with no test at all is simply absent from the report rather
      // than shown at 0% — which is how `planner-service.ts` and `replanner.ts`
      // sat untested behind a green run.
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        // A re-export barrel with no logic. Covering it would mean a test that
        // imports the entry point to no purpose, which measures nothing and
        // would dilute the thresholds below with a file that cannot hold a bug.
        'src/index.ts',
        // Type-only: the model contracts themselves. They emit no runtime code,
        // so v8 scores them 0% of nothing. What they promise is enforced by the
        // providers that implement them and the consumers that call them.
        'src/contracts.ts',
      ],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
