import assert from 'node:assert/strict'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux, agentPromptCondition } from '@agentmux/core'

const [root, mode] = process.argv.slice(2)
assert.ok(mode === 'counter' || mode === 'restore')
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(root, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(root, 'durable')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(root, 'messages.ndjson')
const file = path.join(root, 'partial-sessions.json'), id = 'actual-native-partial-prompt'
const clients = [], store = new AgentMuxFileAgentSessionStore(file)
const report = { schema: 'agentmux.prompt-native-partial.v1', passed: false,
  partialCounterexampleObserved: false, partialRestorePassed: false, wholeTaskAccepted: false }
let session
const open = async () => {
  const client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(file) })
  clients.push(client); return client
}
const until = async check => {
  const end = Date.now() + 15_000
  do {
    const result = await check(); if (result) return result
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < end)
  throw new Error('Private Native partial fixture did not reach its required boundary')
}
const failure = error => ({ code: error.code, detail: error.detail, message: error.message })
try {
  const cli = path.join(root, 'partial-cli.mjs'), bytes = path.join(root, 'partial-consumed.bin')
  const ready = path.join(root, 'partial-ready')
  await writeFile(cli, '#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from "node:fs"\nprocess.stdin.setRawMode(true)\nprocess.stdin.on("data", data => appendFileSync(process.env.PRIVATE_BYTES, data))\nwriteFileSync(process.env.PRIVATE_READY, "raw-ready")\n')
  await chmod(cli, 0o755)
  const client = await open()
  report.runtimeIdentity = client.runtimeIdentity(); report.coreModule = import.meta.resolve('@agentmux/core')
  session = await client.createAgent({ agentSessionId: id, createOperationId: 'private-native-partial-create',
    providerId: 'codex', executorId: 'codex', workspacePath: root, commandOverride: cli,
    env: { PRIVATE_READY: ready, PRIVATE_BYTES: bytes } })
  await until(async () => (await readFile(ready, 'utf8').catch(() => null)) === 'raw-ready')
  report.originalRun = (await client.statusAgent(id)).run
  assert.ok(Number.isInteger(report.originalRun.pid) && report.originalRun.pid > 1)
  const pending = { request: { kind: 'permission', id: 'private-human-before-submit', agentSessionId: id,
    title: 'Private exact decision', options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }],
    evidence: { source: 'native-hook', observedAt: Date.now(), run: session.run, hookReceiptId: 'private-human-before-submit' } } }
  // Request production is deliberately private. Every byte below passes through the
  // installed public Core package and actual ctxmux recoverableInput owner.
  let injectRequest = true
  client.screenEvidence.wait = async () => {
    if (!injectRequest) return 0
    injectRequest = false
    await client.registry.update(id, session.run, current => ({ ...current, pendingInteraction: pending,
      updatedAt: Math.max(current.updatedAt, Date.now()) }))
    return 0
  }
  const prompt = 'original partial payload'
  const firstInput = { ...agentPromptCondition(client.agentSession(id)), agentSessionId: id, operationId: 'partial-original', prompt }
  const refused = await client.submitAgentPrompt(firstInput)
    .then(() => null, error => error)
  assert.equal(refused?.code, 'AGENT_INTERACTION_PENDING')
  const original = (await store.load())[0]
  assert.equal(original.promptCompletionAdmission.intent.prompt, prompt)
  assert.equal(original.promptCompletionAdmission.intent.plan.kind, 'render-then-submit')
  assert.equal(original.terminalPromptSubmission.submit.acknowledged, false)
  await client.respondAgentInteraction({ agentSessionId: id, expectedRun: session.run,
    response: { kind: 'permission', requestId: pending.request.id,
      decision: { outcome: 'selected', optionId: 'allow-once' } } })
  const answered = (await store.load())[0]
  assert.equal(answered.pendingInteraction, undefined)
  report.answeredRun = (await client.statusAgent(id)).run
  assert.equal(report.answeredRun.acceptedInputBytes, original.terminalPromptSubmission.submit.inputByteRange.startByte + 1)
  const first = await client.submitAgentPrompt({ ...firstInput,
    allowUncertainTurn: true }).then(() => null, error => error)
  assert.equal(first?.code, 'CTXMUX_input_cursor_mismatch'); assert.equal(first?.detail, 'not_applied')
  assert.deepEqual((await store.load())[0].promptCompletionAdmission, original.promptCompletionAdmission)
  const afterFirst = (await store.load())[0]
  if (mode === 'restore') {
    assert.equal(afterFirst.terminalPromptSubmission.payload.acknowledged, true)
    assert.equal(afterFirst.terminalPromptSubmission.submit.acknowledged, false)
    assert.equal(afterFirst.terminalPromptSubmission.submit.notApplied, true)
    const retry = await client.submitAgentPrompt({ ...firstInput,
      allowUncertainTurn: true }).then(() => null, error => error)
    assert.equal(retry?.code, 'AGENT_PROMPT_INPUT_NOT_APPLIED')
    report.sameOperationNegative = failure(retry)
  }
  const cold = await open()
  cold.screenEvidence.wait = async () => 0
  const nextInput = { ...agentPromptCondition(cold.agentSession(id)), agentSessionId: id, operationId: 'partial-next', prompt: 'next payload', allowUncertainTurn: true }
  const second = await cold.submitAgentPrompt(nextInput).then(() => null, error => error)
  if (mode === 'counter') {
    assert.equal(second?.code, 'CTXMUX_input_cursor_mismatch'); assert.equal(second?.detail, 'not_applied')
    assert.deepEqual((await store.load())[0].promptCompletionAdmission, original.promptCompletionAdmission)
    report.partialCounterexampleObserved = true
  } else {
    assert.equal(second, null)
    assert.equal((await store.load())[0].promptCompletionAdmission.submissionId, 'partial-next')
    assert.equal((await store.load())[0].promptCompletionAdmission.acknowledged, true)
    report.partialRestorePassed = true
  }
  report.partial = { original, afterFirst, first: failure(first), second: second && failure(second) }
  report.rawAck = await cold.writeAgent({ agentSessionId: id, expectedRun: session.run, source: 'user', data: 'healthy raw\r' })
  const state = (await cold.statusAgent(id)).run
  assert.equal(state.runId, session.run.runId); assert.equal(state.pid, report.originalRun.pid)
  assert.equal(state.state, 'running')
  const expectedBytes = prompt + '1' + (mode === 'restore' ? 'next payload\r' : '') + 'healthy raw\r'
  await until(async () => (await readFile(bytes).catch(() => Buffer.alloc(0))).length === Buffer.byteLength(expectedBytes))
  report.actualBytes = (await readFile(bytes)).toString('utf8'); report.finalRun = state
  assert.equal(report.actualBytes, expectedBytes)
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  if (session) {
    try {
      const cleanup = await open(), state = await cleanup.statusAgent(id)
      report.cleanupRun = state.run
      if (state.run.state === 'running') await cleanup.stopAgent(id, session.run)
    } catch (error) { report.cleanupFailure = failure(error); report.passed = false }
  }
  await Promise.all(clients.map(client => client.dispose()))
  await writeFile(path.join(root, 'partial-proof.json'), JSON.stringify(report, null, 2) + '\n')
}
assert.equal(report.passed, true, report.failure?.message)
process.stdout.write(JSON.stringify({ phase: 'native-partial-proof', partialCounterexampleObserved: report.partialCounterexampleObserved,
  partialRestorePassed: report.partialRestorePassed,
  wholeTaskAccepted: false }) + '\n')
