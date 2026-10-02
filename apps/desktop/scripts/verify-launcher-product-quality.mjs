import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

// Local task evidence is intentionally not versioned. No missing artifact or
// empty collection can satisfy this gate; definitions alone prove no consumer.
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.tmp/launcher-product-quality')
const task = process.argv.find(arg => arg.startsWith('--task='))?.slice(7)
assert(['inputs', 'targets', 'interaction', 'integrated'].includes(task), 'Choose a planned task')
const read = path => readFileSync(resolve(root, path), 'utf8')
const json = path => JSON.parse(read(path))
const digest = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')
function tests(path, minimum) {
  const report = json(path)
  assert.equal(report.success, true, `${path}: suite/import errors are not a pass`)
  assert(report.numPassedTests >= minimum)
  assert.equal(report.numFailedTests, 0)
  assert.equal(report.numFailedTestSuites, 0)
  return report.numPassedTests
}
function mutations(path, minimum) {
  const receipt = json(path)
  assert.equal(receipt.allKilled, true)
  assert(receipt.mutants.length >= minimum)
  for (const mutant of receipt.mutants) {
    assert.equal(mutant.killed, true)
    assert(mutant.failedAssertions.length > 0)
    const report = json(mutant.report)
    assert(report.numFailedTests > 0)
    assert(report.testResults.some(file => file.assertionResults.some(item => item.status === 'failed')))
  }
  for (const binding of receipt.sourceBindings ?? []) assert.equal(digest(binding.path), binding.sha256, binding.path)
  return receipt.mutants.length
}
const sourceRoot = resolve(root, 'apps/desktop/src/renderer/src')
function parse(path) { return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) }
function nodes(source, predicate) {
  const result = []
  const visit = node => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit) }
  visit(source)
  return result
}
function caller(symbol, definition, relative) {
  const path = resolve(sourceRoot, relative), owning = resolve(sourceRoot, definition)
  assert.notEqual(path, owning)
  const bytes = readFileSync(path)
  const source = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const imports = nodes(source, node => ts.isImportDeclaration(node) && node.importClause?.namedBindings &&
    ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.some(item => item.name.text === symbol))
  assert(imports.some(item => {
    const module = item.moduleSpecifier.text
    return module.startsWith('.') && ['.ts', '.tsx'].some(extension => resolve(path, '..', module + extension) === owning)
  }), `${symbol} must come from its production owner`)
  const hits = nodes(source, node =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === symbol ||
    (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName) && node.tagName.text === symbol)
  assert(hits.length > 0, `No production call for ${symbol}`)
  return { symbol, definition, caller: relative, count: hits.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
const callers = [], result = { task, passed: true }
if (task === 'inputs') {
  result.tests = tests('.tmp/launcher-product-quality/inputs/test-result-r2.json', 60)
  tests('.tmp/launcher-product-quality/inputs/mutation-baseline-r2.json', 7)
  result.mutations = mutations('.tmp/launcher-product-quality/inputs/mutations.json', 7)
  for (const path of ['lib/launcher-inputs.ts', 'lib/launcher-option-draft.ts']) {
    assert.equal(digest(resolve(sourceRoot, path)), digest(resolve(evidence, 'inputs/source-evidence', path)), path)
  }
  // Bind the actual state-mutating request and setter, allowing unrelated Store
  // fields and presentation work to change independently of this slice.
  const live = parse(resolve(sourceRoot, 'store.ts'))
  const qualified = parse(resolve(evidence, 'inputs/source-evidence/store.ts'))
  for (const symbol of ['launchAgent', 'setLauncherOptionDraft']) {
    const find = source => nodes(source, node => (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) && node.name.getText(source) === symbol)
      .map(node => ts.isPropertyAssignment(node) ? node.initializer.getText(source) : node.getText(source))
    const current = find(live), original = find(qualified)
    assert.equal(current.length, 1, symbol); assert.deepEqual(current, original, `${symbol} changed after qualification`)
  }
  const persisted = source => {
    const owners = nodes(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'selectPersistedInputs')
    assert.equal(owners.length, 1)
    return nodes(owners[0], node => ts.isPropertyAssignment(node) && ['launcherNameDrafts', 'launcherOptionDrafts'].includes(node.name.getText(source)))
      .map(node => node.getText(source))
  }
  const fields = persisted(live)
  assert.equal(fields.length, 2); assert.deepEqual(fields, persisted(qualified), 'Durable input whitelist changed')
  const pipeline = source => nodes(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'partializeAppState').map(node => node.getText(source))
  const routes = source => nodes(source, node => ts.isPropertyAssignment(node) && node.name.getText(source) === 'partialize').map(node => node.initializer.getText(source))
  assert.deepEqual(pipeline(live), pipeline(qualified)); assert.equal(pipeline(live).length, 1)
  assert.deepEqual(routes(live), ['partializeAppState'])
  callers.push(caller('useLauncherInputs', 'lib/launcher-inputs.ts', 'components/NewTabSurface.tsx'),
    caller('updateLauncherOption', 'lib/launcher-option-draft.ts', 'store.ts'))
} else if (task === 'targets') {
  const receipt = json('.tmp/launcher-product-quality/targets/mutations.json')
  result.tests = tests(receipt.baseline.report, 70)
  result.mutations = mutations('.tmp/launcher-product-quality/targets/mutations.json', 7)
  for (const consumer of ['components/LauncherMoteAction.tsx', 'components/PmoTeamsTopicFloatingPanel.tsx', 'components/SpaceTopicsTree.tsx']) {
    callers.push(caller('MoteArchiveNotice', 'components/MoteArchiveNotice.tsx', consumer))
  }
  callers.push(caller('launcherResumeRows', 'lib/launcher-resume.ts', 'components/LauncherResumePicker.tsx'),
    caller('LauncherEnvironment', 'components/LauncherEnvironment.tsx', 'components/NewTabSurface.tsx'))
  const workbench = parse(resolve(sourceRoot, 'components/WorkspaceWorkbench.tsx'))
  const projections = nodes(workbench, node => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(workbench) === 'StableWorkbenchView')
  assert(projections.length >= 3)
  assert(projections.every(node => node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(workbench) === 'surface')))
} else if (task === 'interaction') {
  const receipt = json('.tmp/launcher-product-quality/utility/source-receipt.json')
  assert.equal(receipt.passed, true)
  assert(receipt.baseline.tests >= 9 && receipt.baseline.status === 0)
  assert(receipt.increment.baseline.tests >= 9 && receipt.increment.baseline.status === 0)
  const behavioral = [...receipt.mutations, ...receipt.increment.mutations]
  assert(behavioral.length >= 9)
  for (const mutant of behavioral) {
    assert.equal(mutant.red.status, 1)
    assert.equal(mutant.restored.status, 0)
    const log = resolve(evidence, 'utility', mutant.red.log)
    assert.equal(digest(log), mutant.red.sha256)
    assert.match(read(log), /AssertionError|expected .+ to /, 'Tool/compile errors cannot qualify a mutation')
  }
  for (const binding of receipt.sourceBindings) assert.equal(digest(binding.path), binding.sha256, binding.path)
  const native = json('.tmp/launcher-product-quality/utility/native-geometry-receipt.json')
  assert.equal(native.passed, true)
  assert(native.baseline.frames.length >= 2 && native.restored.frames.length >= 2)
  assert(native.mutations.length >= 2)
  for (const mutant of native.mutations) {
    assert.equal(mutant.red.status, 1)
    assert.equal(mutant.red.failure.name, 'AssertionError')
  }
  assert.equal(digest(resolve(sourceRoot, 'styles/launcher.css')), native.qualifiedSource.css)
  const positioning = source => nodes(source, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useLayoutEffect').map(node => node.getText(source))
  assert.deepEqual(positioning(parse(resolve(sourceRoot, 'components/LaunchOptionControls.tsx'))),
    positioning(parse(resolve(evidence, 'utility/qualified-positioning/LaunchOptionControls.tsx'))), 'Qualified positioning effect changed')
  result.tests = tests('.tmp/launcher-product-quality/utility/baseline-tests.json', 18)
  result.mutations = behavioral.length + native.mutations.length
  callers.push(caller('LaunchRefine', 'components/LaunchOptionControls.tsx', 'components/NewTabSurface.tsx'),
    caller('LauncherSecondarySurfaces', 'components/LauncherSecondarySurfaces.tsx', 'components/NewTabSurface.tsx'))
} else {
  const receipt = json('.tmp/launcher-product-quality/integrated-acceptance.json')
  assert.equal(receipt.passed, true)
  for (const binding of receipt.sourceBindings) assert.equal(digest(binding.path), binding.sha256, binding.path)
  const review = json(receipt.visualReview)
  assert.equal(review.verdict, 'pass'); assert.equal(review.sourceDigest, receipt.sourceDigest)
  assert(review.images.length > 0)
  for (const item of review.images) { assert.equal(item.verdict, 'pass'); assert.equal(digest(item.path), item.sha256) }
  assert.equal(receipt.restart.passed, true)
  assert.equal(receipt.restart.processIds.length, 2)
  assert.notEqual(...receipt.restart.processIds)
  assert.equal(receipt.restart.originalWorkfacePreserved, true)
  assert.equal(receipt.restart.unsentInputsPreserved, true)
  assert(receipt.commits.length >= 2)
  for (const commit of receipt.commits) assert.equal(commit.singleParent, true)
  assert.equal(receipt.concurrentWorkPreserved, true)
  assert.equal(receipt.cleanup.passed, true)
  result.images = review.images.length
}
result.callers = callers
writeFileSync(resolve(evidence, `gate-${task}.json`), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ task, passed: true, tests: result.tests, mutations: result.mutations, images: result.images, callers: callers.length }))
