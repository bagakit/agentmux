import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import base from './toolkit-tui-ui.config.mts'

const edits = {
  'wrong-anchor': { file: 'apps/desktop/src/renderer/src/components/performance/PerformancePopover.tsx', before: "resizable ? 'top-end' : 'top-start'", after: "resizable ? 'top-start' : 'top-start'" },
  'wrong-direction': { file: 'apps/desktop/src/renderer/src/components/performance/ToolkitPopoverResizeHandle.tsx', before: 'resize(gesture.x - gesture.nextX, gesture.y - gesture.nextY)', after: 'resize(gesture.nextX - gesture.x, gesture.nextY - gesture.y)' },
  'leak-gesture': { file: 'apps/desktop/src/renderer/src/components/performance/ToolkitPopoverResizeHandle.tsx', before: "window.addEventListener('blur', cancel)", after: "window.addEventListener('focus', cancel)" },
  'hide-unknown': { file: 'apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx', before: "reading.error ? 'Observation unavailable'", after: "reading.error ? 'Running'" }
} as const
const mutation = process.env.AGENTMUX_TUI_POPOVER_MUTATION
assert.ok(!mutation || Object.hasOwn(edits, mutation), 'Known popover mutation')
const selected = mutation ? edits[mutation as keyof typeof edits] : undefined
export default { ...base,
  plugins: [{ name: 'toolkit-popover-loaded-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(base.root!, id.split('?')[0]!)
    if (!Object.values(edits).some(edit => edit.file === file)) return
    let loaded = source
    if (file === selected?.file) {
      assert.equal(source.split(selected.before).length, 2, 'One production mutation anchor')
      loaded = source.replace(selected.before, selected.after)
    }
    if (process.env.AGENTMUX_TUI_POPOVER_RECEIPT) appendFileSync(process.env.AGENTMUX_TUI_POPOVER_RECEIPT,
      JSON.stringify({ file, mutation: loaded === source ? null : mutation, sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex') }) + '\n')
    return { code: loaded, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/toolkit-tui-popover.test.tsx', 'apps/desktop/test/toolkit-tui-ui.test.tsx'] }
}
