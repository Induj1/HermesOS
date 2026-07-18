import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Sourcing over injected records and a temp file: no network. A test that
    // needs more than 5s is deadlocked, not thorough — the same budget every
    // other package sets, for the same reason.
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        // A re-export barrel with no logic. Covering it would mean a test that
        // imports the entry point to no purpose, which measures nothing.
        'src/index.ts',
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
