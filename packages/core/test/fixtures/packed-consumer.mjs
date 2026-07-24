import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connectLocalAgentMux, connectSshAgentMux } from '@agentmux/core'
import { resolveAgentMuxViewFocus } from '@agentmux/core/runtime'

const execFileAsync = promisify(execFile)

const controlFixture = process.env.AGENTMUX_CONTROL_FIXTURE
const stubbornFixture = process.env.AGENTMUX_STUBBORN_FIXTURE
const fakeCodex = process.env.AGENTMUX_FAKE_CODEX
const agentmuxCli = process.env.AGENTMUX_CLI_PATH
assert.ok(controlFixture && stubbornFixture && fakeCodex && agentmuxCli)
assert.deepEqual(
  resolveAgentMuxViewFocus(
    [{ viewId: 'packed-agent-view', kind: 'agent', agentSessionId: 'packed-agent' }],
    { kind: 'agent-session', agentSessionId: 'packed-agent' }
  ),
  { viewId: 'packed-agent-view', kind: 'agent' }
)

async function waitFor(description, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

function output(events, runId) {
  return events
    .filter((event) => event.type === 'terminal-output' && event.run.runId === runId)
    .map((event) => event.data)
    .join('')
}

async function processIsGone(pid) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return true
    throw error
  }
  return false
}

let first = await connectLocalAgentMux()
assert.deepEqual(await first.listRuns(), [])
const ownerInstanceId = first.runtimeIdentity().instanceId
const firstEvents = []
first.onEvent((event) => firstEvents.push(event))
const run = await first.createTerminal({
  workspacePath: process.cwd(),
  command: process.execPath,
  args: [controlFixture],
  cols: 80,
  rows: 24
})
const firstAttachment = await first.attachTerminal(run.runId, 0)
assert.equal(firstAttachment.gap, null)
await waitFor('fragmented UTF-8 output', () => output(firstEvents, run.runId).includes('control-ready'))
assert.equal(output(firstEvents, run.runId).includes('prefix:😀:tail'), true)
assert.equal(output(firstEvents, run.runId).includes('�'), false)
const beforeReconnect = (await first.listRuns()).find((candidate) => candidate.runId === run.runId)
assert.ok(beforeReconnect)
assert.ok(beforeReconnect.pid)
const originalPid = beforeReconnect.pid
await first.dispose()
first = null

const second = await connectLocalAgentMux()
const reconnected = (await second.listRuns()).find((candidate) => candidate.runId === run.runId)
assert.ok(reconnected)
assert.equal(reconnected.runId, run.runId)
assert.equal(reconnected.pid, originalPid)
const secondEvents = []
second.onEvent((event) => secondEvents.push(event))
const suffix = await second.attachTerminal(run.runId, Buffer.byteLength('prefix:'))
assert.equal(suffix.gap, null)
assert.equal(suffix.replay[0]?.startByte, Buffer.byteLength('prefix:'))
assert.equal(suffix.replay.map((event) => event.data).join('').includes('😀:tail'), true)

const recoverableInput = {
  ownerInstanceId,
  operationId: 'packed-abandoned-input-response',
  expectedByte: reconnected.acceptedInputBytes,
  data: 'dedup-once\n'
}
// Deliberately discard the first receipt, then recover it through a fresh public Client.
await second.writeTerminal(run, recoverableInput)
await waitFor('first recoverable input', () => output(secondEvents, run.runId).includes('input:dedup-once'))
await second.dispose()

const third = await connectLocalAgentMux()
const thirdEvents = []
third.onEvent((event) => thirdEvents.push(event))
const fullReplay = await third.attachTerminal(run.runId, 0)
const recoveredInput = await third.writeTerminal(run, recoverableInput)
assert.deepEqual(recoveredInput.appliedByteRange, {
  startByte: recoverableInput.expectedByte,
  endByte: recoverableInput.expectedByte + Buffer.byteLength(recoverableInput.data)
})
const followingInput = {
  ownerInstanceId,
  operationId: 'packed-following-input',
  expectedByte: recoveredInput.acceptedThroughByte,
  data: 'after-dedup\n'
}
await third.writeTerminal(run, followingInput)
await waitFor('following recoverable input', () => output(thirdEvents, run.runId).includes('input:after-dedup'))
const completeOutput = fullReplay.replay.map((event) => event.data).join('') + output(thirdEvents, run.runId)
const dedupOccurrences = completeOutput.match(/input:dedup-once/gu)?.length ?? 0
assert.equal(dedupOccurrences, 1)

await third.resizeTerminal(run, 101, 37)
await waitFor('applied resize', () => output(thirdEvents, run.runId).includes('size:101x37'))
await third.signalTerminal(run, 'SIGINT')
await waitFor('interrupt receipt from the still-live process', () => (
  output(thirdEvents, run.runId).includes('interrupt-observed')
))
assert.equal((await third.listRuns()).find((candidate) => candidate.runId === run.runId)?.state, 'running')
await third.stopTerminal(run)

const stubbornEvents = []
const unsubscribe = third.onEvent((event) => stubbornEvents.push(event))
const stubborn = await third.createTerminal({
  workspacePath: process.cwd(),
  command: process.execPath,
  args: [stubbornFixture]
})
await third.attachTerminal(stubborn.runId, 0)
const stubbornOutput = await waitFor('stubborn process tree identities', () => {
  const text = output(stubbornEvents, stubborn.runId)
  return text.includes('stubborn-root:') && text.includes('stubborn-child:') ? text : null
})
const rootMatch = /stubborn-root:(\d+):(\d+)/u.exec(stubbornOutput)
const childMatch = /stubborn-child:(\d+)/u.exec(stubbornOutput)
assert.ok(rootMatch && childMatch)
const stubbornPids = [Number(rootMatch[1]), Number(rootMatch[2]), Number(childMatch[1])]
await third.stopTerminal(stubborn)
await waitFor('complete stubborn process-tree stop', async () => (
  (await Promise.all(stubbornPids.map(processIsGone))).every(Boolean)
))
unsubscribe()

