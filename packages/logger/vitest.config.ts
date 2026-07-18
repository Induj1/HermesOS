import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Records over an injected clock and sink: no real time, no real stdout.
    // A test that needs more than 5s is deadlocked, not thorough.
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'html'],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
