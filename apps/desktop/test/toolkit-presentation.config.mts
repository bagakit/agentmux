import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import base from './toolkit-tui-ui.config.mts'

const edits = {
  'double-preference-commit': ['apps/desktop/src/renderer/src/store.ts', 'if (workbenchSaveRequest === requestBeforeFlush) requestWorkbenchStorageCommit()', 'requestWorkbenchStorageCommit()'],
  'forget-presentation': ['apps/desktop/src/renderer/src/store.ts', 'toolkitPresentation: state.toolkitPresentation,', 'toolkitPresentation: {},'],
  'ignore-tool-palette': ['apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx', 'state.toolkitPresentation[definition.id]?.theme ?? ', ''],
  'forget-size': ['apps/desktop/src/renderer/src/components/performance/ToolkitPopoverResizeHandle.tsx', 'if (flush && gesture.changed) save()', 'if (false) save()'],
  'forget-default-shell-ui': ['apps/desktop/src/renderer/src/components/settings/ToolkitToolEditor.tsx', "...(!tui && !tool.script.trim() ? ['a main script'] : []),", "...(!tool.script.trim() ? ['a main script'] : []),"]
} as const
const mutation = process.env.AGENTMUX_TOOLKIT_PRESENTATION_MUTATION
assert.ok(!mutation || Object.hasOwn(edits, mutation), 'Known presentation mutation')
const edit = mutation ? edits[mutation as keyof typeof edits] : null
export default { ...base,
  plugins: [{ name: 'toolkit-presentation-consumers', enforce: 'pre' as const, transform(source: string, id: string) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (path.startsWith('../') || path.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/u.test(path)) return
    let loaded = source
    if (edit?.[0] === path) {
      assert.equal(source.split(edit[1]).length, 2, 'Unique actual owner mutation')
      loaded = source.replace(edit[1], edit[2])
    }
    const output = process.env.AGENTMUX_TOOLKIT_PRESENTATION_LOADED
    if (output) appendFileSync(output, JSON.stringify({ path, mutation: loaded === source ? null : mutation,
      disk: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), original: createHash('sha256').update(source).digest('hex'), consumed: createHash('sha256').update(loaded).digest('hex') }) + '\n')
    return { code: loaded, map: null }
  } }], test: { ...base.test, passWithNoTests: false, include: [
    'apps/desktop/test/toolkit-presentation-ui.test.tsx', 'apps/desktop/test/toolkit-presentation-persistence.test.ts',
    'apps/desktop/test/toolkit-tui-popover.test.tsx', 'apps/desktop/test/toolkit-tui-ui.test.tsx'
  ] }
}
