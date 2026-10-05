import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../mote-daily-goal/vitest.config.mts'

// Actual Source owners, with the original Electron bridge and public CLI fixture.
// No published dist, native process or installed application is claimed here.
const repository = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original,
  resolve: { ...original.resolve, alias: [
    { find: /^@scure\/base$/, replacement: resolve(repository, 'node_modules/.pnpm/@scure+base@2.2.0/node_modules/@scure/base/index.js') },
    { find: /^@agentmux\/git$/, replacement: resolve(repository, 'packages/git/src/index.ts') },
    ...(original.resolve?.alias as Array<{ find: RegExp; replacement: string }> ?? [])
  ] },
  test: { ...original.test, env: { ...original.test?.env, NODE_PATH: resolve(repository, 'packages/core/node_modules') }, include: ['test/mote-daily-goal.test.tsx'], passWithNoTests: false,
    // Compilation and private fixture setup are separate from the product's RPC budget.
    hookTimeout: 30_000, testTimeout: 20_000 }
})
