import { defineConfig } from 'vitest/config';

// Integration tests: run against a real PostgreSQL instance started by global setup.
// Never mocked and never substituted with another engine — RLS behaviour is the
// subject under test (docs/TESTING.md §2).
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
    globalSetup: ['src/testing/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 240_000,
    // One container is shared; files run sequentially so databases are not created
    // concurrently on the same server.
    fileParallelism: false,
  },
});
