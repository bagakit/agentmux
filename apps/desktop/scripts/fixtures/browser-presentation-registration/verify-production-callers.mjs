import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../../../../..')
const owner = 'apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx'
const facts = []
function source(path) {
  assert.notEqual(path, owner, 'Production callers exclude the definition')
  const text = readFileSync(resolve(root, path), 'utf8')
  const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  assert.equal(parsed.parseDiagnostics.length, 0, 'Production Source must parse')
  facts.push({ path, sha256: createHash('sha256').update(text).digest('hex') })
  return { text, parsed }
}
function nodes(parsed, predicate) {
  const found = []
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit) }
  visit(parsed)
  assert.ok(found.length > 0, 'A nonempty real consumer set is required')
  return found
}
function attributes(node, parsed) {
  return Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute)
    .map(attribute => [attribute.name.getText(parsed), attribute.initializer?.getText(parsed)]))
}
const pane = source('apps/desktop/src/renderer/src/components/BrowserPane.tsx')
const stages = nodes(pane.parsed, node => ts.isJsxOpeningElement(node) && node.tagName.getText(pane.parsed) === 'BrowserPresentationStage')
assert.equal(stages.length, 1, 'BrowserPane has one maintained Stage consumer')
const stage = attributes(stages[0], pane.parsed)
assert.equal(stage.browserId, '{tab.browserId}')
assert.equal(stage.navigationId, '{tab.navigationId}', 'Original Browser updates reach the retained Stage')
assert.equal(stage.presentation, '{presentation}')
assert.equal(stage.blocked, '{blocked}')
assert.equal(stage.media, '{media}')
const media = nodes(pane.parsed, node => ts.isCallExpression(node) && node.expression.getText(pane.parsed) === 'useBrowserPresentationCapture')
assert.equal(media.length, 1, 'One original Browser media owner is shared across presentations')
assert.equal(media[0].arguments[0].getText(pane.parsed), 'tab.browserId')
const workbench = source('apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx')
const panes = nodes(workbench.parsed, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(workbench.parsed) === 'BrowserPane')
assert.equal(panes.length, 1, 'The workbench reaches the original BrowserPane')
const consumer = attributes(panes[0], workbench.parsed)
assert.equal(consumer.tab, '{surface}')
assert.equal(consumer.key, '{surface.browserId}')
assert.ok(consumer.presentations?.includes('browserTargets.flatMap'), 'The actual occurrence projections reach BrowserPane')
assert.ok(consumer.presentations.includes('visible: target.visible !== false'), 'Real occurrence visibility reaches Stage geometry')
assert.ok(facts.length >= 2, 'No empty caller evidence')
const report = { passed: true, definition: owner, callerCount: stages.length + panes.length, facts,
  scope: 'Parsed definition-excluded production consumption; the owning test exercises the actual Stage and shared capture hook.' }
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
