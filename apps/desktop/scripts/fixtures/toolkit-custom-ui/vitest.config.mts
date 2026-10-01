import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../toolkit-preferences/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = resolve(process.env.AGENTMUX_TOOLKIT_UI_EVIDENCE ?? resolve(root, ".bagakit/design/toolkit-custom-fixture/ui/direct"))
const mutant = process.env.AGENTMUX_TOOLKIT_UI_MUTANT ?? 'baseline'
const costProof = process.env.AGENTMUX_TOOLKIT_UI_COST_PROOF === '1'
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const changes: Record<string, [string, string, string]> = {
  consumption: ['apps/desktop/src/renderer/src/components/toolkit/use-toolkit-script-observation.ts', 'if (!active) { setPending(false); return }', 'if (true) { setPending(false); return }'],
  release: ['apps/desktop/src/renderer/src/components/toolkit/use-toolkit-script-observation.ts', 'return () => { ++epoch.current; lease?.dispose() }', 'return () => { ++epoch.current }'],
  expectation: ['apps/desktop/src/renderer/src/components/settings/use-toolkit-drafts.ts', "Object.assign(expected, { [key]: key === 'actions' ? captured.expected.actions ?? [] : captured.expected[key] })", 'Object.assign(expected, { [key]: submitted[key] })'],
  target: ['apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx', 'await api.toolkit.run(definition.id,', "await api.toolkit.run('__wrong_tool__',"],
  'action-target': ['apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx', 'await api.toolkit.action(definition.id, action.id,', "await api.toolkit.action('__wrong_tool__', action.id,"],
  'action-source': ['apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx', 'expectedRevision: source.definition.revision, sourceExecutionId: source.executionId', 'expectedRevision: definition.revision, sourceExecutionId: source.executionId'],
  'action-script': ['apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx', 'const capturedScript = execution?.action ? capturedAction?.script : capturedDefinition?.script', 'const capturedScript = capturedDefinition?.script'],
  'pending-baseline': ['apps/desktop/src/renderer/src/components/settings/use-toolkit-drafts.ts', 'value, expected: baseline, missing: false', 'value, expected: accepted, missing: false'],
  'navigation-intent': ['apps/desktop/src/renderer/src/App.tsx', 'navigationRequest={settingsRoute}', 'navigationRequest={undefined}'],
  'passive-escape': ['apps/desktop/src/renderer/src/components/performance/PerformancePopover.tsx', "if (origin.current === 'hover' && !b.contains(document.activeElement)) { markWindowOverlayDismissal(event); close(); return }", "if (origin.current === 'hover' && !b.contains(document.activeElement) && event.target instanceof HTMLElement && event.target.closest('.xterm')) { markWindowOverlayDismissal(event); close(); return }"],
  'dismissal-marker': ['apps/desktop/src/renderer/src/components/performance/PerformancePopover.tsx', 'markWindowOverlayDismissal(event); close(); return', 'close(); return'],
  focus: ['apps/desktop/src/renderer/src/components/performance/PerformancePopover.tsx', "if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.performance-popover')) return", 'if (false) return']
}
assert.ok(mutant === 'baseline' || changes[mutant], 'Explicit nonempty loaded UI mutation')
mkdirSync(evidence, { recursive: true })
export default defineConfig({ ...original, root, cacheDir: resolve(evidence, 'cache'),
  plugins: [{ name: 'actual-toolkit-ui-source', enforce: 'pre', transform(input, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    if (!/\.[cm]?[jt]sx?$/u.test(path)) return
    const originalBytes = readFileSync(file)
    let code = input
    if (costProof) {
      const markers: Record<string,[string,string]> = {
        'apps/desktop/src/renderer/src/components/toolkit/ToolkitStatusBar.tsx':['function ToolkitStatusBar() {','ToolkitStatusBar'],
        'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx':['export function UserToolkitResult({ definition, active, close }: { definition: ToolkitToolDefinition; active: boolean; close(): void }) {','UserToolkitResult']
      }
      const marker=markers[path]
      if(marker) { assert.equal(input.split(marker[0]).length-1,1,'Nonempty actual UI cost observation anchor');code=code.replace(marker[0],marker[0]+`;(globalThis as any).__ToolkitCostProof?.push('${marker[1]}')`) }
    }
    const change = changes[mutant]
    if (change?.[0] === path) {
      assert.equal(input.split(change[1]).length - 1, 1, 'Unique actually loaded owning anchor: ' + path)
      code = input.replace(change[1], change[2])
    }
    const target = resolve(evidence, 'source', path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, originalBytes)
    appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(originalBytes), inputSHA256: sha(input), consumedSHA256: sha(code), mutant, bytes: Buffer.byteLength(code) }) + '\n')
    if (code !== input) { const consumed = resolve(evidence, 'consumed', path); mkdirSync(dirname(consumed), { recursive: true }); writeFileSync(consumed, code); return { code, map: null } }
  } }],
  test: { ...original.test, include: costProof ? ['apps/desktop/test/toolkit-custom-cost.test.tsx'] : ['apps/desktop/test/toolkit-custom-drafts.test.tsx', 'apps/desktop/test/toolkit-custom-ui.test.tsx', 'apps/desktop/test/toolkit-custom-navigation.test.tsx', 'apps/desktop/test/toolkit-preferences-draft.test.tsx'], passWithNoTests: false }
})
