import assert from 'node:assert/strict'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const edits: Record<string, [string, string, string]> = {
  'button-disconnected': ['components/WorkspaceWorkbench.tsx', 'tabSwitchObservation.begin(switchTarget, mode, event.nativeEvent.timeStamp)', 'void event.nativeEvent.timeStamp'],
  'placement-disconnected': ['components/StableWorkbenchView.tsx', "if (!switchTarget || (kind === 'region') !== (projection?.entity.kind === 'region')) return", 'if (switchTarget) return'],
  'terminal-disconnected': ['components/TerminalView.tsx', '() => switchReaderRef.current?.() ?? null', '() => null'],
  'coarse-occurrence': ['lib/tab-switch-observation.ts', 'active.record.target.groupId === target.groupId', 'true'],
  'unbounded-records': ['lib/tab-switch-observation.ts', 'if (records.length === 16) records.shift()', '/* mutant: retain all clicks */'],
  'departed-callback': ['lib/tab-switch-observation.ts', 'if (epoch !== frameGeneration || !active || active.record.id !== generation || active.record.state !== \'pending\') return', "if (!active || active.record.id !== generation || active.record.state !== 'pending') return"]
}
export default defineConfig({ ...base, root, plugins: [{ name: 'production-tab-switch-mutations', enforce: 'pre', transform(code, id) {
  const mutant = process.env.AGENTMUX_TAB_SWITCH_MUTANT, edit = edits[mutant ?? '']
  if (edit && relative(root, id.split('?')[0]!) === 'apps/desktop/src/renderer/src/' + edit[0]) {
    const count = code.split(edit[1]).length - 1
    assert.equal(count, mutant === 'departed-callback' ? 2 : 1, 'Must consume exact production anchors')
    process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    return { code: code.replaceAll(edit[1], edit[2]), map: null }
  }
} }], test: { ...base.test, include: ['apps/desktop/test/tab-switch-*.test.*', 'apps/desktop/test/terminal-webgl-visibility.test.tsx',
  'apps/desktop/test/renderer-performance.test.tsx', 'packages/core/test/renderer-tab-switch-codec.test.ts',
  'packages/core/test/metrics-control-host.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