const cli = async (args) => await execFileAsync(agentmuxCli, args, {
  timeout: 15_000,
  maxBuffer: 4 * 1024 * 1024
})
let codexFirst = await connectLocalAgentMux()
const codexFirstEvents = []
codexFirst.onEvent((event) => codexFirstEvents.push(event))
const codex = await codexFirst.createAgent({
  agentSessionId: 'codex-semantic-1',
  createOperationId: `packed-codex-${crypto.randomUUID()}`,
  agentId: 'codex',
  workspacePath: process.cwd(),
  prompt: 'first',
  commandOverride: fakeCodex
})
const codexAttachment = await codexFirst.reattachAgent(codex.agentSessionId, 0)
await waitFor('Codex native Hook identity', () => (
  codexFirst.agentSession(codex.agentSessionId).nativeHandle?.kind === 'provider' &&
  codexFirstEvents.some((event) => (
    event.type === 'agent-status' && event.agentSessionId === codex.agentSessionId && event.state === 'waiting'
  ))
))
assert.equal(codexFirst.resolveAgentSession({ kind: 'run', run: codex.run }).agentSessionId, codex.agentSessionId)
assert.equal(codexFirst.resolveAgentSession({
  kind: 'provider-native',
  providerId: 'codex',
  sessionId: 'native-codex-semantic-1'
}).agentSessionId, codex.agentSessionId)
assert.equal(codexFirstEvents.some((event) => (
  event.type === 'agent-status' && event.agentSessionId === codex.agentSessionId && event.state === 'waiting'
)), true)
const codexPid = (await codexFirst.statusAgent(codex.agentSessionId)).run.pid
assert.ok(codexPid)
await codexFirst.dispose()
codexFirst = null

const cliStatus = JSON.parse((await cli(['status', codex.agentSessionId, '--json'])).stdout)
assert.equal(cliStatus.session.agentSessionId, codex.agentSessionId)
assert.equal(cliStatus.run.runId, codex.run.runId)
const cliList = JSON.parse((await cli(['list', '--json'])).stdout)
assert.equal(cliList.length, 1)
assert.equal(cliList[0].session.agentSessionId, codex.agentSessionId)
const cliAttachment = JSON.parse((await cli(['attach', codex.agentSessionId, '--after-byte', '0', '--json'])).stdout)
assert.equal(cliAttachment.session.agentSessionId, codex.agentSessionId)
await cli(['send', codex.agentSessionId, '--text', 'continue', '--json'])
await cli(['interrupt', codex.agentSessionId, '--json'])

const codexSecond = await connectLocalAgentMux()
const codexSecondEvents = []
codexSecond.onEvent((event) => codexSecondEvents.push(event))
const codexReconnected = await codexSecond.statusAgent(codex.agentSessionId)
assert.equal(codexReconnected.run.runId, codex.run.runId)
assert.equal(codexReconnected.run.pid, codexPid)
assert.equal(codexSecond.agentSessions().length, 1)
const codexReplay = await codexSecond.reattachAgent(codex.agentSessionId, 0)
const codexReplayText = codexAttachment.attachment.replay.map((event) => event.data).join('') +
  codexReplay.attachment.replay.map((event) => event.data).join('')
assert.equal(codexReplayText.includes('codex-ready:first'), true)
assert.equal(codexReplayText.includes('codex-input:continue'), true)
assert.equal(codexReplayText.includes('codex-interrupt'), true)
await codexSecond.writeAgent(codex.agentSessionId, 'exit\n')
await waitFor('Codex Run exit', async () => (
  (await codexSecond.statusAgent(codex.agentSessionId)).run.state === 'exited'
))
await codexSecond.dispose()
const resumeResult = JSON.parse((await cli(['resume', codex.agentSessionId, '--json'])).stdout)
const resumed = resumeResult.result
assert.equal(resumed.agentSessionId, codex.agentSessionId)
assert.notEqual(resumed.run.runId, codex.run.runId)
const codexThird = await connectLocalAgentMux()
assert.equal(codexThird.agentSessions().length, 1)
await codexThird.reattachAgent(resumed.agentSessionId, 0)
await waitFor('resumed Codex Hook receipt', () => (
  codexThird.agentSession(resumed.agentSessionId).hookReceipt?.run.runId === resumed.run.runId
))
assert.throws(
  () => codexThird.resolveAgentSession({ kind: 'run', run: codex.run }),
  (error) => error?.code === 'STALE_AGENT_SESSION_BINDING'
)
await codexThird.dispose()
await cli(['stop', resumed.agentSessionId, '--json'])
const codexStopped = await connectLocalAgentMux()
assert.deepEqual(codexStopped.agentSessions(), [])
await codexStopped.dispose()

await assert.rejects(
  connectSshAgentMux({ target: { hostId: 'remote', hostname: 'example.invalid' } }),
  (error) => error?.code === 'REMOTE_UNSUPPORTED'
)
await third.dispose()

process.stdout.write(`${JSON.stringify({
  runId: run.runId,
  pid: originalPid,
  replayStartByte: suffix.replay[0]?.startByte,
  resize: '101x37',
  interruptStillLive: true,
  dedupOccurrences,
  stubbornPids,
  codexSemanticSession: codex.agentSessionId,
  codexNativeSession: 'native-codex-semantic-1',
  remote: 'unsupported'
})}\n`)
