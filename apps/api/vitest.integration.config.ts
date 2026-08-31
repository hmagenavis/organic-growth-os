import { defineConfig } from 'vitest/config';

// Integration tests: the API against a real PostgreSQL instance, exercising the same
// migration, role and Row Level Security path a deployment follows (docs/TESTING.md §2).
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
    globalSetup: ['src/testing/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
