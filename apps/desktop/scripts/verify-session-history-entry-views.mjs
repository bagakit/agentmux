import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

assert.ok(process.argv.includes('--verify-owning-qualification'), 'Use --verify-owning-qualification')
const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, '.tmp/session-history-entry-views-qualification', `${Date.now()}-${process.pid}`)
await mkdir(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const source = 'apps/desktop/src/renderer/src/components/SessionPane.tsx'
const sourceBytes = await readFile(resolve(root, source))
const test = 'apps/desktop/test/session-history-entry-views.test.tsx'
const testBytes = await readFile(resolve(root, test))
const result = { schema: 'agentmux.session-history-entry-views-qualification.v1', passed: false,
  root, output, source: { path: source, sha256: hash(sourceBytes) }, test: { path: test, sha256: hash(testBytes) },
  stages: [], boundary: 'Actual mounted public preview API facts; only PTY paint isolated. Source transforms are in-memory, never product writes. No Native/provider Writer/restart/install qualification.' }

async function run(label, mutation) {
  const reportPath = resolve(output, `${label}.json`)
  const loadedPath = resolve(output, `${label}.loaded.jsonl`)
  const argv = ['node_modules/vitest/vitest.mjs', 'run', '--config',
    'apps/desktop/scripts/fixtures/session-history-entry-views/vitest.owning.config.mts',
    '--maxWorkers=1', '--reporter=json', `--outputFile=${reportPath}`]
  const env = { ...process.env, AGENTMUX_ENTRY_LOADED_SOURCE: loadedPath }
  delete env.AGENTMUX_ENTRY_MUTATION
  if (mutation) env.AGENTMUX_ENTRY_MUTATION = mutation
  const chunks = []
  const startedAt = new Date().toISOString()
  const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => chunks.push(bytes))
  const exitCode = await new Promise((done, fail) => { child.on('error', fail); child.on('close', done) })
  const log = Buffer.concat(chunks); await writeFile(resolve(output, `${label}.log`), log)
  const reportBytes = await readFile(reportPath), report = JSON.parse(reportBytes)
  const loadedBytes = await readFile(loadedPath)
  const loaded = loadedBytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(loaded.length > 0, 'Nonempty actually loaded production Source')
  const owner = loaded.find(item => item.path === source)
  assert.ok(owner, 'Actual SessionPane Source is loaded by the owning consumer')
  assert.equal(owner.originalSHA256, hash(sourceBytes))
  const assertions = report.testResults.flatMap(file => file.assertionResults)
  assert.ok(assertions.length > 0, 'Nonempty owning cases')
  const assertionFailures = assertions.filter(item => item.status === 'failed' && item.failureMessages.some(message => message.includes('AssertionError')))
  const otherFailures = assertions.filter(item => item.status === 'failed' && !item.failureMessages.some(message => message.includes('AssertionError')))
  const stage = { label, mutation: mutation ?? null, cwd: root, executable: process.execPath, argv,
    startedAt, endedAt: new Date().toISOString(), exitCode, tests: report.numTotalTests,
    passed: report.numPassedTests, failed: report.numFailedTests, assertionFailures: assertionFailures.length,
    otherFailures: otherFailures.length, actualLoadedSource: owner, loadedRecords: loaded.length,
    report: reportPath, reportSHA256: hash(reportBytes), loaded: loadedPath, loadedSHA256: hash(loadedBytes),
    logSHA256: hash(log) }
  result.stages.push(stage)
  await writeFile(resolve(output, 'qualification.json'), `${JSON.stringify(result, null, 2)}\n`)
  if (mutation) {
    assert.notEqual(exitCode, 0, 'A broken production entry must fail')
    assert.equal(owner.mutation, mutation)
    assert.notEqual(owner.sha256, owner.originalSHA256)
    assert.ok(assertionFailures.length > 0, 'Actual behavior AssertionRED, not preparation/collect failure')
    assert.equal(otherFailures.length, 0)
  } else {
    assert.equal(exitCode, 0)
    assert.equal(report.success, true)
    assert.equal(report.numFailedTests, 0)
    assert.equal(owner.sha256, owner.originalSHA256)
  }
}
try {
  await run('baseline')
  for (const mutation of ['activity-hidden', 'wrong-return', 'skip-return-focus', 'covered-activity-focus']) await run(mutation, mutation)
  await run('exact-restore')
  assert.equal(hash(await readFile(resolve(root, source))), hash(sourceBytes), 'Source bytes retained')
  assert.equal(hash(await readFile(resolve(root, test))), hash(testBytes), 'Test bytes retained')
  result.passed = true
} finally {
  await writeFile(resolve(output, 'qualification.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ passed: result.passed, receipt: resolve(output, 'qualification.json') }))
}
