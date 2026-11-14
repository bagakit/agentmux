import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './workbench-window-presentations.config.mts'
const owner = resolve(import.meta.dirname, '../src/renderer/src/components/WorkspaceWorkbench.tsx')
export default defineConfig({ ...owning, plugins: [...(owning.plugins ?? []), {
  name: 'workbench-window-return-evidence', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== owner) return
    const before = '<WorkbenchWindowTargetsContext.Provider value={windowTargets}>'
    const mutate = process.env.WINDOW_RETURN_MUTATION === 'remove-original-target'
    assert.equal(source.split(before).length, 2, 'One actual window-target admission owner')
    const code = mutate ? source.replace(before, '<WorkbenchWindowTargetsContext.Provider value={EMPTY_WINDOW_TARGETS}>') : source
    if (process.env.WINDOW_RETURN_LOADED) appendFileSync(process.env.WINDOW_RETURN_LOADED,
      JSON.stringify({ file: owner, mutant: mutate, sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return { code, map: null }
  }
}], test: { ...owning.test, include: ['test/workbench-window-return.test.tsx'], passWithNoTests: false } })
