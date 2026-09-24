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
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'BrowserOperationStatus') statuses.push(node)
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(statuses.length, 1, 'Mutate the unique actual Browser operation status with all current props')
const status = statuses[0].getText(tree)
assert.ok(status.length > 0 && source.split(status).length === 2)

await verifyRendererSourceMutations({
  name: 'browser-operation-state-density-mutations',
  tests: ['apps/desktop/test/browser-operation-state-density.test.tsx'],
  sources: [component, pane, 'apps/desktop/src/renderer/src/styles/browser-operation-surface.css'],
  mutations: [
    { label: 'state-glyphs-collapse', file: component, before: '<PhaseGlyph phase={phase} />', after: '<PhaseGlyph phase="completed" />' },
    { label: 'stop-action-disconnected', file: component, before: 'onSelect={() => onStop()}', after: 'onSelect={() => {}}' },
    { label: 'separate-operation-toolbar', file: pane, before: status, after: `      </form>\n${status}\n      <form className="browser-operation-toolbar">` }
  ]
})
