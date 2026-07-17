import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The engine drives a real kernel Runtime, which is fast by design, and its
    // default checkpoint store is in-memory. A test that needs more than 5s is
    // deadlocked, not thorough — the same budget the kernel and the planner set,
    // for the same reason.
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
        // Type-only: a port interface and an event map. They emit no runtime
        // code, so v8 scores them 0% of nothing. Their contracts are covered by
        // the implementations and callers that have to satisfy them.
        'src/events.ts',
        'src/ports/checkpoint-store.ts',
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
