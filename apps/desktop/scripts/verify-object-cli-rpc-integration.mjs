import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../../..')
export const proofDirectory = path.join(root, ".tmp/object-first-cli-jsonrpc-fixture")
export const readProof = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'))
export async function readPinnedProof(reference) {
  assert.ok(reference && typeof reference.path === 'string' && !path.isAbsolute(reference.path) &&
    !reference.path.split(/[\\/]/u).includes('..'), 'Proof reference must be inside the candidate')
  assert.match(reference.sha256, /^[a-f\d]{64}$/u)
  const bytes = await readFile(path.join(root, reference.path))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256, `Recorded proof changed: ${reference.path}`)
  return JSON.parse(bytes.toString('utf8'))
}
export async function checkInputs(inputs) {
  assert.ok(inputs && Object.keys(inputs).length > 0, 'Proof must name nonempty Source and compiled inputs')
  for (const [relative, expected] of Object.entries(inputs)) {
    assert.ok(!path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes('..'), 'Proof input must be inside the candidate')
    assert.match(expected, /^[a-f\d]{64}$/u)
    const actual = createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex')
    assert.equal(actual, expected, `Candidate changed: ${relative}`)
  }
}
export async function verifyIntegration() {
  const continuation = await readProof(".tmp/object-first-cli-jsonrpc-fixture/continuation.json")
  const taskState = await readPinnedProof(continuation.taskState)
  assert.equal(taskState.feat_id, 'f-2j28fqcvt')
  const completedTasks = ['T-001', 'T-002', 'T-003']
  assert.deepEqual(Object.keys(continuation.taskReviews), completedTasks)
  for (const taskId of completedTasks) {
    const task = taskState.tasks.find(task => task.id === taskId)
    assert.equal(task?.status, 'done', `Original ${taskId} must be closed`)
    assert.equal(task.gate_result, 'pass')
    assert.equal(task.last_gate_commands.length, 2, 'Each original Task has two verification commands')
    assert.deepEqual(task.last_gate_commands.map(command => command.command), task.verification.map(command => command.ref))
    assert.ok(task.last_gate_commands.every(command => command.status === 'pass' && command.exit_code === 0 && command.command.length > 0))
    const review = await readPinnedProof(continuation.taskReviews[taskId])
    assert.equal(review.feature, 'f-2j28fqcvt')
    assert.equal(review.task, taskId)
    assert.equal(review.status, 'approved-scoped')
  }
  await checkInputs(continuation.inputs)
  const native = await readPinnedProof(continuation.native)
  assert.equal(native.passed, true, 'Private production-shaped Desktop proof must pass')
  assert.deepEqual(native.phases.map(item => item.phase), ['seed', 'restore', 'empty-restore', 'admission', 'after-admission'])
  assert.equal(new Set(native.phases.map(item => item.native.pid)).size, 5, 'Restoration requires independent process generations')
  assert.equal(native.originalRuns.length, 4)
  assert.deepEqual(native.survivingRuns, native.originalRuns)
  for (const phase of native.phases) {
    assert.equal(phase.native.passed, true)
    assert.ok(phase.native.cli.length > 0, 'Every process must observe the real compiled CLI')
  }
  assert.deepEqual(native.inputsAfter, native.inputs)
  await checkInputs(native.inputs)
  assert.deepEqual(Object.keys(native.tools), ['electron'])
  assert.deepEqual(native.toolsAfter, native.tools)
  const electron = native.tools.electron
  assert.equal(createHash('sha256').update(await readFile(electron.path)).digest('hex'), electron.sha256, 'Private Electron tool changed after verification')
  assert.deepEqual(native.cleanup.errors, [])
  assert.deepEqual(native.cleanup.remaining, [])
  assert.equal(native.cleanup.temporaryRootRemoved, true)
  const transport = await readPinnedProof(continuation.transport)
  assert.equal(transport.passed, true, 'Actual Unix, HTTP and SSH proof must pass')
  assert.equal(transport.schema, 'agentmux.public-rpc-transports.private.v1')
  assert.deepEqual(transport.records.map(record => record.transport), ['unix', 'http', 'ssh'])
  const first = transport.records[0]
  assert.ok(typeof first.agentSessionId === 'string' && first.agentSessionId.length > 0)
  assert.ok(typeof first.run.runId === 'string' && first.run.runId.length > 0)
  assert.ok(Number.isSafeInteger(first.pid) && first.pid > 0)
  assert.ok(typeof first.cwd === 'string' && first.cwd.length > 0)
  for (const record of transport.records) {
    assert.equal(record.agentSessionId, first.agentSessionId)
    assert.deepEqual(record.run, first.run)
    assert.equal(record.pid, first.pid)
    assert.equal(record.cwd, first.cwd)
    assert.equal(record.capabilityRejected, true)
    assert.equal(record.independentReaderCancelled, true)
    assert.equal(record.responseBeforeNotifications, true)
    assert.ok(record.frameCount >= 2 && record.outputBytes > 0)
    assert.match(record.outputSha256, /^[a-f\d]{64}$/u)
    assert.ok(record.inputAfter > record.inputBefore)
    if (record.transport === 'ssh') assert.ok(Number.isSafeInteger(record.actualSshDaemonPid) && record.actualSshDaemonPid > 0)
  }
  assert.deepEqual(transport.cleanup.errors, [])
  assert.deepEqual(transport.cleanup.remaining, [])
  assert.equal(transport.cleanup.rootRemoved, true)
  assert.equal(transport.sourceUnchanged, true)
  assert.equal(transport.executionFailure, null)
  assert.equal(transport.failure, null)
  await checkInputs(transport.inputs)
  assert.deepEqual(transport.inputsAfter, transport.inputs)
  for (const inputs of [native.inputs, transport.inputs]) {
    for (const [relative, expected] of Object.entries(inputs)) {
      assert.equal(continuation.inputs[relative], expected, `Current candidate must include every proof input: ${relative}`)
    }
  }
  const receipt = { schema: 'agentmux.object-cli-rpc.integration.v1', passed: true,
    native: continuation.native, transport: continuation.transport,
    inputs: continuation.inputs,
    recordedInputs: { native: native.inputs, transport: transport.inputs },
    taskState: continuation.taskState, taskReviews: continuation.taskReviews,
    continuation: ".tmp/object-first-cli-jsonrpc-fixture/continuation.json",
    limitations: native.limitations }
  await mkdir(proofDirectory, { recursive: true })
  await writeFile(path.join(proofDirectory, 'integration.continuation.json'), JSON.stringify(receipt, null, 2) + '\n')
  return receipt
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const receipt = await verifyIntegration()
  console.log(JSON.stringify({ passed: receipt.passed, proof: path.relative(root, path.join(proofDirectory, 'integration.continuation.json')) }))
}
