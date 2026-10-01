import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../../..')
export const proofDirectory = path.join(root, ".tmp/object-first-cli-jsonrpc-fixture")
export const readProof = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'))
export async function checkInputs(inputs) {
  assert.ok(inputs && Object.keys(inputs).length > 0, 'Proof must name nonempty Source and compiled inputs')
  for (const [relative, expected] of Object.entries(inputs)) {
    assert.ok(!path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes('..'), 'Proof input must be inside the candidate')
    assert.match(expected, /^[a-f\d]{64}$/u)
    const actual = createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex')
    assert.equal(actual, expected, `Candidate changed: ${relative}`)
  }
}
export async function checkRecordedInputs(inputs) {
  const review = await readProof(".tmp/object-first-cli-jsonrpc-fixture/independent-review.json")
  const continuation = review.typingContinuation
  assert.equal(review.accepted, true)
  assert.equal(continuation.accepted, true)
  const typeBytes = await readFile(path.join(root, continuation.publicTypes.report))
  assert.equal(createHash('sha256').update(typeBytes).digest('hex'), continuation.publicTypes.sha256)
  const types = JSON.parse(typeBytes)
  assert.equal(types.success, true)
  assert.equal(types.numFailedTests, 0)
  assert.ok(types.numPassedTests > 0)
  await checkInputs(continuation.addedInputs)
  const current = { ...inputs }
  for (const [relative, delta] of Object.entries(continuation.inputDelta)) {
    if (!Object.hasOwn(inputs, relative)) continue
    assert.equal(inputs[relative], delta.before, 'Recorded evidence must retain its original Source identity')
    assert.equal(review.inputs[relative], delta.after, 'The typing change must belong to the independent review')
    current[relative] = delta.after
  }
  await checkInputs(current)
  return current
}
export async function verifyIntegration() {
  const native = await readProof('.tmp/space-agent-cli/last/receipt.json')
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
  const nativeCurrentInputs = await checkRecordedInputs(native.inputs)
  assert.deepEqual(Object.keys(native.tools), ['electron'])
  assert.deepEqual(native.toolsAfter, native.tools)
  const electron = native.tools.electron
  assert.equal(createHash('sha256').update(await readFile(electron.path)).digest('hex'), electron.sha256, 'Private Electron tool changed after verification')
  assert.deepEqual(native.cleanup.errors, [])
  assert.deepEqual(native.cleanup.remaining, [])
  assert.equal(native.cleanup.temporaryRootRemoved, true)
  const transport = await readProof('.tmp/public-rpc-transports/last/receipt.json')
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
  const transportCurrentInputs = await checkRecordedInputs(transport.inputs)
  assert.deepEqual(transport.inputsAfter, transport.inputs)
  const receipt = { schema: 'agentmux.object-cli-rpc.integration.v1', passed: true,
    native: '.tmp/space-agent-cli/last/receipt.json', transport: '.tmp/public-rpc-transports/last/receipt.json',
    inputs: { ...transportCurrentInputs, ...nativeCurrentInputs },
    continuation: ".tmp/object-first-cli-jsonrpc-fixture/independent-review.json",
    limitations: native.limitations }
  await mkdir(proofDirectory, { recursive: true })
  await writeFile(path.join(proofDirectory, 'integration.json'), JSON.stringify(receipt, null, 2) + '\n')
  return receipt
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const receipt = await verifyIntegration()
  console.log(JSON.stringify({ passed: receipt.passed, proof: path.relative(root, path.join(proofDirectory, 'integration.json')) }))
}
