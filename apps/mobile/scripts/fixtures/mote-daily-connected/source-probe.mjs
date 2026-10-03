import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../../../..')
const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const output = path.resolve(root, flag('--evidence-dir') ?? '.tmp/mote-daily-connected/source-' + Date.now())
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const scope = 'apps/mobile/src/navigation/goal-work.ts', ui = 'apps/mobile/src/navigation/MobileGoalWork.tsx', owner = 'apps/mobile/src/recovery/device-workface.ts'
const mutations = [
  ['original-association', scope, '!goal.sessionIds.includes(sessionId)', 'false'],
  ['durable-runtime', scope, 'expected.runtimeId === observed.runtimeId', 'true'],
  ['relay-host', scope, 'expected.deviceHostId === observed.deviceHostId', 'true'],
  ['late-intent', scope, "if (!stillCurrent() || !admitsGoalWorkTarget(operation, goalWorkTarget(client, owner, operation.sessionId, operation.goalId)))", "if (!admitsGoalWorkTarget(operation, goalWorkTarget(client, owner, operation.sessionId, operation.goalId)))"],
  ['original-start-ack', scope, "if (loop.initialDelivery.state === 'confirmed') owner.confirmGoalOperation(operation)", 'owner.confirmGoalOperation(operation)'],
  ['foreign-start-receipt', scope, "if (goalSessionLoops(client, returned, operation.sessionId).length !== 1)", "if (false)"],
  ['original-mutation-revision', scope, 'loop.revision !== operation.expectedRevision && !acknowledged', 'false'],
  ['unknown-resume', scope, "loop.initialDelivery?.state !== 'confirmed' || detail.goal?.alignment?.confirmedAt == null", "false || detail.goal?.alignment?.confirmedAt == null"],
  ['foreign-workspace', scope, 'loop.workspacePath !== session.workspacePath', 'false'],
  ['same-op-content', owner, 'existing && !sameGoalOperation(existing, operation)', 'false'],
  ['only-own-confirmation', owner, 'current.pending.filter(op => op !== existing)', '[]'],
  ['bounded-duplicate-intent', owner, 'found.has(op.operationId)', 'false'],
  ['source-qualified-detail', ui, 'admitsGoalWorkTarget(selection, detail.target)', 'true'],
  ['source-qualified-capability', ui, 'selection.runtimeId === runtime.runtimeId', 'true'],
  ['late-list', ui, 'if (current.current !== token) return\n      if (client.runtimeOwnerIdentity()', 'if (false) return\n      if (client.runtimeOwnerIdentity()'],
  ['nullable-relay-admission', scope, 'expected.deviceHostId === null || expected.deviceHostId === observed.deviceHostId', 'expected.deviceHostId === observed.deviceHostId'],
  ['focus-final-authority', ui, 'if (!selection || !admitsGoalWorkTarget(selection, goalWorkTarget(client, owner, agentSessionId, goalId)))', 'if (false)'],
  ['other-window-original-intent', owner, 'if (!existing && current.pending.some', 'if (false && current.pending.some'],
  ['reconnect-read-only', ui, "client.forwardRpc('goal.ls', { agentSessionId })", "client.forwardRpc('goal.start', { goalId: 'foreign-automatic-start', sessionId: agentSessionId })"]
].map(([name, file, before, after]) => ({ name, file, before, after }))
await fs.mkdir(output, { recursive: true })
async function run(name, mutation) {
  const prefix = path.join(output, name), proof = prefix + '.ndjson', report = prefix + '.json', log = prefix + '.log'
  await fs.writeFile(proof, '')
  const child = spawn(process.execPath, [path.join(root, 'apps/mobile/node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'apps/mobile/scripts/fixtures/mote-daily-connected/vitest.config.mts'), '--reporter=json', '--outputFile=' + report], {
    cwd: root, env: { ...process.env, AGENTMUX_CONNECTED_GOAL_PROOF: proof,
      ...(mutation ? { AGENTMUX_CONNECTED_GOAL_MUTANT: JSON.stringify(mutation) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let bytes = ''; child.stdout.on('data', chunk => { bytes += chunk }); child.stderr.on('data', chunk => { bytes += chunk })
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000)
  const outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })) }).finally(() => clearTimeout(timer))
  await fs.writeFile(log, bytes)
  const result = JSON.parse(await fs.readFile(report, 'utf8')), rows = (await fs.readFile(proof, 'utf8')).trim().split('\n').filter(Boolean).map(value => JSON.parse(value))
  const failures = result.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  const assertionRed = failures.some(test => test.failureMessages.some(message => message.includes('AssertionError')))
  const transformed = rows.filter(row => row.consumer === 'actual-loaded-mutant')
  const receipt = { name, ...outcome, passedTests: result.numPassedTests, failedTests: result.numFailedTests, totalTests: result.numTotalTests,
    assertionRed, rows: transformed, log: path.relative(root, log), logSHA: hash(await fs.readFile(log)), report: path.relative(root, report), reportSHA: hash(await fs.readFile(report)), loaded: path.relative(root, proof), loadedSHA: hash(await fs.readFile(proof)) }
  console.log(JSON.stringify({ name, exitCode: outcome.exitCode, totalTests: result.numTotalTests, assertionRed, transformed: transformed.length }))
  assert.equal(outcome.signal, null)
  if (mutation) { assert.notEqual(outcome.exitCode, 0); assert.equal(assertionRed, true); assert.equal(transformed.length, 1); assert.notEqual(transformed[0].beforeSha256, transformed[0].afterSha256) }
  else { assert.equal(outcome.exitCode, 0); assert.ok(result.numTotalTests >= 42); assert.equal(result.numFailedTests, 0); assert.ok(rows.length > 0) }
  return { receipt, rows }
}
try {
  let reuse
  if (process.argv.includes('--repair-late-intent')) {
    const file = flag('--prior-proof'), beforeTest = flag('--prior-test'), beforeProbe = flag('--prior-probe')
    assert.ok(file && beforeTest && beforeProbe, 'Original proof and exact prior two sources are required')
    const priorBytes = await fs.readFile(path.resolve(root, file)), prior = JSON.parse(priorBytes)
    assert.equal(prior.passed, true); assert.equal(prior.mutants.length, 19)
    const test = 'apps/mobile/test/connected-goal.test.tsx', probe = 'apps/mobile/scripts/fixtures/mote-daily-connected/source-probe.mjs'
    assert.equal(hash(await fs.readFile(path.resolve(root, beforeTest))), prior.source[test])
    assert.equal(hash(await fs.readFile(path.resolve(root, beforeProbe))), prior.source[probe])
    for (const [file, sha256] of Object.entries(prior.source)) if (file !== test && file !== probe) assert.equal(hash(await fs.readFile(path.join(root, file))), sha256)
    const previous = await fs.readFile(path.resolve(root, beforeTest), 'utf8'), current = await fs.readFile(path.join(root, test), 'utf8')
    const start = "  it('does not forward after a delayed fresh read belongs to an old A-B-A scope'", end = "  it('keeps an unknown start pending"
    assert.equal(previous.split(start).length, 2); assert.equal(current.split(start).length, 2)
    assert.equal(previous.split(start)[0], current.split(start)[0]); assert.equal(previous.split(end)[1], current.split(end)[1])
    reuse = { reference: { file, sha256: hash(priorBytes) }, mutants: prior.mutants.filter(row => row.name !== 'late-intent'),
      testDelta: { file: test, beforeFile: beforeTest, beforeSha256: prior.source[test], afterSha256: hash(current), start, end },
      producerDelta: { file: probe, beforeFile: beforeProbe, beforeSha256: prior.source[probe], afterSha256: hash(await fs.readFile(path.join(root, probe))) } }
    assert.equal(reuse.mutants.length, 18)
  }
  const initial = await run('baseline')
  const mutants = reuse ? reuse.mutants.slice() : []
  for (const mutant of reuse ? mutations.filter(row => row.name === 'late-intent') : mutations) {
    const source = await fs.readFile(path.join(root, mutant.file), 'utf8')
    assert.equal(source.split(mutant.before).length, 2, 'One exact original Source anchor required: ' + mutant.name)
    mutants.push((await run(mutant.name, mutant)).receipt)
  }
  const restored = await run('restored')
  const source = Object.fromEntries(restored.rows.filter(row => row.sha256).map(row => [row.file, row.sha256]))
  for (const file of ['apps/mobile/test/connected-goal.test.tsx', 'apps/mobile/test/device-workface.test.tsx', 'apps/mobile/test/spatial-navigation.test.tsx', 'apps/mobile/scripts/fixtures/mote-daily-connected/vitest.config.mts', 'apps/mobile/scripts/fixtures/mote-daily-connected/source-probe.mjs']) source[file] = hash(await fs.readFile(path.join(root, file)))
  const receipt = { schema: 'agentmux.mobile.goal-source.v1', passed: true, source, initial: initial.receipt, mutants, restored: restored.receipt,
    ...(reuse ? { reusedQualification: { ...reuse, mutants: reuse.mutants.map(row => row.name) } } : {}) }
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, receipt: path.relative(root, path.join(output, 'receipt.json')), mutations: mutants.length, loaded: Object.keys(source).length }))
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, message: error.message, stack: error.stack }, null, 2) + '\n')
  throw error
}
