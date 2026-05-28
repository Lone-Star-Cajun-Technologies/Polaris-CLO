import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    globals: true, // This makes describe, it, expect available globally without importing
  },
});
