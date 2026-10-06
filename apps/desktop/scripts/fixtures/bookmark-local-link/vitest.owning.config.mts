import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
const repository = resolve(import.meta.dirname, '../../../../..')
export const sourceAliases = ['core', 'demand', 'layout'].flatMap(name => {
  const directory = resolve(repository, 'packages', name)
  const exports = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).exports
  return Object.entries(exports).map(([key, value]) => {
    const target = typeof value === 'string' ? value : (value as { import: string }).import
    return { find: `@agentmux/${name}${key === '.' ? '' : key.slice(1)}`,
      replacement: resolve(directory, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts')) }
  })
}).sort((left, right) => right.find.length - left.find.length)

export default defineConfig({
 root: repository, resolve: { alias: sourceAliases }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
 test: { include: ['apps/desktop/test/bookmark*.test.ts', 'apps/desktop/test/browser-toolbar.test.tsx', 'apps/desktop/test/workbench-persistence.test.ts'],
 setupFiles: [resolve(repository, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 },
 cacheDir: resolve(repository, '.tmp/bookmark-maintenance/cache')
})
