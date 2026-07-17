import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The planner is pure: no database, no network, no model. Its integration
    // tests drive a real kernel Runtime, which is itself fast by design. A test
    // that needs more than 5s is deadlocked, not thorough — the same budget the
    // kernel sets for the same reason.
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      // `src` only, and `all` so a module nobody imported still counts. Without
      // it, a file with no test at all is simply absent from the report rather
      // than shown at 0% — which is how `planner-service.ts` and `replanner.ts`
      // sat untested behind a green run.
      all: true,
      include: ['src/**/*.ts'],
      // A re-export barrel with no logic. Covering it would mean a test that
      // imports the entry point to no purpose, which measures nothing and would
      // dilute the thresholds below with a file that cannot harbour a bug.
      exclude: ['src/index.ts'],
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
