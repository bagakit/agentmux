import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.local/state/survey-item-tabs-actions/survey-list-public')
const config = 'apps/desktop/scripts/fixtures/survey-list-public/vitest.config.mts'
const owner = 'apps/desktop/src/renderer/src/lib/survey-list.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const inputs = [owner, store, 'packages/core/src/survey-organization.ts', 'packages/core/src/space-control.ts',
  'packages/core/src/space-control-parser.ts', 'packages/core/src/control.ts', 'packages/core/src/public-rpc.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/guides/modules/space.md', 'packages/core/src/generated/agentmux-guides.ts',
  'apps/desktop/src/renderer/src/lib/mobile-presentation.ts', 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
  'apps/desktop/test/survey-list-public.test.tsx', config]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const source = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.survey-list-public.v1', passed: false,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), source,
  sharedSourceMutations: 0, baseline: null, mutations: [], restart: [],
  boundary: 'Actual compiled Source CLI, Unix public RPC and original Renderer Store/preferences save/read. Two test processes consume the same persisted Core spatial file and saved client workbench bytes through original restore owners, retaining original IDs/Run facts/drafts. Runtime snapshots and Session paint are fixtures, no live CLI semantic resume or user Runtime control.' }
const mutations = [
  { label: 'apply-original-organization', file: owner, before: 'ports.set({ surveyOrganization: applied, surveyCollectedZones: appliedMembers })', after: 'ports.set({ surveyOrganization: before, surveyCollectedZones: appliedMembers })' },
  { label: 'expected-original-organization', file: owner, before: 'if (JSON.stringify(expected) !== JSON.stringify(before))', after: 'if (false && JSON.stringify(expected) !== JSON.stringify(before))' },
  { label: 'restore-saved-organization', file: store, before: 'surveyOrganization: restoreSurveyOrganization(persisted.surveyOrganization),', after: 'surveyOrganization: restoreSurveyOrganization(undefined),' }
]
// Explicit evidence reuse preserves the original proof; it never silently skips a changed candidate.
if (process.env.AGENTMUX_SURVEY_LIST_RECEIPT) {
  const previousPath = resolve(process.env.AGENTMUX_SURVEY_LIST_RECEIPT)
  const previousBytes = await readFile(previousPath)
  const previous = JSON.parse(previousBytes)
  assert.equal(previous.schema, receipt.schema); assert.equal(previous.passed, true)
  assert.equal(previous.sharedSourceMutations, 0); assert.equal(previous.cleanup?.testOwnedDirectoryRemoved, true)
  assert.deepEqual(Object.keys(previous.source).sort(), Object.keys(source).sort())
  assert.deepEqual(previous.mutations.map(({ label, file, before, after }) => ({ label, file, before, after })), mutations)
  const previousDirectory = dirname(previousPath)
  const test = 'apps/desktop/test/survey-list-public.test.tsx'
  const changed = inputs.filter(file => previous.source[file] !== source[file])
  let supplement = null
  if (changed.length) {
    assert.deepEqual(changed, [test], 'Only the explicitly bound assertion-only supplement may differ')
    const directory = dirname(previousDirectory)
    const binding = JSON.parse(await readFile(join(directory, 't2-supplement-binding.json'), 'utf8'))
    assert.equal(resolve(directory, binding.formalReceipt), previousPath)
    assert.equal(binding.onlyChangedFile, test); assert.equal(binding.unchangedProductSources, true)
    assert.equal(binding.qualifiedTestSha, previous.source[test]); assert.equal(binding.supplementedTestSha, source[test])
    const original = await readFile(join(directory, binding.originalTestSnapshot), 'utf8')
    const current = await readFile(join(root, test), 'utf8')
    assert.equal(digest(original), previous.source[test])
    const start = "it('[survey-list] retained closed slots can still be renamed while only explicit members remain visible', async () => {\n"
    const additions = [
      '  expect(useAppStore.getState().setSurveyZoneCollected(zones[0]!, true)).toBe(true)\n',
      '  expect(await list()).toMatchObject({ storedOrganization: next, effectiveOrganization: next })\n',
      "  const discovered = objectCliReceipt(JSON.parse((await command(['space', 'ls', '--presentation'])).stdout)).result.catalog.survey\n",
      "  expect(discovered.items.map((item: { zoneId: string }) => item.zoneId)).toEqual([zones[1], 'saved-missing-zone', zones[0]])\n",
      '  expect(protectedFacts()).toEqual(before)\n'
    ].join('')
    assert.equal(current.split(start + '  const before = protectedFacts()\n').length, 2)
    assert.equal(current.split(additions).length, 2)
    assert.equal(current.replace(start + '  const before = protectedFacts()\n', start).replace(additions, ''), original,
      'Supplement must add exactly the reviewed re-collection assertions without changing original tests')
    const result = JSON.parse(await readFile(join(directory, binding.supplement), 'utf8'))
    assert.equal(result.numPassedTests, 1); assert.equal(result.numFailedTests, 0)
    assert.deepEqual(result.testResults.flatMap(file => file.assertionResults.filter(item => item.status === 'passed').map(item => item.fullName)),
      ['[survey-list] retained closed slots can still be renamed while only explicit members remain visible'])
    assert.ok((await readFile(join(directory, binding.supplement.replace(/\.json$/, '.log')), 'utf8')).trim())
    supplement = { binding, reportSha256: digest(await readFile(join(directory, binding.supplement))) }
  }
  async function verifiedPhase(result, minimum, mutant) {
    assert.equal(result.signal, null)
    const output = await readFile(join(previousDirectory, result.log), 'utf8'); assert.ok(output.trim())
    const report = JSON.parse(await readFile(join(previousDirectory, result.log.replace(/\.log$/, '.json')), 'utf8'))
    assert.equal(report.numPassedTests, result.passed); assert.equal(report.numFailedTests, result.failed)
    const graph = (await readFile(join(previousDirectory, result.loaded), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(graph.length > 0)
    for (const row of graph) if (previous.source[row.file]) {
      const expected = mutant?.file === row.file
        ? digest((await readFile(join(root, row.file), 'utf8')).replace(mutant.before, mutant.after)) : previous.source[row.file]
      assert.equal(row.sha256, expected, 'Loaded proof identity: ' + row.file)
    }
    if (mutant) {
      assert.notEqual(result.exit, 0); assert.ok(result.failed > 0); assert.equal(result.assertionRed, true)
      assert.ok(report.testResults.some(file => file.assertionResults.some(item => item.status === 'failed' && item.failureMessages.some(message => message.includes('AssertionError')))))
      assert.ok(graph.some(row => row.file === mutant.file), 'Mutant must actually load')
    } else green(result, minimum)
    return graph
  }
  const graph = await verifiedPhase(previous.baseline, 9)
  assert.equal(previous.baseline.passed, 9)
  for (const file of [owner, store, 'packages/core/src/survey-organization.ts', 'apps/desktop/src/renderer/src/lib/mobile-presentation.ts', 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx'])
    assert.ok(graph.some(row => row.file === file && row.consumer === 'renderer-source'), 'Original Renderer consumer: ' + file)
  for (const file of ['packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/public-rpc.ts', 'packages/core/src/space-control-parser.ts'])
    assert.ok(graph.some(row => row.file === file && row.consumer === 'compiled-cli'), 'Compiled CLI consumer: ' + file)
  for (const mutant of previous.mutations) {
    await verifiedPhase(mutant.red, 0, mutant)
    const restored = await verifiedPhase(mutant.restore, 9)
    assert.equal(mutant.restore.passed, 9)
    assert.ok(restored.some(row => row.file === mutant.file && row.sha256 === previous.source[mutant.file]))
  }
  assert.deepEqual(previous.restart.map(result => result.phase), ['write', 'read'])
  for (const result of previous.restart) { await verifiedPhase(result, 1); assert.equal(result.passed, 1) }
  assert.ok(previous.saved.writerPid > 0); assert.ok(previous.saved.originalSessionIds.length > 0); assert.ok(previous.saved.memberIds.length > 0)
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'reuse-receipt.json'), JSON.stringify({ schema: 'agentmux.survey-list-public-reuse.v1', passed: true,
    originalReceipt: previousPath, originalReceiptSha256: digest(previousBytes), source, supplement, mutations: 3, restart: 2,
    verifierSha256: digest(await readFile(new URL(import.meta.url))), originalEvidenceUnmodified: true, boundary: previous.boundary }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, evidenceReused: true, evidence, mutations: 3, restart: 2 }))
  process.exit(0)
}
await mkdir(evidence, { recursive: true })
async function run(label, mutant, extra = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'amux-survey-list-phase-'))
  try {
  const loaded = join(evidence, label + '.loaded.ndjson'), outputFile = join(evidence, label + '.json')
  await writeFile(loaded, '')
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
      ...(extra.SURVEY_LIST_RESTART_PHASE ? ['-t', '\\[survey-list-restart\\]'] : []),
      '--reporter=default', '--reporter=json', '--outputFile=' + outputFile], {
      cwd: root, env: { ...process.env, ...extra, TMPDIR: temporary, SURVEY_LIST_LOADED: loaded,
        ...(mutant ? { SURVEY_LIST_MUTANT: JSON.stringify(mutant) } : { SURVEY_LIST_MUTANT: '' }) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (exit, signal) => yes({ exit, signal, output }))
  })
  const log = label + '.log'; await writeFile(join(evidence, log), result.output)
  const report = JSON.parse(await readFile(outputFile, 'utf8'))
  const graph = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(graph.length > 0, 'Actual Source load evidence cannot be empty')
  return { exit: result.exit, signal: result.signal, passed: report.numPassedTests, failed: report.numFailedTests,
    assertionRed: report.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError')))),
    log, loaded: label + '.loaded.ndjson', graph }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
