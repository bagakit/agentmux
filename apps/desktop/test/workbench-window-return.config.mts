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
    const mutation = process.env.WINDOW_RETURN_MUTATION
    const replacement = mutation === 'remove-original-target'
      ? ['<WorkbenchWindowTargetsContext.Provider value={windowTargets}>', '<WorkbenchWindowTargetsContext.Provider value={EMPTY_WINDOW_TARGETS}>']
      : mutation === 'extract-region-from-detached-tab'
        ? ['const windowNoticeProjection = tabDetached ? regionTarget : undefined', 'const windowNoticeProjection: WorkbenchViewTarget | undefined = undefined']
        : null
    assert.ok(!mutation || replacement, 'Known mutation of the actual window-target owner')
    if (replacement) assert.equal(source.split(replacement[0]!).length, 2, 'One actual window-target decision')
    const code = replacement ? source.replace(replacement[0]!, replacement[1]!) : source
    if (process.env.WINDOW_RETURN_LOADED) appendFileSync(process.env.WINDOW_RETURN_LOADED,
      JSON.stringify({ file: owner, mutant: Boolean(replacement), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return { code, map: null }
  }
}], test: { ...owning.test, include: ['test/workbench-window-return.test.tsx'], passWithNoTests: false } })
