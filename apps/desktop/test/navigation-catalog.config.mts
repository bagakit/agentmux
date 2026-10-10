import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root = source.root!
const snapshots: Record<string, string> = process.env.AGENTMUX_NAVIGATION_CATALOG_SOURCES
  ? JSON.parse(readFileSync(process.env.AGENTMUX_NAVIGATION_CATALOG_SOURCES, 'utf8')) : {}
const owner = 'apps/desktop/src/renderer/src/lib/workbench-navigation-catalog.ts'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...source, cacheDir: resolve(root, '.tmp/navigation-catalog-vitest-cache'),
  plugins: [{ name: 'actual-navigation-catalog-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let code = snapshots[path] ?? original, mutated = false
    if (process.env.AGENTMUX_NAVIGATION_CATALOG_MUTANT && path === owner) {
      const anchor = "index === 2 && sameNavigationLayouts(state.layouts, known.inputs[index] as Facts['layouts'])"
      assert.equal(code.split(anchor).length - 1, 1, 'Unique focus-only reuse boundary')
      code = code.replace(anchor, 'false'); mutated = true
    }
    if (process.env.AGENTMUX_NAVIGATION_CATALOG_LOADED &&
      (path.startsWith('apps/desktop/') || path.startsWith('packages/'))) {
      appendFileSync(process.env.AGENTMUX_NAVIGATION_CATALOG_LOADED, JSON.stringify({ path,
        originalSHA256: sha(original), effectiveSHA256: sha(code), emittedSHA256: sha(code), mutated,
        returnedReplacement: code !== original }) + '\n')
    }
    if (code !== original) return { code, map: null }
  } }], test: { ...source.test, maxWorkers: 1, fileParallelism: false, passWithNoTests: false,
    include: ['apps/desktop/test/workbench-navigation-scaling.test.tsx',
      'apps/desktop/test/focus-local-workbench-selection.test.tsx', 'apps/desktop/test/workbench-occurrence-selection.test.ts'],
    testTimeout: 30000 }
})
