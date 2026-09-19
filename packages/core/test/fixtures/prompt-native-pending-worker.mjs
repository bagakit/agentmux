import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AgentMuxError, AgentMuxFileAgentSessionStore, connectLocalAgentMux, agentPromptCondition } from '@agentmux/core'
const [root, mode] = process.argv.slice(2)
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(root, 'runtime')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(root, 'messages.ndjson')
const file = path.join(root, 'native-sessions.json')
const store = new AgentMuxFileAgentSessionStore(file)
const id = 'actual-native-pending-prompt'
const prompt = 'p'.repeat(64 * 1024 - 32)
const intentFile = path.join(root, 'proof-original-input.json')
let input
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const fresh = () => connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(file) })
const until = async check => {
  const end = Date.now() + 15000
  do { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
  throw new Error('Private Native fixture did not reach its required boundary')
}
if (mode === 'crash') {
  input = JSON.parse(await readFile(intentFile, 'utf8'))
  const client = await fresh(), kernel = client.kernel
  const apply = kernel.input.bind(kernel)
  kernel.input = async (runId, operation) => {
    const pending = apply(runId, operation)
    pending.catch(() => {})
    // Native advances its cursor only when the whole write completes. The actual
    // differing-tuple rejection below, rather than that still-zero cursor, proves
    // Native already owns the original request. A raced probe cannot pass this oracle.
    const probe = await fresh()
    const conflict = await probe.kernel.input(runId, { ...operation, data: operation.data + 'negative-control' }).then(() => null, error => error)
    await probe.dispose()
    assert.equal(conflict?.detail, 'not_applied')
    assert.match(conflict.message, /operation key is retained for another request/)
    const state = await client.statusAgent(id)
    assert.ok(state.run.acceptedInputBytes < operation.expectedByte + Buffer.byteLength(operation.data), 'Native must still own a non-terminal input')
    const admission = (await store.load())[0].promptCompletionAdmission
    await new Promise(() => process.stdout.write(JSON.stringify({ phase: 'native-pending-owned', pid: process.pid,
      run: state.run, operation, conflict: { code: conflict.code, detail: conflict.detail, message: conflict.message },
      admission }) + '\n', () => process.exit(91)))
  }
  await client.submitAgentPrompt(input)
  throw new Error('The Core crash gate was not reached')
}
assert.equal(mode, 'parent')
const clients = []
let session, pid, actor, actorClosed, readGate
const report = { schema: 'agentmux.prompt-native-pending.v1', passed: false,
  pendingRestorePassed: false, historicalRetryProtected: false, wholeTaskAccepted: false }
const open = async () => { const client = await fresh(); clients.push(client); return client }

try {
  const cli = path.join(root, 'raw-cli.mjs'), bytes = path.join(root, 'consumed.bin'), ready = path.join(root, 'raw-ready')
  readGate = path.join(root, 'read-enable')
  await writeFile(cli, '#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs"\nprocess.stdin.setRawMode(true)\nprocess.stdin.pause()\nwriteFileSync(process.env.PRIVATE_READY, "raw-ready")\nconst gate = setInterval(() => { if (existsSync(process.env.PRIVATE_READ)) { clearInterval(gate); process.stdin.on("data", data => appendFileSync(process.env.PRIVATE_BYTES, data)); process.stdin.resume() } }, 20)\n')
  await chmod(cli, 0o755)
  const creator = await open()
  report.runtimeIdentity = creator.runtimeIdentity()
  report.coreModule = import.meta.resolve('@agentmux/core')
  session = await creator.createAgent({ agentSessionId: id, createOperationId: 'private-native-create',
    providerId: 'traex', executorId: 'traex', workspacePath: root, commandOverride: cli,
    env: { PRIVATE_READY: ready, PRIVATE_BYTES: bytes, PRIVATE_READ: readGate } })
  await until(async () => (await readFile(ready, 'utf8').catch(() => null)) === 'raw-ready')
  const status = await creator.statusAgent(id)
  pid = status.run.pid
  assert.ok(Number.isInteger(pid) && pid > 1)
  input = { ...agentPromptCondition(creator.agentSession(id)), agentSessionId: id, operationId: 'native-pending-original', prompt }
  // Private proof intent is written before the actor can execute; its cold successor reads it unchanged.
  await writeFile(intentFile, JSON.stringify(input))
  actor = spawn(process.execPath, [import.meta.filename, root, 'crash'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let raw = '', stderr = ''
  actor.stdout.on('data', data => { raw += data })
  actor.stderr.on('data', data => { stderr += data })
  actorClosed = new Promise(resolve => actor.once('close', (code, signal) => resolve({ code, signal, stderr })))
  const end = await actorClosed
  assert.equal(end.code, 91, end.stderr)
  const boundary = JSON.parse(raw.trim())
  assert.equal(boundary.phase, 'native-pending-owned')
  const successor = await open(), original = (await store.load())[0].promptCompletionAdmission
  let entered
  const joining = new Promise(resolve => { entered = resolve })
  const apply = successor.kernel.input.bind(successor.kernel)
  successor.kernel.input = async (runId, operation) => {
    assert.deepEqual(operation, boundary.operation, 'Cold Core must join the frozen Native request')
    entered()
    return await apply(runId, operation)
  }
  const response = successor.submitAgentPrompt(input).then(() => null, error => error)
  await joining
  const during = await successor.statusAgent(id)
  assert.equal(during.run.pid, pid)
  assert.equal(during.run.runId, session.run.runId)
  assert.ok(during.run.acceptedInputBytes < original.endByte)
  assert.deepEqual((await store.load())[0].promptCompletionAdmission, original)
  await writeFile(readGate, 'read')
  assert.equal(await response, null)
  await until(async () => (await readFile(bytes).catch(() => Buffer.alloc(0))).length === original.endByte)
  const actual = await readFile(bytes)
  assert.equal(actual.toString(), prompt + '\r', 'Original input must be consumed once, with no second physical payload')
  report.pendingRestorePassed = true
  report.pending = { actor: boundary, restoredByPid: process.pid, run: (await successor.statusAgent(id)).run,
    consumedBytes: actual.length, consumedSha256: createHash('sha256').update(actual).digest('hex') }
  // Actual Native lost ACK and a later accepted intent must leave the historical retry harmless.
  const old = await open(), originalInput = old.kernel.input.bind(old.kernel)
  let lose = true
  old.kernel.input = async (...args) => {
    const ack = await originalInput(...args)
    if (lose) { lose = false; report.lostActualAck = ack; throw new AgentMuxError('Actual ACK deliberately lost', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown') }
    return ack
  }
  const oldMessage = { ...agentPromptCondition(old.agentSession(id)), agentSessionId: id, operationId: 'older-actual-lost-ack', prompt: 'older actual', allowUncertainTurn: true }
  await assert.rejects(old.submitAgentPrompt(oldMessage), /Actual ACK deliberately lost/)
  const newer = await open()
  await newer.submitAgentPrompt({ ...agentPromptCondition(newer.agentSession(id)), agentSessionId: id, operationId: 'newer-actual-accepted', prompt: 'newer actual', allowUncertainTurn: true })
  const before = (await store.load())[0]
  const retry = await open()
  const error = await retry.submitAgentPrompt(oldMessage).then(() => null, error => error)
  const after = (await store.load())[0]
  assert.equal(before.promptCompletionAdmission.submissionId, 'newer-actual-accepted')
  assert.deepEqual(after, before, 'Historical retry must not alter the later Session fact')
  assert.equal(error?.code, 'AGENT_PROMPT_INPUT_UNCONFIRMED')
  assert.equal(error?.detail, 'unknown')
  await until(async () => (await readFile(bytes)).toString().endsWith('older actual\rnewer actual\r'))
  assert.equal((await readFile(bytes)).toString(), prompt + '\r' + 'older actual\rnewer actual\r')
  report.historicalRetryProtected = true
  report.historicalRetry = { before, after, failure: { code: error.code, detail: error.detail, message: error.message } }
  const rawAck = await retry.writeAgent({ agentSessionId: id, expectedRun: session.run, data: 'healthy raw\r', source: 'user' })
  report.healthyRawAck = rawAck
  assert.equal((await retry.statusAgent(id)).run.pid, pid)
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  if (readGate) await writeFile(readGate, 'read')
  if (actor && actor.exitCode === null && actor.signalCode === null) { actor.kill('SIGTERM'); await actorClosed }
  if (session) {
    try {
      const cleanup = await open(), status = await cleanup.statusAgent(id)
      report.cleanupRun = status.run
      if (status.run.state === 'running') await cleanup.stopAgent(id, session.run)
    } catch (error) {
      report.cleanupFailure = { name: error.name, message: error.message }
      report.passed = false
    }
  }
  await Promise.all(clients.map(client => client.dispose()))
  await writeFile(path.join(root, 'native-proof.json'), JSON.stringify(report, null, 2) + '\n')
}
assert.equal(report.passed, true, report.failure?.message)
emit({ phase: 'native-proof', pendingRestorePassed: report.pendingRestorePassed,
  historicalRetryProtected: report.historicalRetryProtected, wholeTaskAccepted: false })
