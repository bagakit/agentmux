import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.ok(args[0] === '--source' && args.length === 1 || args[0] === '--scene' && args.length === 2, 'Use --source or --scene <receipt>')
const hash = value => createHash('sha256').update(value).digest('hex')
const consumers = ['apps/desktop/src/renderer/src/lib/workbench-presentation.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/App.tsx', ...['WorkspaceWorkbench', 'StableWorkbenchView', 'SessionPane', 'BrowserPane']
    .map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`)]
const presentationOwners = ['workbench-projection', 'workbench-tabs', 'workbench-session-subscriptions', 'desktop-presentation']
  .map(name => `apps/desktop/src/renderer/src/lib/${name}.ts`)
const productInputs = [...consumers, ...presentationOwners, 'apps/desktop/src/renderer/src/lib/api.ts',
  'packages/core/src/spatial-layout/workbench-view-layout.ts', 'packages/core/src/spatial-layout/split-tree.ts']
const tests = ['apps/desktop/test/workbench-primary-input.test.tsx', 'apps/desktop/test/focus-browser-toolbar-continuity.test.tsx',
  'apps/desktop/test/focus-region-close-continuity.test.tsx']
const config = 'apps/desktop/test/vitest.focus-split-close.config.mts'
const bindings = files => Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])).then(Object.fromEntries)

if (args[0] === '--scene') {
  const path = resolve(root, args[1]), directory = dirname(path)
  const scene = JSON.parse(await readFile(path, 'utf8'))
  const review = JSON.parse(await readFile(join(directory, 'visual-review.json'), 'utf8'))
  assert.equal(scene.capturedPass, true)
  assert.equal(scene.schema, 'agentmux.focus-split-close-scene.v1')
  assert.equal(scene.actual.passed, true)
  assert.deepEqual(scene.actual.continuityFailures, [])
  assert.ok(scene.actual.traces.length >= 4, 'Actual close consumers')
  for (const trace of scene.actual.traces) {
    assert.equal(trace.continuity.sameInstance, true, trace.label)
    assert.equal(trace.continuity.samePrimaryRole, true, trace.label)
    assert.deepEqual(trace.frameAnomalies, [], trace.label)
    assert.deepEqual(trace.mutationAnomalies, [], trace.label)
    assert.ok(trace.frames.length > 0, 'Actual painted frames ' + trace.label)
  }
  const browserRoles = new Set(scene.actual.traces.filter(trace => trace.control.className === 'browser-toolbar__close').map(trace => trace.control.parentRole))
  assert.ok(browserRoles.has('primary') && browserRoles.has('secondary'), 'Exact Browser toolbar closure in both actual host roles')
  assert.equal(scene.restart.passed, true)
  assert.ok(Number.isInteger(scene.process.originalPid) && Number.isInteger(scene.restartProcess.originalPid))
  assert.notEqual(scene.process.originalPid, scene.restartProcess.originalPid, 'Two actual private processes')
  for (const process of [scene.process, scene.restartProcess]) { assert.equal(process.exitConfirmed, true); assert.equal(process.exitCode, 0) }
  assert.equal(review.verdict, 'pass')
  assert.equal(review.sceneReceiptSHA256, hash(await readFile(path)))
  assert.ok(scene.frames.length >= 2, 'Nonempty before/after actual Chromium images')
  assert.equal(review.viewedImages.length, scene.frames.length)
  for (const frame of scene.frames) {
    assert.equal(hash(await readFile(join(directory, frame.file))), frame.sha256)
    assert.ok(review.viewedImages.some(image => image.path === frame.file && image.sha256 === frame.sha256 && image.viewed === true))
  }
  for (const file of productInputs) {
    assert.equal(scene.inputs[file], hash(await readFile(join(root, file))), 'Current actual consumer ' + file)
    assert.equal(scene.sourceAfter[file], scene.inputs[file], 'Stable captured consumer ' + file)
  }
  for (const file of scene.affectedInputs) {
    assert.equal(scene.inputs[file], hash(await readFile(join(root, file))), 'Current capture input ' + file)
    assert.equal(scene.sourceAfter[file], scene.inputs[file], 'Stable capture input ' + file)
  }
  assert.equal(scene.cleanup.removed, true)
  assert.deepEqual(scene.cleanup.remaining, [])
  console.log(JSON.stringify({ passed: true, scene: args[1], boundary: scene.boundary }))
  process.exit(0)
}

const evidence = join(root, '.local/state/focus-split-close/source')
await mkdir(evidence, { recursive: true })
const files = [...productInputs, ...tests, config, 'apps/desktop/test/vitest.mote-context.config.mts', 'vitest.config.ts',
  'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/startup-observation-api-fixture.ts',
  'apps/desktop/test/fixtures/mote-workface.ts', 'apps/desktop/scripts/lib/fixture-values.mjs', 'test/fixture-values.mjs',
  'apps/desktop/scripts/verify-focus-split-close.mjs']
const before = await bindings(files), receipt = { schema: 'agentmux.focus-split-close-source.v1', passed: false, sourceBefore: before, runs: [] }
try {
  const previous = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'))
  if (previous.passed && JSON.stringify(previous.sourceAfter) === JSON.stringify(before)) {
    console.log(JSON.stringify({ passed: true, reused: true, evidence }))
    process.exit(0)
  }
} catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }

for (const label of ['baseline', 'closed-caret', 'foreign-occurrence', 'restored']) {
  const mutant = label === 'closed-caret' || label === 'foreign-occurrence' ? label : null
  const output = join(evidence, label + '.json'), loadedPath = join(evidence, label + '-loaded.jsonl')
  await writeFile(loadedPath, '')
  let code = 0, log
  try {
    const result = await promisify(execFile)(process.execPath,
      [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile=' + output], {
        cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, AGENTMUX_FOCUS_CLOSE_LOADED: loadedPath, AGENTMUX_FOCUS_CLOSE_MUTANT: mutant ?? '' }
      })
    log = result.stdout + result.stderr
  } catch (error) { code = error.code; log = (error.stdout ?? '') + (error.stderr ?? '') }
  await writeFile(join(evidence, label + '.log'), log)
  const report = JSON.parse(await readFile(output, 'utf8'))
  const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(report.numTotalTests >= 19 && report.numPendingTests === 0, 'Nonempty executed tests')
  for (const file of tests) assert.ok(report.testResults.some(suite => suite.name === join(root, file) && suite.assertionResults.length > 0), 'Executed suite ' + file)
  for (const file of consumers) assert.ok(loaded.some(module => module.path === file && module.originalSHA256 === before[file]), 'Loaded actual consumer ' + file)
  const failures = report.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName))
  const assertions = report.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed' &&
    test.failureMessages.some(message => message.startsWith('AssertionError:'))).map(test => test.fullName))
  if (mutant) {
    assert.equal(code, 1); assert.ok(failures.length > 0, 'Nonempty RED, not load failure')
    assert.deepEqual(assertions, failures, 'Every mutant failure is an actual assertion, not an exception')
    assert.ok(loaded.some(module => module.path === consumers[0] && module.mutant === mutant && module.loadedSHA256 !== module.originalSHA256))
    if (mutant === 'closed-caret') assert.ok(assertions.some(name => name.startsWith('Browser toolbar closure')), 'Original bug rejected through actual App and Browser toolbar assertion')
  } else { assert.equal(code, 0, log); assert.equal(report.numFailedTests, 0); assert.equal(report.numPassedTests, report.numTotalTests) }
  receipt.runs.push({ label, tests: report.numTotalTests, passed: report.numPassedTests, failures })
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
receipt.sourceAfter = await bindings(files)
assert.deepEqual(receipt.sourceAfter, before, 'No shared production files mutated by the verifier')
receipt.passed = true
receipt.boundary = 'Actual source App/Workspace/Stable/SessionPane/BrowserPane and exact toolbar closure; PTY painting isolated, preview conversation reading unavailable. No Native Runtime recovery claim.'
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ passed: true, evidence, runs: receipt.runs, boundary: receipt.boundary }))
