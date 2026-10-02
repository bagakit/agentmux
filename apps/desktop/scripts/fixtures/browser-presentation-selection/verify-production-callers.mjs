import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../../..')
const ts = createRequire(resolve(root, 'apps/desktop/package.json'))('typescript')
const inputs = new Map()
const parse = path => {
  const source = readFileSync(resolve(root, path), 'utf8')
  inputs.set(path, createHash('sha256').update(source).digest('hex'))
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)) }
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const selectorSource = parse('apps/desktop/src/renderer/src/lib/browser-presentation-selection.ts')
const exports = {}
new Function('exports', compile(selectorSource.text))(exports)
assert.equal(typeof exports.selectedBrowserPresentationId, 'function', 'Actual production helper exports its callable implementation')
const pane = parse('apps/desktop/src/renderer/src/components/BrowserPane.tsx')
let selectionConsumer, stageConsumer = 0, captureConsumer = 0
walk(pane, node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(pane) === 'selectedPresentationId') selectionConsumer = node.initializer.arguments[0]
  if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(pane) === 'BrowserPresentationStage') stageConsumer += 1
  if (ts.isCallExpression(node) && node.expression.getText(pane) === 'useBrowserPresentationCapture') captureConsumer += 1
})
assert.ok(selectionConsumer && stageConsumer > 0 && captureConsumer > 0, 'Definition-excluded Pane must actually call the selector, Stage and capture hook')
assert.ok(selectionConsumer.getText(pane).includes('selectedBrowserPresentationId(presentations, state)'), 'Pane must consume the unique selection implementation')
const consumeSelection = new Function('state', 'presentations', 'selectedBrowserPresentationId', `${compile(`const consumer = ${selectionConsumer.getText(pane)};`)}; return consumer(state)`)

const workbench = parse('apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx')
let productionOccurrences, focusConsumer
walk(workbench, node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(workbench) === 'focusForPresentation') focusConsumer = node.initializer
  if (!ts.isJsxSelfClosingElement(node) || node.tagName.getText(workbench) !== 'BrowserPane') return
  for (const attribute of node.attributes.properties) if (ts.isJsxAttribute(attribute) && attribute.name.getText(workbench) === 'presentations') productionOccurrences = attribute.initializer.expression
})
assert.ok(focusConsumer, 'Actual presentation focus call must be present')
assert.ok(productionOccurrences, 'Definition-excluded Workbench must instantiate BrowserPane with actual occurrences')
const hostModule = parse('apps/desktop/src/renderer/src/lib/workbench-presentation.ts')
let hostFunction
walk(hostModule, node => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'workbenchBrowserStageHostId') hostFunction = node })
assert.ok(hostFunction)
const host = {}; new Function('exports', compile(hostFunction.getText(hostModule)))(host)
const constructOccurrences = new Function('browserTargets', 'tabId', 'surface', 'focusForPresentation', 'workbenchBrowserStageHostId',
  `${compile(`const occurrences = ${productionOccurrences.getText(workbench)};`)}; return occurrences`)

const focusSource = parse('apps/desktop/src/renderer/src/lib/region-focus.ts')
const focusExports = {}
new Function('exports', compile(focusSource.text))(focusExports)
const createFocusConsumer = new Function('tab', 'node', 'regionCount', 'focus', 'regionFocusExpression',
  `${compile(`const consumer = ${focusConsumer.getText(workbench)};`)}; return consumer`)

const app = parse('apps/desktop/src/renderer/src/App.tsx')
const appCalls = []
walk(app, node => {
  if (ts.isCallExpression(node) && node.expression.getText(app) === 'executionFocusPresentation') appCalls.push(node)
})
assert.equal(appCalls.length, 1, 'Real App Focus projection consumer must be nonempty and unambiguous')
assert.equal(new Function('focusRegionOnly', `return (${appCalls[0].arguments[4].getText(app)})`)(false), 'tab', 'Real App defaults to whole-Tab projection')
let surveyTargets = 0, focusTargets = 0
walk(app, node => {
  if (!ts.isCallExpression(node) || node.expression.getText(app) !== 'append' || !ts.isObjectLiteralExpression(node.arguments[1])) return
  const properties = node.arguments[1].properties
  const field = properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(app) === 'surface')
  if (field?.initializer.getText(app) === "'focus'") focusTargets += 1
  if (field?.initializer.getText(app) === "'survey'") surveyTargets += 1
})
assert.ok(focusTargets > 0 && surveyTargets > 0, 'App must actually construct Focus and Survey targets, not merely import types')

const agent = { displayWorkspaceId: 'w', groupId: 'g', tabId: 't', regionId: 'agent' }
const outcomes = []
for (const [surface, mainSurface, entity, expected] of [
  ['focus', 'agents', { kind: 'tab', tabId: 't' }, true],
  ['survey', 'survey', { kind: 'tab', tabId: 't' }, true],
  ['survey', 'survey', { kind: 'zone', zoneId: 'z' }, true],
  ['focus', 'agents', { kind: 'region', regionId: 'agent' }, false],
  ['mote', 'agents', { kind: 'tab', tabId: 't' }, false]
]) {
  const target = { hostId: surface, surface, reference: agent, visible: true, active: true, projection: { entity } }
  const projectionFocus = createFocusConsumer({ id: 't', regions: { agent: {}, browser: {} } }, { regionId: 'browser' }, 2,
    focusExports.regionFocusExpression('agent', 'browser', 2), focusExports.regionFocusExpression)
  const occurrences = constructOccurrences([target], 't', { regionId: 'browser' }, projectionFocus, host.workbenchBrowserStageHostId)
  if (entity.kind !== 'region') assert.equal(occurrences.length, 1, 'Actual production occurrence must be nonempty')
  const state = { mainSurface, layouts: { w: { activeGroupId: 'g' } }, surveyZoneSelection: { active: agent } }
  const selected = consumeSelection(state, occurrences, exports.selectedBrowserPresentationId)
  assert.equal(selected !== null, expected, 'Real Workbench→Pane→selection call chain ' + surface + '/' + entity.kind)
  outcomes.push({ surface, scope: entity.kind, occurrences: occurrences.length, selected })
}

const stage = parse('apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx')
const passiveCalls = []
walk(stage, node => {
  if (ts.isCallExpression(node) && node.expression.getText(stage) === 'api.browser.activatePresentation' &&
    ts.isObjectLiteralExpression(node.arguments[1]) && node.arguments[1].getText(stage).includes("kind: 'select'")) passiveCalls.push(node)
})
assert.equal(passiveCalls.length, 1, 'One actual passive activation call site')
assert.ok(passiveCalls[0].arguments[1].getText(stage).includes("focus: 'preserve'"), 'Actual production API call preserves focus')
const callers = [
  { path: app.fileName, kind: 'real-constructed-targets', count: focusTargets + surveyTargets },
  { path: workbench.fileName, kind: 'actual-BrowserPane-occurrence-construction', count: 1 },
  { path: pane.fileName, kind: 'actual-selector-call', count: 1 },
  { path: pane.fileName, kind: 'actual-Stage-and-capture-hook-call', count: stageConsumer + captureConsumer },
  { path: stage.fileName, kind: 'public-passive-activation-call', count: passiveCalls.length }
]
assert.ok(callers.length > 0 && callers.every(caller => caller.count > 0), 'No empty-set caller success')
console.log(JSON.stringify({ schema: 'agentmux.browser-presentation-selection-callers.v1', passed: true, callers, outcomes,
  inputs: Object.fromEntries(inputs), limitations: ['Production expression execution and AST calls; Native visibility and focus require the separate private Native producer.'] }, null, 2))
