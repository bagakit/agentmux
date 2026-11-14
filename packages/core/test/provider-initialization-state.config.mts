import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
const root = resolve(import.meta.dirname, '../../..')
const coreExports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports as Record<string, { import?: string }>
const coreAliases = Object.entries(coreExports).flatMap(([key, entry]) => entry.import?.startsWith('./dist/') ? [{
  find: new RegExp('^@agentmux/core' + (key === '.' ? '' : key.slice(1).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')) + '$'),
  replacement: resolve(root, 'packages/core', entry.import.replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
}] : [])
export default defineConfig({ root, resolve: { alias: [
  ...coreAliases,
  { find: /^@agentmux\/browser$/, replacement: resolve(root, 'packages/browser/src/index.ts') },
  { find: /^@agentmux\/browser\/(.+)$/, replacement: resolve(root, 'packages/browser/src/$1.ts') }
] }, cacheDir: resolve(root, '.local/provider-initialization-state/cache'), test: {
  include: ['packages/core/test/platform-initialization-input.test.ts',
    'packages/core/test/platform-initialization-diagnostic-lifetime.test.ts',
    'packages/core/test/providers/claude-input-initialization.test.ts'],
  setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1,
  fileParallelism: false, testTimeout: 20000, hookTimeout: 15000
} })
