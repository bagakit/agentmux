import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.local/state/survey-item-tabs-actions/survey-list-ui')
const config = 'apps/desktop/scripts/fixtures/survey-list-ui/vitest.config.mts'
const components = 'apps/desktop/src/renderer/src/components/'
const bearing = [components + 'SurveyItemList.tsx', components + 'GlobalSurveySurface.tsx', components + 'SurveyItemOptions.tsx', components + 'SurveyZoneItem.tsx',
  'apps/desktop/src/renderer/src/hooks/useSurveyListOrganization.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/survey-list.ts']
const inputs = [...bearing, 'apps/desktop/src/renderer/src/styles/survey.css', 'apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts', 'apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'packages/core/src/spatial-state.ts',
  'apps/desktop/test/survey-list-ui.test.tsx', 'apps/desktop/test/helpers/survey-list-ui-fixture.ts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'apps/desktop/test/helpers/workface-control-fixture.ts', 'apps/desktop/test/helpers/spatial-control-owner-fixture.ts', config, 'apps/desktop/scripts/verify-survey-list-ui.mjs']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(root, file)))])))
const mutations = [
  { label: 'actual-item-menu-group-target', file: components + 'SurveyItemOptions.tsx', before: 'grouping.onMove(group.groupId)', after: 'grouping.onMove(null)' },
  { label: 'actual-group-collapse', file: components + 'SurveyItemList.tsx', before: 'collapsed: !original.collapsed', after: 'collapsed: original.collapsed' },
  { label: 'drag-pickup-expected', file: components + 'SurveyItemList.tsx',
    before: 'const baseline = held.current; held.current = null; setDragging(false)',
    after: 'const baseline = held.current && { ...held.current, expected: model.stored }; held.current = null; setDragging(false)' }
]
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.survey-list-ui.v1', passed: false, sourceRoot: root, source: await hashes(), baseline: null, mutations: [], restart: [],
  sharedSourceMutations: 0, boundary: 'Actual App/Store/Workbench and dnd-kit keyboard sensor; native terminal/editor paint and transport snapshots are fixtures. Separate test processes read the same actual Core spatial file and client bytes. No user Runtime control or live Provider semantic-resume claim. Actual native/CDP interactions and independent visual approval are separately bound below.' }
