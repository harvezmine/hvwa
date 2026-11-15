import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    // Specs' `import request from 'supertest'` gets one listening server per app (see the file).
    alias: [{ find: /^supertest$/, replacement: fileURLToPath(new URL('./tests/support/supertest.ts', import.meta.url)) }],
  },
  test: {
    include: ['**/*.spec.ts'],
    // Git worktrees nested in the repo (.worktrees/, .claude/worktrees/) hold full
    // copies of the specs; never collect those from the main checkout.
    exclude: [...configDefaults.exclude, '.worktrees/**', '.claude/**'],
    environment: 'node',
  },
});
