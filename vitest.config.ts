import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // @tool-server/linear is an MCP runtime tool server, not an npm package.
      // Map it to a stub so tests that don't explicitly vi.mock() it still compile.
      '@tool-server/linear': resolve(__dirname, 'src/__mocks__/tool-server-linear.ts'),
    },
  },
  test: {
    setupFiles: ['./vitest.setup.ts'],
    globals: true, // This makes describe, it, expect available globally without importing
  },
});
