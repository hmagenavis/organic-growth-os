import { defineConfig } from 'vitest/config';

// Unit tests only: no database, no container, fast.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'src/**/*.int.test.ts'],
  },
});
