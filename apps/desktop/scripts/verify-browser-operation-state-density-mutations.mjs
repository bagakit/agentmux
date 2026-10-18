import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const component = 'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
const source = await readFile(new URL('../src/renderer/src/components/BrowserPane.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('BrowserPane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
assert.equal(tree.parseDiagnostics.length, 0)
const statuses = []
const visit = node => {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'BrowserOperatorPresence') statuses.push(node)
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(statuses.length, 1, 'Mutate the unique actual Browser presence consumer with all current props')
const status = statuses[0].getText(tree)
assert.ok(status.length > 0 && source.split(status).length === 2)

await verifyRendererSourceMutations({
  name: 'browser-operation-state-density-mutations',
  ...(process.env.AGENTMUX_DENSITY_EVIDENCE_ROOT ? { evidenceRoot: process.env.AGENTMUX_DENSITY_EVIDENCE_ROOT } : {}),
  owningConfig: process.env.AGENTMUX_DENSITY_CONFIG ?? 'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts',
  tests: ['apps/desktop/test/browser-operation-state-density.test.tsx'],
  sources: [component, pane, 'apps/desktop/src/renderer/src/styles/browser-operation-surface.css',
    'apps/desktop/scripts/lib/fixture-values.mjs', 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'state-glyphs-collapse', file: component,
      before: '<PhaseGlyph phase={phase} current={Boolean(controlled && !terminal)} />', after: '<PhaseGlyph phase="completed" />' },
    { label: 'historical-control-fallback', file: component, before: 'const control = currentControl',
      after: 'const control = currentControl ?? operation?.control ?? { owner: activity.control, activeOperationId: operation?.id ?? null }' },
    { label: 'current-operation-ignored', file: component, before: 'control.activeOperationId === operation.id', after: 'true' },
    { label: 'direct-take-disconnected', file: component,
      before: 'aria-label="Take control of Browser" title="Take control of Browser" onClick={() => onTakeControl()}',
      after: 'aria-label="Take control of Browser" title="Take control of Browser" onClick={() => {}}' },
    { label: 'direct-return-disconnected', file: component,
      before: 'aria-label="Return to Agent" title="Return to Agent" onClick={() => onReturnControl()}',
      after: 'aria-label="Return to Agent" title="Return to Agent" onClick={() => {}}' },
    { label: 'menu-take-disconnected', file: component, before: 'onSelect={() => onTakeControl()}', after: 'onSelect={() => {}}' },
    { label: 'stop-action-disconnected', file: component, before: 'onSelect={() => onStop()}', after: 'onSelect={() => {}}' },
    { label: 'return-terminal-gated', file: component, before: "const canReturnControl = control?.owner === 'human'", after: "const canReturnControl = canStop && control?.owner === 'human'" },
    { label: 'return-action-disconnected', file: component, before: 'onSelect={() => onReturnControl()}', after: 'onSelect={() => {}}' },
    { label: 'return-control-ignored', file: component, before: "const canReturnControl = control?.owner === 'human'", after: 'const canReturnControl = true' },
    { label: 'stop-terminal-ignored', file: component, before: 'const canStop = Boolean(operation && !terminal)', after: 'const canStop = true' },
    { label: 'pane-current-control-disconnected', file: pane, before: status, after: status.replace('control={tab.control}', 'control={undefined}') },
    { label: 'pane-take-stops-only', file: pane, before: status,
      after: status.replace('onTakeControl={() => void takeBrowserControl()}', 'onTakeControl={() => void stopBrowserOperation()}') },
    { label: 'separate-operation-toolbar', file: pane, before: status, after: `      </form>\n${status}\n      <form className="browser-operation-toolbar">` }
  ]
})
