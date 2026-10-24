import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const helper = 'apps/desktop/src/renderer/src/lib/workbench-presentation.ts'
const consumers = [helper, 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/App.tsx',
  ...['WorkspaceWorkbench', 'StableWorkbenchView', 'SessionPane', 'BrowserPane'].map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`)]
export default defineConfig({ ...source,
  cacheDir: resolve(source.root!, '.tmp/focus-split-close-' + (process.env.AGENTMUX_FOCUS_CLOSE_MUTANT ?? 'baseline')),
  plugins: [{ name: 'focus-close-loaded-consumers', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!consumers.includes(path)) return
    let code = original
    const mutant = process.env.AGENTMUX_FOCUS_CLOSE_MUTANT
    if (path === helper && mutant) {
      const from = code.indexOf('  if (!marker?.startsWith(`${prefix}:`)) return false')
      const end = code.indexOf('\n}\n', from)
      assert.ok(from >= 0 && end > from, 'Loaded current production continuity predicate')
      const replacement = mutant === 'closed-caret' ? '  return Object.keys(tab.regions).some(regionId => marker === workbenchRegionProjectionSlotId(prefix, { ...reference, regionId }))'
        : mutant === 'foreign-occurrence' ? '  return true' : null
      assert.ok(replacement, 'Known semantic mutation')
      code = code.slice(0, from) + replacement + code.slice(end)
    }
    if (process.env.AGENTMUX_FOCUS_CLOSE_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_CLOSE_LOADED,
      JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutant: code === original ? null : mutant }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: ['apps/desktop/test/workbench-primary-input.test.tsx', 'apps/desktop/test/focus-browser-toolbar-continuity.test.tsx',
    'apps/desktop/test/focus-region-close-continuity.test.tsx'], setupFiles: [], globalSetup: [], passWithNoTests: false }
})
