import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.local/state/survey-reboot-diagnosis/install-continuity')
const config = 'apps/desktop/scripts/fixtures/survey-install-continuity/vitest.config.mts'
const store = 'apps/desktop/src/renderer/src/store.ts', schema = 'apps/desktop/src/shared/client-observation.ts', installer = 'apps/desktop/scripts/package-macos.mjs'
const bearing = [store, schema, installer, 'apps/desktop/src/main/client-observation.ts',
  'apps/desktop/src/main/control-ipc-bridge.ts', 'apps/desktop/scripts/package-runtime-upgrade.mjs']
const tests = ['apps/desktop/test/package-install-workbench-continuity.test.ts', 'apps/desktop/test/survey-install-observation.test.ts', 'apps/desktop/test/package-ui-observation-rpc.test.ts']
const minimumPerFile = [63, 3, 9]
const restartTest = 'apps/desktop/test/survey-list-public.test.tsx'
const inputs = [...bearing, ...tests, config, 'apps/desktop/scripts/verify-survey-install-continuity.mjs']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(root, file)))])))
const mutations = [
  { label: 'publish-original-survey-preferences', file: store,
    before: '        survey: { collectedZoneIds: Object.keys(state.surveyCollectedZones).filter(id => state.surveyCollectedZones[id] === true),\n          organization: state.surveyOrganization, selection: persistedSurveyZoneSelection(state.surveyZoneSelection) },\n', after: '' },
  { label: 'compare-original-survey-preferences', file: installer,
    before: '...(includeSurvey ? { survey: workbench.survey } : {})',
    after: '...(false ? { survey: workbench.survey } : {})' },
  { label: 'strict-original-survey-schema', file: schema, before: 'survey: survey.optional(),', after: 'survey: z.unknown().optional(),' }
]
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.survey-install-continuity.v1', passed: false, source: await hashes(), baseline: null, mutations: [],
  sharedSourceMutations: 0, boundary: 'Actual Store -> Desktop IPC/Main -> public Unix RPC app.inspect, original inspector child, and real installer qualification/directory cutover/transaction receipts. Only test-owned app files and controlled OS/RPC inputs; no user profile, installation, live Run control or causal claim about the historical loss. Private process persistence reuses the exact Store and original test from the shared Survey membership recovery proof; its inspect.client assertions do not replace this gate\'s actual Main/shared-schema/RPC checks.' }
