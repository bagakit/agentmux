import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile), root = resolve(import.meta.dirname, '../../..')
const tests = ['packages/core/test/goal-role-guidance.test.ts', 'apps/desktop/test/goal-role-inputs.test.ts']
const source = ['packages/core/src/goal-role-guidance.ts', 'packages/core/src/agent-outbound-message.ts', 'packages/core/src/agentmux-pmo-playbook.ts',
  'packages/core/src/agentmux-cli-module-skills.ts', 'apps/desktop/src/main/goal-role-input.ts', 'apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/main/goal-delegation-owner.ts', 'apps/desktop/src/main/goal-patrol-owner.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/continuous-progress-loop-manager.ts', 'apps/desktop/src/main/continuous-progress-delivery.ts', 'apps/desktop/src/main/index.ts',
  'packages/core/dist/client.js', 'packages/core/dist/index.js', 'packages/core/dist/goal-role-guidance.js', 'packages/core/dist/agent-outbound-message.js',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/shared/topic-agent-instructions.ts',
  'apps/desktop/test/helpers/injected-context-core.ts', 'apps/desktop/test/helpers/local-runtime-connector.ts', ...tests]
const cases = [
  { name: 'fresh-executor-input-loses-role', file: 'apps/desktop/src/main/goal-role-input.ts',
    from: "return [note, goalRoleGuidance(role)].filter(Boolean).join('\\n\\n')", to: 'return note',
    oracle: 'actual preload and Main Start handler inject the canonical executor context into original Core input and preserve replayed context' },
  { name: 'frozen-claim-adopts-later-note', file: 'apps/desktop/src/main/goal-role-input.ts',
    from: 'if (original) return original.admission?.intent?.message?.systemContext', to: 'if (original) return note',
    oracle: 'a frozen original application segment survives guidance changes verbatim' },
  { name: 'fresh-pmo-launch-loses-manager-role', file: 'apps/desktop/src/renderer/src/store.ts',
    from: "goalRoleGuidance({ role: 'manager', goalId: demandId, source: { kind: fresh ? 'goal-pmo-launch' : 'goal-discussion', ...(intent.creationOperationId ? { operationId: intent.creationOperationId } : {}) } })", to: "''",
    oracle: 'actual Renderer PMO fresh producer reaches registered IPC and real Core with manager responsibility' },
  { name: 'native-continuation-loses-executor-role', file: 'apps/desktop/src/main/continuous-progress-loop-manager.ts',
    from: "goalRoleGuidance({ role: 'executor', goalId: claim.loop.taskSource.goalId, agentSessionId: claim.loop.agentSessionId, runId: observation.session.run.runId, source: { kind: 'goal-native-continuation', operationId: claim.tickId } })", to: "''",
    oracle: 'an established Goal native continuation at local saves canonical executor context through the original delivery owner' },
  { name: 'delivery-consumer-discards-original-role-note', file: 'apps/desktop/src/main/continuous-progress-delivery.ts',
    from: 'undefined, undefined, pending.agentMuxNote)', to: 'undefined, undefined, undefined)',
    oracle: 'an established Goal native continuation at local saves canonical executor context through the original delivery owner' },
  { name: 'delivery-consumer-mistakes-source-host-for-service-route', file: 'apps/desktop/src/main/continuous-progress-delivery.ts',
    from: 'hostId: loop.hostId, run: condition.expectedRun', to: 'hostId: observation.session.hostId, run: condition.expectedRun',
    oracle: 'an established Goal native continuation at remote-route saves canonical executor context through the original delivery owner' },
  { name: 'application-registration-bypasses-original-delivery-owner', file: 'apps/desktop/src/main/index.ts',
    from: '(loop, operationId, isCurrent, signal) => deliverContinuousProgress(runtime, loop, operationId, isCurrent, signal)', to: "() => Promise.resolve('skipped' as const)",
    oracle: 'an established Goal native continuation at local saves canonical executor context through the original delivery owner' }
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = join(root, '.tmp/goal-responsibility/t004/mutations')
const receiptFile = join(directory, 'receipt.json')
const manifest = async () => Object.fromEntries(await Promise.all(source.map(async file => [file, hash(await readFile(join(root, file)))])))
const env = { ...process.env, pnpm_config_verify_deps_before_run: 'false' }
await mkdir(directory, { recursive: true })
const inputs = await manifest()
let old
try { old = JSON.parse(await readFile(receiptFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
async function inspectResult(entry, oracle, red) {
  assert.equal(hash(await readFile(entry.json)), entry.jsonSha256)
  const value = JSON.parse(await readFile(entry.json, 'utf8'))
  const assertions = value.testResults.flatMap(suite => suite.assertionResults).filter(item => !['pending', 'skipped', 'todo'].includes(item.status))
  assert.ok(assertions.length > 0, 'An empty test set is not proof')
  if (oracle) { assert.equal(assertions.length, 1); assert.equal(assertions[0].fullName, oracle) }
  if (red) {
    assert.equal(entry.code, 1)
    assert.equal(assertions[0].status, 'failed')
    assert.ok(assertions[0].failureMessages.some(message => /AssertionError|expected .*to /u.test(message)), 'Build/load/runtime failures do not count as semantic RED')
    assert.equal(value.numRuntimeErrorTestSuites ?? 0, 0)
  } else {
    assert.equal(entry.code, 0); assert.ok(assertions.every(item => item.status === 'passed'))
  }
}
if (old?.passed && JSON.stringify(old.inputs) === JSON.stringify(inputs) && old.cases.length === cases.length) {
  await inspectResult(old.baseline)
  for (const item of cases) {
    const proof = old.cases.find(proof => proof.name === item.name); assert.ok(proof)
    const original = await readFile(join(root, item.file), 'utf8'); assert.equal(original.split(item.from).length, 2)
    assert.equal(proof.originalSha256, hash(original)); assert.equal(proof.mutantSha256, hash(original.replace(item.from, item.to)))
    await inspectResult(proof.red, item.oracle, true); await inspectResult(proof.restored, item.oracle)
  }
  console.log(JSON.stringify({ passed: true, reused: true, receipt: receiptFile, receiptSha256: hash(await readFile(receiptFile)) })); process.exit(0)
}
// Keep prior evidence immutable; a changed candidate gets its own finite qualification directory.
const candidateDirectory = join(directory, hash(JSON.stringify(inputs)).slice(0, 16)); await mkdir(candidateDirectory, { recursive: true })
const receipt = { schema: 'agentmux.goal-role-guidance-mutations.v1', passed: false, inputs, cases: [],
  proofBoundary: 'Real production role input producers, registered Main handler expressions, original Core/FileStore input and mounted Renderer Store actions. Only Native I/O and unrelated IPC services are isolated. No live model adoption, installation or human acceptance claim.' }
async function check(label, oracle) {
  const json = join(candidateDirectory, label + '.json'), parameters = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...tests,
    ...(oracle ? ['--testNamePattern', oracle] : []), '--maxWorkers=1', '--reporter=json', '--outputFile=' + json]
  let code = 0, output = ''
  try { const result = await run(process.execPath, parameters, { cwd: root, env, maxBuffer: 8 * 1024 * 1024 }); output = result.stdout + result.stderr }
  catch (error) { code = error.code; output = (error.stdout ?? '') + (error.stderr ?? '') }
  await writeFile(join(candidateDirectory, label + '.log'), output)
  return { code, json, jsonSha256: hash(await readFile(json)) }
}
let active
async function restore() {
  if (!active) return
  assert.equal(hash(await readFile(join(root, active.file))), active.mutantSha256, 'Concurrent edit; preserve it and stop instead of overwriting')
  await writeFile(join(root, active.file), active.original); active = undefined
}
try {
  receipt.baseline = await check('baseline'); await inspectResult(receipt.baseline)
  for (const item of cases) {
    assert.deepEqual(await manifest(), inputs, 'Candidate drift before mutation')
    const original = await readFile(join(root, item.file), 'utf8'); assert.equal(original.split(item.from).length, 2)
    const mutant = original.replace(item.from, item.to)
    active = { file: item.file, original, mutantSha256: hash(mutant) }
    await writeFile(join(root, item.file), mutant)
    const red = await check(item.name + '-red', item.oracle); await inspectResult(red, item.oracle, true)
    await restore()
    const restored = await check(item.name + '-restored', item.oracle); await inspectResult(restored, item.oracle)
    receipt.cases.push({ name: item.name, file: item.file, originalSha256: hash(original), mutantSha256: hash(mutant), red, restored })
    process.stdout.write(JSON.stringify({ phase: item.name, semanticRed: true, restoredGreen: true }) + '\n')
  }
  assert.deepEqual(await manifest(), inputs); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message } }
finally {
  try { await restore() } catch (error) { receipt.recoveryFailure = error.message }
  await writeFile(join(candidateDirectory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.passed) await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, receipt: join(candidateDirectory, 'receipt.json'), receiptSha256: hash(await readFile(join(candidateDirectory, 'receipt.json'))) }))
