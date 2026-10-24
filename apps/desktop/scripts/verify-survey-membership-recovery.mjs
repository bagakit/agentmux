import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Reuse the actual CLI/RPC/Store fixture and private source transforms. No shared source mutation.
const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.local/state/survey-reboot-diagnosis/membership-proof')
const config = 'apps/desktop/scripts/fixtures/survey-list-public/vitest.config.mts'
const owner = 'apps/desktop/src/renderer/src/lib/survey-list.ts', store = 'apps/desktop/src/renderer/src/store.ts'
const inputs = [owner, store, 'packages/core/src/survey-organization.ts', 'packages/core/src/space-control.ts',
  'packages/core/src/space-control-parser.ts', 'packages/core/src/control.ts', 'packages/core/src/public-rpc.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/guides/modules/space.md', 'packages/core/src/generated/agentmux-guides.ts',
  'apps/desktop/test/survey-list-public.test.tsx', config, 'apps/desktop/scripts/verify-survey-membership-recovery.mjs']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const source = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.survey-membership-recovery.v1', passed: false, source,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), mutations: [], restart: [],
  boundary: 'Actual compiled CLI -> Unix public RPC -> original Renderer Store and preference save. Independent test processes restore the same saved client bytes and Core spatial file with original Session/Run facts and drafts. OS/user App, live Runtime and semantic resume are untouched.' }
const mutations = [
  { label: 'apply-membership', file: owner, before: 'ports.set({ surveyOrganization: applied, surveyCollectedZones: appliedMembers })', after: 'ports.set({ surveyOrganization: applied, surveyCollectedZones: state.surveyCollectedZones })', test: '\\[survey-membership\\]' },
  { label: 'compare-original-membership', file: owner, before: 'if (collection && !sameMembers(collection.expectedZoneIds, originalMembers))', after: 'if (false && collection && !sameMembers(collection.expectedZoneIds, originalMembers))', test: '\\[survey-membership\\]' },
  { label: 'qualify-new-zone', file: owner, before: 'if (zoneIds.some(id => before[id] !== true && !hasZone(id)))', after: 'if (false && zoneIds.some(id => before[id] !== true && !hasZone(id)))', test: '\\[survey-membership\\]' },
  { label: 'restore-membership', file: store, before: 'surveyCollectedZones: restoredSurveyCollection(persisted.surveyCollectedZones),', after: 'surveyCollectedZones: {},', test: '\\[survey-list-restart\\]', restart: 'read' }
]
await mkdir(evidence, { recursive: true })
let restartRoot
async function run(label, mutant, extra = {}, test) {
  const temporary = await mkdtemp(join(tmpdir(), 'amux-survey-membership-proof-'))
  try {
    const loaded = join(evidence, label + '.loaded.ndjson'), outputFile = join(evidence, label + '.json')
    await writeFile(loaded, '')
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
        ...(test ? ['-t', test] : []), '--reporter=dot', '--reporter=json', '--outputFile=' + outputFile], {
        cwd: root, env: { ...process.env, ...extra, TMPDIR: temporary, SURVEY_LIST_LOADED: loaded,
          SURVEY_LIST_MUTANT: mutant ? JSON.stringify(mutant) : '' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.on('error', no); child.on('close', (exit, signal) => yes({ exit, signal, output }))
    })
    await writeFile(join(evidence, label + '.log'), result.output)
    const report = JSON.parse(await readFile(outputFile, 'utf8'))
    const graph = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(graph.length > 0, 'Loaded production graph cannot be empty')
    return { exit: result.exit, signal: result.signal, passed: report.numPassedTests, failed: report.numFailedTests,
      assertionRed: report.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError')))),
      log: label + '.log', loaded: label + '.loaded.ndjson', graph }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
const withoutGraph = ({ graph, ...result }) => result
function green(result, minimum = 1) { assert.equal(result.exit, 0, result.log); assert.equal(result.signal, null); assert.equal(result.failed, 0); assert.ok(result.passed >= minimum) }
try {
  const baseline = await run('baseline'); green(baseline, 14); receipt.baseline = withoutGraph(baseline)
  for (const file of [owner, store, 'packages/core/src/survey-organization.ts']) assert.ok(baseline.graph.some(row => row.file === file && row.consumer === 'renderer-source'), 'Original owner loaded: ' + file)
  for (const file of ['packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/space-control-parser.ts', 'packages/core/src/public-rpc.ts'])
    assert.ok(baseline.graph.some(row => row.file === file && row.consumer === 'compiled-cli'), 'Actual CLI source loaded: ' + file)
  restartRoot = await mkdtemp(join(tmpdir(), 'amux-survey-membership-restart-'))
  const savedFile = join(restartRoot, 'workbench.json')
  for (const phase of ['write', 'read']) {
    const result = await run('restart-' + phase, null, { SURVEY_LIST_RESTART_PHASE: phase, SURVEY_LIST_RESTART_FILE: savedFile }, '\\[survey-list-restart\\]')
    green(result); assert.equal(result.passed, 1); receipt.restart.push({ phase, ...withoutGraph(result) })
  }
  const saved = JSON.parse(await readFile(savedFile, 'utf8'))
  receipt.saved = { writerPid: saved.pid, memberIds: Object.keys(saved.members), organization: saved.organization,
    originalSessionIds: saved.protected.sessions.map(session => session.id) }
  assert.ok(receipt.saved.memberIds.length > 0); assert.ok(receipt.saved.originalSessionIds.length > 0)
  for (const mutant of mutations) {
    const original = await readFile(join(root, mutant.file), 'utf8')
    assert.equal(original.split(mutant.before).length, 2, 'Exactly one production mutation anchor')
    const extra = mutant.restart ? { SURVEY_LIST_RESTART_PHASE: mutant.restart, SURVEY_LIST_RESTART_FILE: savedFile } : {}
    const red = await run(mutant.label + '-red', mutant, extra, mutant.test)
    assert.notEqual(red.exit, 0); assert.equal(red.signal, null); assert.ok(red.failed > 0); assert.equal(red.assertionRed, true)
    assert.ok(red.graph.some(row => row.file === mutant.file && row.sha256 === digest(original.replace(mutant.before, mutant.after))), 'Actual mutant loaded')
    const restored = await run(mutant.label + '-restore', null, extra, mutant.test); green(restored)
    assert.ok(restored.graph.some(row => row.file === mutant.file && row.sha256 === digest(original)), 'Restored owner loaded')
    receipt.mutations.push({ ...mutant, red: withoutGraph(red), restore: withoutGraph(restored) })
    console.log('PASS ' + mutant.label + ': assertion RED / restore GREEN')
  }
  for (const [file, hash] of Object.entries(source)) assert.equal(digest(await readFile(join(root, file))), hash, 'Qualified source changed: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  if (restartRoot) await rm(restartRoot, { recursive: true, force: true })
  receipt.cleanup = { privateDirectoryRemoved: true, sharedSourceMutations: 0 }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, evidence, mutations: receipt.mutations.length, restart: receipt.restart.length }))