const withoutGraph = ({ graph, ...result }) => result
async function run(label, mutant) {
  const temporary = await mkdtemp(join(tmpdir(), 'amux-survey-install-proof-'))
  try {
    const loaded = join(evidence, label + '.loaded.ndjson'), outputFile = join(evidence, label + '.json')
    await writeFile(loaded, '')
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
        '--reporter=default', '--reporter=json', '--outputFile=' + outputFile], {
        cwd: root, env: { ...process.env, TMPDIR: temporary, SURVEY_INSTALL_LOADED: loaded, SURVEY_INSTALL_MUTANT: mutant ? JSON.stringify(mutant) : '' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.on('error', no); child.on('close', (exit, signal) => yes({ exit, signal, output }))
    })
    const log = label + '.log'; await writeFile(join(evidence, log), result.output)
    const report = JSON.parse(await readFile(outputFile, 'utf8'))
    assert.equal(report.testResults.length, tests.length, 'Every actual consumer test file must execute')
    assert.deepEqual(report.testResults.map(file => resolve(file.name)).sort(), tests.map(file => join(root, file)).sort())
    assert.ok(report.testResults.every(file => file.assertionResults.length > 0))
    const graph = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(graph.length > 0)
    return { exit: result.exit, signal: result.signal, passed: report.numPassedTests, failed: report.numFailedTests,
      consumers: report.testResults.map(file => ({ file: relativeToRoot(file.name), passed: file.assertionResults.filter(test => test.status === 'passed').length })),
      assertionRed: report.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError')))),
      log, loaded: label + '.loaded.ndjson', graph }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
function relativeToRoot(file) { const absolute = resolve(file); assert.ok(absolute.startsWith(root + '/')); return absolute.slice(root.length + 1) }
function green(result) {
  assert.equal(result.exit, 0, result.log); assert.equal(result.signal, null); assert.equal(result.failed, 0); assert.ok(result.passed >= 75)
  for (const [index, file] of tests.entries()) assert.ok(result.consumers.some(consumer => consumer.file === file && consumer.passed >= minimumPerFile[index]), 'Actual consumer assertions must pass: ' + file)
}
async function savedProcessProof() {
  const path = join(root, '.local/state/survey-reboot-diagnosis/membership-proof/receipt.json')
  const bytes = await readFile(path), saved = JSON.parse(bytes), directory = resolve(path, '..')
  assert.equal(saved.schema, 'agentmux.survey-membership-recovery.v1'); assert.equal(saved.passed, true)
  assert.deepEqual(saved.cleanup, { privateDirectoryRemoved: true, sharedSourceMutations: 0 })
  assert.equal(saved.source[store], receipt.source[store], 'Both process proofs must use the exact published Store')
  const testBytes = await readFile(join(root, restartTest)), testSource = testBytes.toString()
  assert.equal(saved.source[restartTest], digest(testBytes), 'Original writer/reader assertions must retain their exact source')
  // This existing process test actually observes all three fields on each side; it cannot conditionally skip an absent field.
  for (const assertion of [
    'expect(observation.observation.survey).toEqual({ collectedZoneIds: Object.keys(useAppStore.getState().surveyCollectedZones), organization: grouped(), selection: useAppStore.getState().surveyZoneSelection })',
    'expect(observation.observation.survey).toEqual({ collectedZoneIds: Object.keys(saved.members), organization: saved.organization, selection: saved.selection })'
  ]) assert.ok(testSource.includes(assertion), 'Original process Store observation assertion is required')
  assert.deepEqual(saved.restart.map(result => result.phase), ['write', 'read'])
  const phases = []
  for (const phase of saved.restart) {
    assert.equal(phase.exit, 0); assert.equal(phase.signal, null); assert.equal(phase.passed, 1); assert.equal(phase.failed, 0)
    const reportPath = join(directory, 'restart-' + phase.phase + '.json'), reportBytes = await readFile(reportPath), report = JSON.parse(reportBytes)
    assert.equal(report.numPassedTests, 1); assert.equal(report.numFailedTests, 0); assert.equal(report.testResults.length, 1)
    assert.equal(resolve(report.testResults[0].name), join(root, restartTest))
    const assertions = report.testResults[0].assertionResults.filter(test => test.status === 'passed')
    assert.equal(assertions.length, 1); assert.ok(assertions[0].fullName.includes('[survey-list-restart]'))
    const graphBytes = await readFile(join(directory, phase.loaded)), graph = graphBytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(graph.some(row => row.file === store && row.sha256 === receipt.source[store]), 'Each real process loaded the current Store')
    const logBytes = await readFile(join(directory, phase.log)); assert.ok(logBytes.length > 0)
    phases.push({ phase: phase.phase, report: reportPath, reportSHA256: digest(reportBytes), loaded: join(directory, phase.loaded), loadedSHA256: digest(graphBytes), log: join(directory, phase.log), logSHA256: digest(logBytes) })
  }
  assert.ok(Number.isInteger(saved.saved.writerPid) && saved.saved.writerPid > 0)
  assert.ok(saved.saved.memberIds.length > 0 && saved.saved.memberIds.includes('saved-missing-zone'))
  assert.ok(saved.saved.organization.groups.some(group => group.collapsed && group.zoneIds.includes('saved-missing-zone')))
  assert.ok(saved.saved.originalSessionIds.length > 0)
  return { path, sha256: digest(bytes), storeSHA256: receipt.source[store], testSHA256: digest(testBytes), phases, saved: saved.saved }
}
try {
  const baseline = await run('baseline-green'); green(baseline); receipt.baseline = withoutGraph(baseline)
  for (const file of bearing) assert.ok(baseline.graph.some(row => row.file === file && row.sha256 === receipt.source[file]), 'Actual original owner loaded: ' + file)
  for (const mutant of mutations) {
    const original = await readFile(join(root, mutant.file), 'utf8'); assert.equal(original.split(mutant.before).length, 2)
    const red = await run(mutant.label + '-red', mutant)
    assert.ok(red.exit > 0); assert.equal(red.signal, null); assert.ok(red.failed > 0); assert.equal(red.assertionRed, true)
    assert.ok(red.graph.some(row => row.file === mutant.file && row.sha256 === digest(original.replace(mutant.before, mutant.after))), 'Actual mutant loaded')
    const restored = await run(mutant.label + '-restore-green'); green(restored)
    assert.ok(restored.graph.some(row => row.file === mutant.file && row.sha256 === digest(original)), 'Original owner restored')
    receipt.mutations.push({ ...mutant, red: withoutGraph(red), restore: withoutGraph(restored) })
    console.log('PASS ' + mutant.label + ': actual Assertion RED / restore GREEN')
  }
  receipt.recovery = await savedProcessProof()
  receipt.sourceAfter = await hashes(); assert.deepEqual(receipt.sourceAfter, receipt.source)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  receipt.cleanup = { testOwnedDirectoriesRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, evidence, mutations: receipt.mutations.length }))
