import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      // index.ts is a barrel; main.ts is the impure entrypoint (constructs real
      // HTTP clients, binds the Telegram long-poll loop, installs signal
      // handlers, reads the real environment) — exercised by running the bot,
      // not a unit test. The pure builders hold the testable logic.
      exclude: ['src/index.ts', 'src/main.ts'],
      reporter: ['text', 'html'],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