const withoutGraph = ({ graph, ...result }) => result
async function run(label, mutant, extra = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'amux-survey-list-ui-'))
  try {
    const loaded = join(evidence, label + '.loaded.ndjson'), outputFile = join(evidence, label + '.json')
    await writeFile(loaded, '')
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
        ...(extra.SURVEY_LIST_UI_RESTART_PHASE ? ['-t', '\\[survey-list-ui-restart\\]'] : []),
        '--reporter=default', '--reporter=json', '--outputFile=' + outputFile], {
        cwd: root, env: { ...process.env, ...extra, TMPDIR: temporary, SURVEY_LIST_UI_LOADED: loaded,
          SURVEY_LIST_UI_MUTANT: mutant ? JSON.stringify(mutant) : '' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.on('error', no); child.on('close', (exit, signal) => yes({ exit, signal, output }))
    })
    const log = label + '.log'; await writeFile(join(evidence, log), result.output)
    const report = JSON.parse(await readFile(outputFile, 'utf8'))
    const graph = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(graph.length > 0, 'Actual source graph must be nonempty')
    return { exit: result.exit, signal: result.signal, passed: report.numPassedTests, failed: report.numFailedTests,
      assertionRed: report.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError')))), log, loaded: label + '.loaded.ndjson', graph }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
function green(result, minimum = 1) {
  assert.equal(result.exit, 0, result.log); assert.equal(result.signal, null); assert.equal(result.failed, 0); assert.ok(result.passed >= minimum)
}
let restartDirectory
try {
  if (process.env.AGENTMUX_SURVEY_LIST_UI_COMPONENT_RECEIPT) {
    const path = resolve(process.env.AGENTMUX_SURVEY_LIST_UI_COMPONENT_RECEIPT), bytes = await readFile(path), qualified = JSON.parse(bytes)
    assert.equal(qualified.schema, receipt.schema); assert.equal(qualified.componentProofPassed, true)
    assert.equal(qualified.sharedSourceMutations, 0); assert.equal(qualified.cleanup?.testOwnedDirectoryRemoved, true)
    assert.deepEqual(qualified.source, receipt.source); assert.deepEqual(qualified.sourceAfter, receipt.source)
    assert.deepEqual(qualified.mutations.map(({ label, file, before, after }) => ({ label, file, before, after })), mutations)
    async function phase(result, minimum, mutant) {
      const directory = dirname(path)
      assert.ok((await readFile(join(directory, result.log), 'utf8')).trim())
      const report = JSON.parse(await readFile(join(directory, result.log.replace(/\.log$/, '.json')), 'utf8'))
      assert.equal(report.numPassedTests, result.passed); assert.equal(report.numFailedTests, result.failed)
      assert.equal(result.signal, null)
      const graph = (await readFile(join(directory, result.loaded), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      for (const file of bearing) {
        const expected = mutant?.file === file ? digest((await readFile(join(root, file), 'utf8')).replace(mutant.before, mutant.after)) : receipt.source[file]
        assert.ok(graph.some(row => row.file === file && row.sha256 === expected), 'Qualified actual consumer: ' + file)
        assert.ok(graph.filter(row => row.file === file).every(row => row.sha256 === expected))
      }
      if (mutant) {
        assert.ok(result.exit > 0 && result.failed > 0); assert.equal(result.assertionRed, true)
        assert.ok(report.testResults.some(file => file.assertionResults.some(item => item.status === 'failed' && item.failureMessages.some(message => message.includes('AssertionError')))))
      } else green(result, minimum)
    }
    await phase(qualified.baseline, 10)
    for (const mutant of qualified.mutations) { await phase(mutant.red, 0, mutant); await phase(mutant.restore, 10) }
    assert.deepEqual(qualified.restart.map(result => result.phase), ['write', 'read'])
    for (const result of qualified.restart) { await phase(result, 1); assert.equal(result.passed, 1) }
    assert.notEqual(qualified.restored.pid, qualified.restored.writerPid); assert.ok(qualified.restored.originalSessionIds.length > 0)
    Object.assign(receipt, { baseline: qualified.baseline, mutations: qualified.mutations, restart: qualified.restart,
      restored: qualified.restored, sourceAfter: qualified.sourceAfter, componentProofPassed: true,
      componentEvidence: { path, sha256: digest(bytes) } })
  } else {
  const baseline = await run('baseline-green'); green(baseline, 10); receipt.baseline = withoutGraph(baseline)
  for (const file of bearing) assert.ok(baseline.graph.some(row => row.file === file && row.sha256 === receipt.source[file]), 'Actual product consumer loaded: ' + file)
  restartDirectory = await mkdtemp(join(tmpdir(), 'amux-survey-list-ui-restart-'))
  const savedFile = join(restartDirectory, 'workbench.json')
  for (const phase of ['write', 'read']) {
    const result = await run('restart-' + phase, null, { SURVEY_LIST_UI_RESTART_PHASE: phase, SURVEY_LIST_UI_RESTART_FILE: savedFile })
    green(result); assert.equal(result.passed, 1); receipt.restart.push({ phase, ...withoutGraph(result) })
  }
  const saved = JSON.parse(await readFile(savedFile, 'utf8')), restored = JSON.parse(await readFile(savedFile + '.read-proof.json', 'utf8'))
  assert.notEqual(saved.pid, restored.pid); assert.equal(restored.writerPid, saved.pid)
  receipt.restored = restored
  for (const mutant of mutations) {
    const original = await readFile(join(root, mutant.file), 'utf8')
    assert.equal(original.split(mutant.before).length, 2)
    const red = await run(mutant.label + '-red', mutant)
    assert.notEqual(red.exit, 0); assert.equal(red.signal, null); assert.ok(red.failed > 0); assert.equal(red.assertionRed, true)
    assert.ok(red.graph.some(row => row.file === mutant.file && row.sha256 === digest(original.replace(mutant.before, mutant.after))), 'Actual mutant must load')
    const restored = await run(mutant.label + '-restore-green'); green(restored, 10)
    assert.ok(restored.graph.some(row => row.file === mutant.file && row.sha256 === digest(original)))
    receipt.mutations.push({ ...mutant, red: withoutGraph(red), restore: withoutGraph(restored) })
    console.log('PASS ' + mutant.label + ': actual Assertion RED / restore GREEN')
  }
  receipt.sourceAfter = await hashes(); assert.deepEqual(receipt.sourceAfter, receipt.source)
  receipt.componentProofPassed = true
  await rm(restartDirectory, { recursive: true, force: true }); restartDirectory = undefined
  receipt.cleanup = { testOwnedDirectoryRemoved: true }
  await writeFile(join(evidence, 'component-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  // The visual receipt is produced by the independent reviewer after actual native/CDP operations.
  const visualPath = resolve(process.env.AGENTMUX_SURVEY_LIST_UI_VISUAL_RECEIPT ?? join(evidence, '../survey-list-ui-visual/receipt.json'))
  const visualBytes = await readFile(visualPath), visual = JSON.parse(visualBytes)
  const reviewPath = join(dirname(visualPath), 'review.json'), review = JSON.parse(await readFile(reviewPath, 'utf8'))
  assert.equal(visual.schema, 'agentmux.survey-item-tabs-actions.v1'); assert.equal(visual.scene, 'grouping')
  assert.equal(visual.capturedPass, true); assert.equal(visual.actual.passed, true)
  assert.equal(visual.userAppRunRuntimeControlled, false); assert.equal(visual.actual.userAppRunRuntimeControlled, false)
  assert.deepEqual(visual.sourceAfter, visual.inputs); assert.equal(visual.process.exitCode, 0); assert.equal(visual.cleanup.remaining.length, 0)
  assert.equal(review.status, 'approved'); assert.equal(review.receiptSHA256, digest(visualBytes))
  for (const file of [components + 'SurveyItemList.tsx', components + 'GlobalSurveySurface.tsx', components + 'SurveyItemOptions.tsx', components + 'SurveyZoneItem.tsx',
    'apps/desktop/src/renderer/src/hooks/useSurveyListOrganization.ts', 'apps/desktop/src/renderer/src/styles/survey.css']) {
    assert.equal(visual.inputs[file], receipt.source[file], 'Visual candidate source: ' + file)
    assert.equal(review.reviewedSourceHashes[file], receipt.source[file], 'Independently reviewed source: ' + file)
  }
  assert.ok(Array.isArray(visual.actual.operations) && visual.actual.operations.length > 0)
  assert.ok(Array.isArray(visual.frames) && visual.frames.length > 0)
  assert.equal(review.actuallyViewed.length, visual.frames.length)
  for (const frame of visual.frames) {
    const bytes = await readFile(resolve(dirname(visualPath), frame.file)); assert.ok(bytes.length > 0); assert.equal(digest(bytes), frame.sha256)
    assert.ok(review.actuallyViewed.some(viewed => viewed.file === frame.file && viewed.sha256 === frame.sha256), 'Every final frame independently viewed: ' + frame.file)
  }
  assert.ok((await readFile(join(dirname(visualPath), 'review.md'), 'utf8')).trim())
  receipt.visual = { path: visualPath, sha256: digest(visualBytes), reviewPath, reviewSha256: digest(await readFile(reviewPath)) }
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  if (restartDirectory) await rm(restartDirectory, { recursive: true, force: true })
  receipt.cleanup = { testOwnedDirectoryRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, evidence, mutations: receipt.mutations.length, restart: receipt.restart.length }))
