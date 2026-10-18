import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
const root = resolve(import.meta.dirname, '../../..'), exec = promisify(execFile)
const recovery = process.argv.includes('--recovery')
const base = join(root, recovery ? '.tmp/a2a-notification-recovery' : '.tmp/a2a-manual-notify'), verified = join(base, 'verified.json')
const hash = value => createHash('sha256').update(value).digest('hex')
const runtime = { node: process.version, platform: process.platform, arch: process.arch }
const cases = recovery ? [
  ['renderer', null, 'candidate'],
  ...['notification-intent-not-persisted', 'notification-history-replaced', 'notification-confirmation-still-busy', 'notification-refusal-event-ignored', 'a2a-fill-caret-captured-late'].map(name => ['renderer', name, 'mutation']),
  ['renderer', null, 'restored']
] : [
  ['renderer', null, 'candidate'], ['bridge', null, 'candidate'],
  ...['notify-original-mid-replaced', 'notify-action-id-reused', 'notify-refresh-replays', 'notify-unrelated-producer-ack'].map(name => ['renderer', name, 'mutation']),
  ...['notifyHost', 'notifyMid', 'notifyTrust', 'notifyInspectRun'].map(name => ['bridge', name, 'mutation']),
  ['renderer', null, 'restored'], ['bridge', null, 'restored']
]
const sameFiles = async files => {
  if (!files || Object.keys(files).length === 0) return false
  for (const [file, digest] of Object.entries(files)) {
    try { if (hash(await readFile(resolve(root, file))) !== digest) return false } catch { return false }
  }
  return true
}
function activeInventory(kind, mutation, report, inventories) {
  const count = kind === 'renderer' ? 36 : 1
  const file = kind === 'renderer' ? 'apps/desktop/test/message-tool-workspace.test.tsx' : 'apps/desktop/test/a2a-message-data-bridge.test.tsx'
  assert.equal(report.testResults.length, 1); assert.equal(resolve(report.testResults[0].name), resolve(root, file))
  const inventory = report.testResults[0].assertionResults.map(test => ({ name: test.fullName, status: test.status })).sort((a, b) => a.name.localeCompare(b.name))
  assert.equal(report.numTotalTests, count); assert.equal(inventory.length, count)
  assert.equal(new Set(inventory.map(test => test.name)).size, count, 'The complete named test inventory is distinct')
  assert.ok(inventory.every(test => test.name && (test.status === 'passed' || test.status === 'failed')), 'Every required test actively executes; skipped and todo never qualify')
  const passed = inventory.filter(test => test.status === 'passed').length, failed = inventory.filter(test => test.status === 'failed').length
  assert.equal(report.numPassedTests, passed); assert.equal(report.numFailedTests, failed); assert.equal(passed + failed, count)
  if (mutation) assert.ok(failed > 0, 'An active assertion kills the mutation')
  else { assert.equal(passed, count, 'Every required candidate/restored assertion passes'); assert.equal(failed, 0) }
  const names = inventory.map(test => test.name)
  if (inventories[kind]) assert.deepEqual(names, inventories[kind], 'Candidate, mutants and restored keep the complete identical test inventory')
  else inventories[kind] = names
  return inventory
}
let reused = false
try {
  const prior = JSON.parse(await readFile(verified, 'utf8')), receipt = JSON.parse(await readFile(resolve(root, prior.receipt), 'utf8'))
  reused = prior.sha256 === hash(JSON.stringify(receipt)) && receipt.schema === 'agentmux.manual-notify-proof.v2' && receipt.passed === true &&
    JSON.stringify(receipt.runtime) === JSON.stringify(runtime) &&
    JSON.stringify(receipt.cases.map(item => [item.kind, item.mutation, item.stage])) === JSON.stringify(cases) &&
    await sameFiles(receipt.sourceHashes) && await sameFiles(receipt.evidenceHashes)
  if (reused) {
    const inventories = {}
    for (const item of receipt.cases) {
      const report = JSON.parse(await readFile(resolve(root, item.report), 'utf8'))
      assert.deepEqual(activeInventory(item.kind, item.mutation, report, inventories), item.inventory)
    }
  }
  if (reused) console.log(JSON.stringify({ passed: true, reused: true, evidence: prior.receipt }))
} catch { reused = false /* Missing, incomplete or changed proof requires the actual tests. */ }
if (!reused) {
  const directory = join(base, globalThis.crypto.randomUUID()); await mkdir(directory, { recursive: true })
  const receipt = { schema: 'agentmux.manual-notify-proof.v2', runtime, passed: false, productionWritten: false, userRunTouched: false, cases: [], sourceHashes: {}, evidenceHashes: {} }
  const inventories = {}
  const fixture = 'apps/desktop/scripts/fixtures/message-tool-workspace'
  const fixed = ['package.json', 'pnpm-lock.yaml', 'packages/core/package.json', 'packages/client-ui/package.json', 'apps/desktop/package.json', 'vitest.setup.ts',
    'apps/desktop/scripts/verify-a2a-manual-notify.mjs', 'apps/desktop/scripts/verify-message-tool-workspace.mjs', 'apps/desktop/test/vitest.a2a-message-data.config.mts', 'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts',
    ...await readdir(join(root, fixture)).then(files => files.map(file => `${fixture}/${file}`))]
  try {
    for (const file of fixed) receipt.sourceHashes[file] = hash(await readFile(join(root, file)))
    for (const [kind, mutation, stage] of cases) {
      const output = join(directory, `${kind}-${mutation ?? stage}`); await mkdir(output, { recursive: true })
      const renderer = kind === 'renderer', test = renderer ? 'apps/desktop/test/message-tool-workspace.test.tsx' : 'apps/desktop/test/a2a-message-data-bridge.test.tsx'
      const env = { ...process.env, ...(renderer ? { AGENTMUX_MESSAGE_WORKSPACE_EVIDENCE: relative(root, output) } : { AGENTMUX_MESSAGE_DATA_EVIDENCE: output }) }
      delete env.AGENTMUX_MESSAGE_WORKSPACE_MUTATION; delete env.AGENTMUX_TEST_MESSAGE_DATA_MUTATION
      if (mutation) env[renderer ? 'AGENTMUX_MESSAGE_WORKSPACE_MUTATION' : 'AGENTMUX_TEST_MESSAGE_DATA_MUTATION'] = mutation
      let code = 0, log = '', executionFailure
      try {
        const run = await exec(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', renderer
          ? `${fixture}/vitest.config.mts` : 'apps/desktop/test/vitest.a2a-message-data.config.mts', test], { cwd: root, env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
        log = run.stdout + run.stderr
      } catch (error) {
        code = error.code; log = (error.stdout ?? '') + (error.stderr ?? '')
        if (error.killed || error.signal) executionFailure = { code, signal: error.signal, message: error.message }
      }
      await writeFile(join(output, 'test.log'), log)
      assert.equal(executionFailure, undefined, 'An interrupted verification process is not behavior proof: ' + JSON.stringify(executionFailure))
      const results = JSON.parse(await readFile(join(output, 'results.json'), 'utf8'))
      const inventory = activeInventory(kind, mutation, results, inventories)
      const proofFile = renderer ? 'discovery.json' : 'mutation.json', source = JSON.parse(await readFile(join(output, proofFile), 'utf8'))
      assert.ok(Object.keys(source.sources).length > 0, 'The actual imported source graph is nonempty')
      for (const [file, digest] of Object.entries(source.sources)) {
        if (receipt.sourceHashes[file]) assert.equal(digest, receipt.sourceHashes[file], 'Related source changed during verification: ' + file)
        receipt.sourceHashes[file] = digest
      }
      if (mutation) {
        assert.equal(source.applied.length, 1); assert.notEqual(source.applied[0].original, source.applied[0].changed)
        assert.equal(typeof code, 'number'); assert.notEqual(code, 0); assert.ok(results.numFailedTests > 0); assert.match(log, /AssertionError:/)
      } else { assert.equal(code, 0, log); assert.equal(results.numFailedTests, 0) }
      for (const name of ['results.json', proofFile, 'test.log']) receipt.evidenceHashes[relative(root, join(output, name))] = hash(await readFile(join(output, name)))
      receipt.cases.push({ kind, mutation, stage, tests: results.numTotalTests, failed: results.numFailedTests, inventory,
        report: relative(root, join(output, 'results.json')), applied: source.applied })
    }
    assert.ok(await sameFiles(receipt.sourceHashes), 'The exact verified source graph remains unchanged')
    receipt.passed = true
  } catch (error) { receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
  const path = join(directory, 'receipt.json'); await writeFile(path, JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.passed) await writeFile(verified, JSON.stringify({ receipt: relative(root, path), sha256: hash(JSON.stringify(receipt)) }) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, reused: false, evidence: relative(root, path), failure: receipt.failure }))
}