function green(result, minimum = 1) {
  assert.equal(result.exit, 0, result.log); assert.equal(result.signal, null); assert.equal(result.failed, 0); assert.ok(result.passed >= minimum)
}
const withoutGraph = ({ graph, ...result }) => result
let restartDirectory
try {
  const baseline = await run('baseline-green'); green(baseline, 9); receipt.baseline = withoutGraph(baseline)
  for (const file of [owner, store, 'packages/core/src/survey-organization.ts', 'apps/desktop/src/renderer/src/lib/mobile-presentation.ts'])
    assert.ok(baseline.graph.some(row => row.file === file && row.consumer === 'renderer-source'), 'Original Renderer owner loaded: ' + file)
  for (const file of ['packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/public-rpc.ts', 'packages/core/src/space-control-parser.ts'])
    assert.ok(baseline.graph.some(row => row.file === file && row.consumer === 'compiled-cli'), 'Compiled CLI consumer loaded: ' + file)
  for (const mutant of mutations) {
    const original = await readFile(join(root, mutant.file), 'utf8')
    assert.equal(original.split(mutant.before).length, 2, 'One production mutation anchor')
    const red = await run(mutant.label + '-red', mutant)
    assert.notEqual(red.exit, 0); assert.equal(red.signal, null); assert.ok(red.failed > 0); assert.equal(red.assertionRed, true)
    assert.ok(red.graph.some(row => row.file === mutant.file && row.sha256 === digest(original.replace(mutant.before, mutant.after))), 'Actual mutant loaded')
    const restored = await run(mutant.label + '-restore-green'); green(restored, 9)
    assert.ok(restored.graph.some(row => row.file === mutant.file && row.sha256 === digest(original)), 'Original source restored')
    receipt.mutations.push({ ...mutant, red: withoutGraph(red), restore: withoutGraph(restored) })
    console.log('PASS ' + mutant.label + ': actual Assertion RED / restore GREEN')
  }
  restartDirectory = await mkdtemp(join(tmpdir(), 'amux-survey-list-restart-'))
  const savedFile = join(restartDirectory, 'workbench.json')
  for (const phase of ['write', 'read']) {
    const result = await run('restart-' + phase, null, { SURVEY_LIST_RESTART_PHASE: phase, SURVEY_LIST_RESTART_FILE: savedFile })
    green(result); assert.equal(result.passed, 1); receipt.restart.push({ phase, ...withoutGraph(result) })
  }
  const saved = JSON.parse(await readFile(savedFile, 'utf8'))
  receipt.saved = { organization: saved.organization, memberIds: Object.keys(saved.members), originalSessionIds: saved.protected.sessions.map(session => session.id), writerPid: saved.pid }
  for (const [file, before] of Object.entries(source)) assert.equal(digest(await readFile(join(root, file))), before, 'Qualified source changed: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  if (restartDirectory) await rm(restartDirectory, { recursive: true, force: true })
  receipt.cleanup = { testOwnedDirectoryRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, evidence, mutations: receipt.mutations.length, restart: receipt.restart.length }))
