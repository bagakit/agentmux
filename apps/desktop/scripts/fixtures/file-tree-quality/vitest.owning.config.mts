import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
const product = 'apps/desktop/src/renderer/src/components/file-tree/useFileTreeViewport.ts'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...original, root,
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  plugins: [{ name: 'actual-loaded-file-tree-quality', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (!path.startsWith(resolve(root, 'apps/desktop/src') + '/')) return
    let code = source
    const mutation = process.env.AGENTMUX_FILE_TREE_MUTATION
    if (path === resolve(root, product) && mutation) {
      const rules: Record<string, readonly [string, string]> = {
        'unbounded-dom': ['return [...indexes].sort((left, right) => left - right)', 'return Array.from({ length: range.count }, (_, index) => index)'],
        'lost-interaction': ['for (const index of retainedIndexes) indexes.add(index)', 'void retainedIndexes'],
        'no-scroll': ["if (index !== null) virtualizer.scrollToIndex(index, { align: 'auto' })", 'void index']
      }
      assert.ok(mutation in rules, 'Unknown loaded file-tree mutation')
      const [anchor, replacement] = rules[mutation]!
      assert.equal(source.split(anchor).length - 1, 1, 'Actual loaded tree source anchor')
      code = source.replace(anchor, replacement)
    }
    if (process.env.AGENTMUX_FILE_TREE_LOADED_LOG) appendFileSync(process.env.AGENTMUX_FILE_TREE_LOADED_LOG,
      JSON.stringify({ path: relative(root, path), sourceSHA256: hash(source), loadedSHA256: hash(code), mutated: code !== source, mutation }) + '\n')
    if (code !== source) return { code, map: null }
  } }],
  test: { ...original.test, exclude: defaultExclude, include: [
    'apps/desktop/test/file-tree-quality.test.tsx',
    'apps/desktop/test/file-explorer-foundations.test.ts',
    'apps/desktop/test/file-explorer-open-as-project.integration.test.tsx',
    'apps/desktop/test/file-explorer-scratch-physical-path.test.tsx'
  ], fileParallelism: false, maxWorkers: 1, testTimeout: 15000, passWithNoTests: false }
})
