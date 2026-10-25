import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.local/state/survey-tab-navigation/verification')
const config = 'apps/desktop/scripts/fixtures/survey-tab-navigation/vitest.config.mts'
const renderer = 'apps/desktop/src/renderer/src/'
const bearing = ['apps/desktop/src/main/workbench-windows.ts', renderer + 'App.tsx',
  renderer + 'lib/workbench-windows.tsx', renderer + 'lib/workbench-presentation.ts',
  renderer + 'components/WorkspaceWorkbench.tsx', renderer + 'components/StableWorkbenchView.tsx']
// workbench-presentation contains the typed payload; the remaining five have runtime consumers.
const runtime = bearing.filter(file => !file.endsWith('workbench-presentation.ts'))
const inputs = [...bearing, config, 'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts',
  'apps/desktop/scripts/fixtures/mote-navigation-footer/atomic-move.setup.ts', 'vitest.setup.ts',
  'apps/desktop/scripts/verify-survey-tab-navigation.mjs', 'apps/desktop/test/survey-surface.test.tsx', 'apps/desktop/test/workbench-windows.test.ts']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(root, file)))])))
const mutations = [
  { label: 'prepare-original-occurrence', file: renderer + 'App.tsx',
    before: 'for (const window of workbenchWindows) {', after: 'for (const window of [] as typeof workbenchWindows) {' },
  { label: 'register-original-physical-host', file: renderer + 'components/StableWorkbenchView.tsx',
    before: 'frozenTarget.current ?? windowTarget ?? (reference', after: 'frozenTarget.current ?? (reference' },
  { label: 'publish-target-before-prepare', file: 'apps/desktop/src/main/workbench-windows.ts',
    before: '// The original Renderer prepares this exact host without navigating to it.\n    this.changed()',
    after: '// The original Renderer prepares this exact host without navigating to it.\n    void 0' }
]
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.survey-tab-navigation.v1', passed: false, source: await hashes(),
  sharedSourceMutations: 0, runtimeControl: [], baseline: null, mutations: [],
  boundary: 'Actual App/Store/Workbench and Main window owner in isolated test transports; original native webpage click, Guest, input and visual proof are bound separately.' }
