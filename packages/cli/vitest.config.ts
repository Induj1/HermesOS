import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Parsing and dispatch over injected IO: no real argv, no real stdout.
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
