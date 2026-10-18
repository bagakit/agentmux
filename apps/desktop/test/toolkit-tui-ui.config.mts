import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import base from '../scripts/fixtures/settings-overview/vitest.config.mts'

const edits = {
  'observation-refresh': {
    file: 'apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx',
    before: ' onObservationRefresh={observeTerminalRefresh}',
    after: ''
  },
  'check-lifetime': {
    file: 'apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx',
    before: 'if (lifetime !== checkLifetime.current) return',
    after: ''
  },
  'check-target': {
    file: 'apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx',
    before: ' && currentRun.current?.hostId === run.hostId && currentRun.current.runId === run.runId',
    after: ''
  },
  'metadata-order': {
    file: 'apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx',
    before: 'generation === refreshGeneration.current && currentRun.current?.hostId',
    after: 'currentRun.current?.hostId'
  },
  'current-mode': {
    file: 'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx',
    before: "execution ? execution.definition.mode ?? 'script' : reading.snapshot?.definition.mode ?? props.definition.mode",
    after: 'reading.snapshot?.definition.mode ?? props.definition.mode'
  },
  'consume-escape': {
    file: 'apps/desktop/src/renderer/src/components/performance/PerformancePopover.tsx',
    before: 'if (terminal && b.contains(terminal) && terminal.contains(document.activeElement)) return',
    after: 'if (false) return'
  },
  'stop-on-close': {
    file: 'apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx',
    before: 'return () => { ++refreshGeneration.current }',
    after: 'return () => { ++refreshGeneration.current; void api.toolkit.stop(definition.id, execution!.executionId) }'
  }
} as const
const mutation = process.env.AGENTMUX_TUI_UI_MUTATION
assert.ok(!mutation || Object.hasOwn(edits, mutation), 'Known TUI presentation mutation')
const selected = mutation ? edits[mutation as keyof typeof edits] : undefined

export default {
  ...base,
  resolve: { ...base.resolve, conditions: ['browser', 'module', 'development|production'] },
  esbuild: { jsx: 'automatic' as const },
  plugins: [{ name: 'toolkit-tui-loaded-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(base.root!, id.split('?')[0]!)
    if (!Object.values(edits).some(edit => edit.file === file)) return
    let loaded = source
    if (file === selected?.file) {
      assert.equal(source.split(selected.before).length, 2, 'One exact production mutation anchor')
      loaded = source.replace(selected.before, selected.after)
      process.stderr.write(`TUI_UI_MUTATION_APPLIED=${mutation}\n`)
    }
    const receipt = process.env.AGENTMUX_TUI_UI_RECEIPT
    if (receipt) appendFileSync(resolve(receipt), JSON.stringify({ file, mutation: loaded !== source ? mutation : null,
      sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex') }) + '\n')
    return { code: loaded, map: null }
  } }],
  test: { ...base.test, include: [
    'apps/desktop/test/toolkit-tui-ui.test.tsx',
    'apps/desktop/test/toolkit-custom-ui.test.tsx',
    'apps/desktop/test/toolkit-custom-drafts.test.tsx',
    'apps/desktop/test/toolkit-custom-navigation.test.tsx',
    'apps/desktop/test/toolkit-current-link.test.tsx',
    'apps/desktop/test/mobile-connection-toolkit.test.tsx'
  ] }
}
