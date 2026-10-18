import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@yunbox/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@yunbox/server': fileURLToPath(new URL('./packages/server/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Agent worktrees under .claude/ hold other checkouts of this repository.
    exclude: [...configDefaults.exclude, '.claude/**'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    sequence: {
      concurrent: false,
    },
  },
})
