import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['**/*.spec.ts'],
    // Git worktrees nested in the repo (.worktrees/, .claude/worktrees/) hold full
    // copies of the specs; never collect those from the main checkout.
    exclude: [...configDefaults.exclude, '.worktrees/**', '.claude/**'],
    environment: 'node',
  },
});