async function qualify(proof, mutant) {
  const tests = JSON.parse(await readFile(join(evidence, proof.report), 'utf8'))
  assert.equal(proof.passed, tests.numPassedTests); assert.equal(proof.failed, tests.numFailedTests)
  const graph = (await readFile(join(evidence, proof.loaded), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(graph.length > 0, 'Nonempty actual loaded consumer graph')
  for (const file of runtime) {
    const expected = mutant?.file === file ? digest((await readFile(join(root, file), 'utf8')).replace(mutant.before, mutant.after)) : receipt.source[file]
    assert.ok(graph.some(row => row.file === file && row.sha256 === expected), 'Actual source loaded: ' + file)
    assert.ok(graph.filter(row => row.file === file).every(row => row.sha256 === expected))
  }
  assert.ok((await readFile(join(evidence, proof.log), 'utf8')).trim())
  assert.equal(proof.signal, null)
  if (mutant) {
    assert.ok(proof.exit > 0 && proof.failed > 0, proof.log)
    assert.ok(tests.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError')))))
  } else { assert.equal(proof.exit, 0, proof.log); assert.equal(proof.failed, 0); assert.ok(proof.passed >= 6) }
}
async function run(label, mutant) {
  const loaded = join(evidence, label + '.loaded.ndjson'), report = join(evidence, label + '.json')
  await writeFile(loaded, '')
  // A crashed or failed collection cannot borrow a previous assertion report.
  await rm(report, { force: true })
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
      '--reporter=default', '--reporter=json', '--outputFile=' + report], { cwd: root,
      env: { ...process.env, SURVEY_NAV_LOADED: loaded, SURVEY_NAV_MUTANT: mutant ? JSON.stringify(mutant) : '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (exit, signal) => yes({ exit, signal, output }))
  })
  await writeFile(join(evidence, label + '.log'), result.output)
  const tests = JSON.parse(await readFile(report, 'utf8'))
  const proof = { exit: result.exit, signal: result.signal, passed: tests.numPassedTests, failed: tests.numFailedTests,
    log: label + '.log', report: label + '.json', loaded: label + '.loaded.ndjson' }
  await qualify(proof, mutant)
  return proof
}
try {
  if (process.env.SURVEY_NAV_COMPONENT_RECEIPT) {
    const previous = JSON.parse(await readFile(resolve(process.env.SURVEY_NAV_COMPONENT_RECEIPT), 'utf8'))
    assert.equal(previous.schema, receipt.schema); assert.equal(previous.componentPassed, true)
    assert.equal(previous.sharedSourceMutations, 0); assert.deepEqual(previous.runtimeControl, [])
    assert.deepEqual(previous.source, receipt.source); assert.deepEqual(previous.sourceAfter, receipt.source)
    assert.deepEqual(previous.mutations.map(({ label, file, before, after }) => ({ label, file, before, after })), mutations)
    await qualify(previous.baseline)
    for (const item of previous.mutations) { await qualify(item.red, item); await qualify(item.restore) }
    receipt.baseline = previous.baseline; receipt.mutations = previous.mutations
    receipt.componentEvidenceReused = resolve(process.env.SURVEY_NAV_COMPONENT_RECEIPT)
  } else {
  receipt.baseline = await run('baseline-green')
  for (const mutant of mutations) {
    const red = await run(mutant.label + '-red', mutant)
    const restore = await run(mutant.label + '-restore-green')
    receipt.mutations.push({ ...mutant, red, restore })
    console.log('PASS ' + mutant.label + ': loaded Assertion RED / restore GREEN')
  }
  }
  receipt.sourceAfter = await hashes(); assert.deepEqual(receipt.sourceAfter, receipt.source)
  receipt.componentPassed = true
  await writeFile(join(evidence, 'component-receipt.json'), JSON.stringify(receipt, null, 2))
  if (process.argv.includes('--component-only')) {
    console.log(JSON.stringify({ componentPassed: true, receipt: join(evidence, 'component-receipt.json') }))
  } else {
  const nativePath = resolve(process.env.SURVEY_NAV_NATIVE_RECEIPT ?? join(root, '.local/state/survey-tab-navigation/electron/final/receipt.json'))
  const bytes = await readFile(nativePath), native = JSON.parse(bytes)
  assert.equal(native.schema, 'agentmux.unified-browser-children-ui.v1'); assert.equal(native.scenario, 'survey-alias'); assert.equal(native.passed, true)
  assert.deepEqual(native.sourceAfter, native.sourceBefore)
  assert.ok(Object.keys(native.renderer.inputs).length > 0)
  assert.deepEqual(native.rendererInputsAfter, native.renderer.inputs)
  for (const [file, hash] of Object.entries(native.renderer.inputs)) assert.equal(digest(await readFile(join(root, file))), hash, 'Frozen native dependency: ' + file)
  for (const file of bearing) assert.equal(native.sourceBefore[file], receipt.source[file], 'Exact native candidate: ' + file)
  assert.ok(native.phases.length > 0 && native.phases.every(phase => phase.exit.exitCode === 0 && phase.exit.timedOut === false && phase.native.passed === true))
  assert.equal(native.cleanup.remaining.length, 0)
  const reviewPath = join(dirname(nativePath), 'review.json'), review = JSON.parse(await readFile(reviewPath, 'utf8'))
  assert.equal(review.status, 'approved'); assert.equal(review.receiptSHA256, digest(bytes))
  for (const file of bearing) assert.equal(review.reviewedSourceHashes[file], receipt.source[file])
  for (const [file, hash] of Object.entries(native.sourceBefore)) assert.equal(digest(await readFile(join(root, file))), hash, 'Current native consumer: ' + file)
  assert.ok(native.images.length > 0)
  for (const image of native.images) {
    assert.equal(digest(await readFile(join(dirname(nativePath), image.filename))), image.sha256)
    assert.ok(review.actuallyViewed.some(viewed => viewed.file === image.filename && viewed.sha256 === image.sha256))
  }
  receipt.native = { path: nativePath, sha256: digest(bytes), review: reviewPath }
  receipt.passed = true
  }
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
assert.equal(process.argv.includes('--component-only') ? receipt.componentPassed : receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: receipt.passed, componentPassed: receipt.componentPassed, receipt: join(evidence, 'receipt.json') }))
