import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The kernel is pure and fast; a hanging test means a real deadlock in the
    // scheduler, so fail early rather than sit on the default timeout.
    testTimeout: 5_000,
  },
});
