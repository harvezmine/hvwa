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
    setupFiles: ['tests/support/setup.ts'],
    // Many specs drive full pages over HTTP hundreds of times (floods past bounded maps, order lists,
    // token sequences). Alone they take well under a second, but with several full suites sharing the
    // CPU (parallel worktrees) they can pass vitest's 5 s default. A real hang still fails, just later.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // globalThis.gc for the memory specs (tests/sim.spec.ts measure retention with a full GC).
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
  },
});
