import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import {
  AgentMuxDesktopFocusServer,
  AgentMuxFileAgentSessionStore,
  connectLocalAgentMux,
  connectSshAgentMux
} from '@agentmux/core'
import { resolveAgentMuxViewFocus } from '@agentmux/core/runtime'

const execFileAsync = promisify(execFile)

const controlFixture = process.env.AGENTMUX_CONTROL_FIXTURE
const stubbornFixture = process.env.AGENTMUX_STUBBORN_FIXTURE
const fakeCodex = process.env.AGENTMUX_FAKE_CODEX
const agentmuxCli = process.env.AGENTMUX_CLI_PATH
const lifecycleCrashFixture = process.env.AGENTMUX_LIFECYCLE_CRASH_FIXTURE
const promptCrashFixture = process.env.AGENTMUX_PROMPT_CRASH_FIXTURE
assert.ok(
  controlFixture && stubbornFixture && fakeCodex && agentmuxCli &&
  lifecycleCrashFixture && promptCrashFixture
)
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

async function firstJsonLine(child) {
  let buffer = ''
  for await (const chunk of child.stdout) {
    buffer += chunk.toString('utf8')
    const newline = buffer.indexOf('\n')
    if (newline >= 0) return JSON.parse(buffer.slice(0, newline))
  }
  throw new Error('Child exited before reporting its lifecycle checkpoint.')
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
assert.equal(
  output(firstEvents, run.runId).includes('terminal-env:xterm-256color:truecolor:color-enabled'),
  true
)
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
assert.deepEqual(codex.terminalHandshake, {
  run: { runId: codex.run.runId },
  operationId: codex.terminalHandshake?.operationId,
  inputByteRange: { startByte: 0, endByte: 5 },
  acknowledged: true
})
assert.ok(codex.terminalHandshake.operationId)
const codexAttachment = await codexFirst.reattachAgent(codex.agentSessionId, 0)
await waitFor('Codex native Hook identity', () => (
  codexFirst.agentSession(codex.agentSessionId).nativeHandle?.kind === 'provider' &&
  codexFirstEvents.some((event) => (
    event.type === 'agent-status' && event.agentSessionId === codex.agentSessionId && event.state === 'waiting'
  ))
))
const initialStopReceipt = await waitFor('Codex ready Stop receipt', () => {
  const receipt = codexFirst.agentSession(codex.agentSessionId).terminalStopReceipt
  return receipt?.readyThroughByte === undefined ? null : receipt
})
assert.equal(initialStopReceipt.readyThroughByte, initialStopReceipt.outputCursorBytes)
assert.equal(codexFirst.resolveAgentSession({ kind: 'run', run: codex.run }).agentSessionId, codex.agentSessionId)
assert.equal(codexFirst.resolveAgentSession({
  kind: 'provider-native',
  providerId: 'codex',
  sessionId: 'native-codex-semantic-1'
}).agentSessionId, codex.agentSessionId)
assert.equal(codexFirstEvents.some((event) => (
  event.type === 'agent-status' && event.agentSessionId === codex.agentSessionId && event.state === 'waiting'
)), true)
assert.equal((await codexFirst.statusAgent(codex.agentSessionId)).run.state, 'running')
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
for (const args of [
  ['agent-session', codex.agentSessionId],
  ['provider-native', 'codex', 'native-codex-semantic-1'],
  ['run', codex.run.runId]
]) {
  const resolved = JSON.parse((await cli(['resolve', ...args, '--json'])).stdout)
  assert.equal(resolved.agentSessionId, codex.agentSessionId)
}
const focusTargets = []
const focusServer = new AgentMuxDesktopFocusServer({
  async focus(target) {
    focusTargets.push(target)
    return target.kind === 'terminal-view'
      ? { viewId: target.viewId, kind: 'terminal' }
      : { viewId: 'packed-agent-view', kind: 'agent' }
  }
})
await focusServer.start()
const switchedAgent = JSON.parse((await cli([
  'switch', 'provider-native', 'codex', 'native-codex-semantic-1', '--json'
])).stdout)
assert.deepEqual(switchedAgent, { viewId: 'packed-agent-view', kind: 'agent' })
const switchedTerminal = JSON.parse((await cli([
  'switch', 'terminal-view', 'packed-terminal-view', '--json'
])).stdout)
assert.deepEqual(switchedTerminal, { viewId: 'packed-terminal-view', kind: 'terminal' })
assert.deepEqual(focusTargets, [
  { kind: 'agent-session', agentSessionId: codex.agentSessionId },
  { kind: 'terminal-view', viewId: 'packed-terminal-view' }
])
await focusServer.stop()
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
const replayText = codexAttachment.attachment.replay.map((event) => event.data).join('') +
  codexReplay.attachment.replay.map((event) => event.data).join('')
const liveText = () => codexSecondEvents.flatMap((event) => (
  event.type === 'terminal-output' ? [event.data] : []
)).join('')
await waitFor('Codex Provider submit sequence', () => (
  `${replayText}${liveText()}`.includes('codex-submit:continue:accepted')
))
const codexReplayText = `${replayText}${liveText()}`
assert.equal(codexReplayText.includes('codex-ready:first'), true)
assert.equal(codexReplayText.includes('codex-submit:continue:accepted'), true)
assert.equal(
  codexReplayText.includes(`codex-composer-rendered:${Buffer.byteLength('continue')}`),
  true
)
assert.equal(codexReplayText.includes('codex-composer-near-miss'), true)
assert.equal(codexReplayText.includes('codex-ignored-early-enter'), false)
assert.equal(codexReplayText.includes('codex-interrupt'), true)
assert.equal(codexReplayText.includes('\u001b[?7u'), false)
assert.equal(codexReplayText.includes('\u001b[13u'), false)
const handshakeQueryIndex = codexReplayText.indexOf('\u001b[?u')
const handshakeAckIndex = codexReplayText.indexOf('codex-handshake:kitty-flags-0')
const initialPromptIndex = codexReplayText.indexOf('codex-ready:first')
const submittedPromptIndex = codexReplayText.indexOf('codex-submit:continue:accepted')
assert.ok(handshakeQueryIndex >= 0)
assert.ok(handshakeAckIndex > handshakeQueryIndex)
assert.ok(initialPromptIndex > handshakeAckIndex)
assert.ok(submittedPromptIndex > handshakeAckIndex)
await waitFor('next ready Stop receipt', () => {
  const receipt = codexSecond.agentSession(codex.agentSessionId).terminalStopReceipt
  return receipt?.id !== initialStopReceipt.id && receipt?.readyThroughByte !== undefined
})
await codexSecond.submitAgentPrompt({
  agentSessionId: codex.agentSessionId,
  operationId: 'packed-codex-exit',
  prompt: 'exit'
})
await waitFor('Codex Run exit', async () => (
  (await codexSecond.statusAgent(codex.agentSessionId)).run.state === 'exited'
))
await codexSecond.dispose()
const resumePrompt = 'packed native resume prompt'
const resumeResult = JSON.parse((await cli([
  'resume', codex.agentSessionId, '--text', resumePrompt, '--json'
])).stdout)
const resumed = resumeResult.result
assert.equal(resumed.agentSessionId, codex.agentSessionId)
assert.notEqual(resumed.run.runId, codex.run.runId)
assert.deepEqual(resumed.terminalHandshake?.inputByteRange, { startByte: 0, endByte: 5 })
assert.equal(resumed.terminalHandshake?.acknowledged, true)
const codexThird = await connectLocalAgentMux()
assert.equal(codexThird.agentSessions().length, 1)
const codexThirdEvents = []
codexThird.onEvent((event) => codexThirdEvents.push(event))
const resumedAttachment = await codexThird.reattachAgent(resumed.agentSessionId, 0)
const resumedReplay = resumedAttachment.attachment.replay.map((event) => event.data).join('')
await waitFor('native resume argv prompt', () => (
  `${resumedReplay}${output(codexThirdEvents, resumed.run.runId)}`
    .includes(`codex-ready:${resumePrompt}`)
))
await waitFor('resumed Codex Hook receipt', () => (
  codexThird.agentSession(resumed.agentSessionId).hookReceipt?.run.runId === resumed.run.runId
))
await waitFor('resumed Codex ready Stop receipt', () => (
  codexThird.agentSession(resumed.agentSessionId).terminalStopReceipt?.readyThroughByte !== undefined
))
assert.throws(
  () => codexThird.resolveAgentSession({ kind: 'run', run: codex.run }),
  (error) => error?.code === 'STALE_AGENT_SESSION_BINDING'
)
await assert.rejects(
  cli(['resolve', 'run', codex.run.runId, '--json']),
  (error) => error?.stderr?.includes('STALE_AGENT_SESSION_BINDING')
)
await codexThird.submitAgentPrompt({
  agentSessionId: resumed.agentSessionId,
  operationId: 'packed-codex-resumed-exit',
  prompt: 'exit'
})
await waitFor('resumed Codex Run natural exit', async () => (
  (await codexThird.statusAgent(resumed.agentSessionId)).run.state === 'exited'
))
await codexThird.dispose()
await cli(['stop', resumed.agentSessionId, '--json'])
const codexStopped = await connectLocalAgentMux()
assert.deepEqual(codexStopped.agentSessions(), [])
await codexStopped.dispose()

const noStopClient = await connectLocalAgentMux()
const noStopEvents = []
noStopClient.onEvent((event) => noStopEvents.push(event))
const noStop = await noStopClient.createAgent({
  agentSessionId: 'codex-no-stop',
  createOperationId: 'packed-codex-no-stop-create',
  agentId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'no-stop' }
})
await noStopClient.reattachAgent(noStop.agentSessionId, 0)
await waitFor('fake Codex without Stop epoch', () => (
  output(noStopEvents, noStop.run.runId).includes('codex-composer-ready-frame')
))
await assert.rejects(
  noStopClient.submitAgentPrompt({
    agentSessionId: noStop.agentSessionId,
    operationId: 'packed-no-stop-prompt',
    prompt: 'must-not-reach-pty'
  }),
  (error) => error?.code === 'AGENT_PROMPT_NOT_READY'
)
assert.equal((await noStopClient.statusAgent(noStop.agentSessionId)).run.acceptedInputBytes, 5)
assert.equal(output(noStopEvents, noStop.run.runId).includes('codex-dropped-pre-ready-payload'), false)
await noStopClient.stopAgent(noStop.agentSessionId)
await noStopClient.dispose()

const afterCursorClient = await connectLocalAgentMux()
const afterCursor = await afterCursorClient.createAgent({
  agentSessionId: 'codex-frame-after-cursor',
  createOperationId: 'packed-codex-after-create',
  agentId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'after' }
})
const pendingAfterCursor = await waitFor('Stop boundary before composer frame', () => (
  afterCursorClient.agentSession(afterCursor.agentSessionId).terminalStopReceipt ?? null
))
assert.equal(pendingAfterCursor.readyThroughByte, undefined)
await assert.rejects(
  afterCursorClient.submitAgentPrompt({
    agentSessionId: afterCursor.agentSessionId,
    operationId: 'packed-after-too-early',
    prompt: 'too-early'
  }),
  (error) => error?.code === 'AGENT_PROMPT_NOT_READY'
)
await afterCursorClient.writeAgent(afterCursor.agentSessionId, '\u001d')
const readyAfterCursor = await waitFor('composer frame after captured Stop cursor', () => {
  const receipt = afterCursorClient.agentSession(afterCursor.agentSessionId).terminalStopReceipt
  return receipt?.readyThroughByte === undefined ? null : receipt
})
assert.ok(readyAfterCursor.readyThroughByte > readyAfterCursor.outputCursorBytes)
await afterCursorClient.submitAgentPrompt({
  agentSessionId: afterCursor.agentSessionId,
  operationId: 'packed-after-exit',
  prompt: 'exit'
})
await waitFor('after-cursor fake Codex exit', async () => (
  (await afterCursorClient.statusAgent(afterCursor.agentSessionId)).run.state === 'exited'
))
await afterCursorClient.stopAgent(afterCursor.agentSessionId)
await afterCursorClient.dispose()

const concurrentOwner = await connectLocalAgentMux()
const concurrent = await concurrentOwner.createAgent({
  agentSessionId: 'codex-concurrent-stop',
  createOperationId: 'packed-codex-concurrent-create',
  agentId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'before' }
})
await waitFor('concurrent prompt ready Stop receipt', () => (
  concurrentOwner.agentSession(concurrent.agentSessionId).terminalStopReceipt?.readyThroughByte !== undefined
))
const concurrentContender = await connectLocalAgentMux()
const concurrentResults = await Promise.allSettled([
  concurrentOwner.submitAgentPrompt({
    agentSessionId: concurrent.agentSessionId,
    operationId: 'packed-concurrent-owner',
    prompt: 'owner-wins-or-loses'
  }),
  concurrentContender.submitAgentPrompt({
    agentSessionId: concurrent.agentSessionId,
    operationId: 'packed-concurrent-contender',
    prompt: 'contender-wins-or-loses'
  })
])
assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1)
const concurrentFailure = concurrentResults.find((result) => result.status === 'rejected')
assert.equal(concurrentFailure?.reason?.code, 'AGENT_PROMPT_STOP_RECEIPT_CONFLICT')
const concurrentReplay = await concurrentOwner.reattachAgent(concurrent.agentSessionId, 0)
const concurrentOutput = concurrentReplay.attachment.replay.map((event) => event.data).join('')
assert.equal(
  (concurrentOutput.match(/codex-submit:(?:owner|contender)-wins-or-loses:accepted/gu) ?? []).length,
  1
)
await concurrentContender.dispose()
await concurrentOwner.stopAgent(concurrent.agentSessionId)
await concurrentOwner.dispose()

const promptCrashWorker = spawn(process.execPath, [promptCrashFixture], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENTMUX_FAKE_CODEX: fakeCodex }
})
const promptCrashCheckpoint = await firstJsonLine(promptCrashWorker)
assert.equal(promptCrashCheckpoint.type, 'prompt-payload-acknowledged-before-submit')
assert.deepEqual(promptCrashCheckpoint.payloadRange, {
  startByte: 5,
  endByte: 5 + Buffer.byteLength('crash-between-phases')
})
assert.deepEqual(promptCrashCheckpoint.submitRange, {
  startByte: 5 + Buffer.byteLength('crash-between-phases'),
  endByte: 6 + Buffer.byteLength('crash-between-phases')
})
const [promptCrashCode] = await once(promptCrashWorker, 'exit')
assert.equal(promptCrashCode, 91)

const promptRecovered = await connectLocalAgentMux()
const promptRecoveredEvents = []
promptRecovered.onEvent((event) => promptRecoveredEvents.push(event))
const promptRecoveredAttachment = await promptRecovered.reattachAgent(
  promptCrashCheckpoint.agentSessionId,
  0
)
await promptRecovered.submitAgentPrompt({
  agentSessionId: promptCrashCheckpoint.agentSessionId,
  operationId: 'packed-prompt-crash-operation',
  prompt: 'crash-between-phases'
})
await waitFor('crash-recovered prompt submit phase', () => (
  output(promptRecoveredEvents, promptCrashCheckpoint.runId)
    .includes('codex-submit:crash-between-phases:accepted')
))
const promptRecoveryOutput = promptRecoveredAttachment.attachment.replay
  .map((event) => event.data).join('') + output(promptRecoveredEvents, promptCrashCheckpoint.runId)
assert.equal(
  promptRecoveryOutput.match(/codex-composer-rendered:20/gu)?.length ?? 0,
  1
)
assert.equal(
  promptRecoveryOutput.match(/codex-submit:crash-between-phases:accepted/gu)?.length ?? 0,
  1
)
assert.equal(
  promptRecovered.agentSession(promptCrashCheckpoint.agentSessionId)
    .terminalPromptSubmission?.submit.acknowledged,
  true
)
await promptRecovered.stopAgent(promptCrashCheckpoint.agentSessionId)
await promptRecovered.dispose()

const acpStore = new AgentMuxFileAgentSessionStore()
const acpSession = {
  kind: 'agent',
  agentSessionId: 'acp-semantic',
  agentId: 'codex',
  hostId: 'local',
  workspacePath: process.cwd(),
  run: { runId: 'acp-synthetic-run' },
  retiredRuns: [],
  hookBindingId: 'acp-synthetic-binding',
  outputCursorBytes: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  nativeHandle: { kind: 'acp', adapterId: 'packed-acp', sessionId: 'packed-native' }
}
await acpStore.compareAndSwap(null, acpSession)
const resolvedAcp = JSON.parse((await cli([
  'resolve', 'acp-native', 'packed-acp', 'packed-native', '--json'
])).stdout)
assert.equal(resolvedAcp.agentSessionId, acpSession.agentSessionId)
await acpStore.compareAndSwap(acpSession, null)

const crashWorker = spawn(process.execPath, [lifecycleCrashFixture], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENTMUX_FAKE_CODEX: fakeCodex }
})
const crashCheckpoint = await firstJsonLine(crashWorker)
assert.equal(crashCheckpoint.type, 'run-started-before-commit')
const beforeCrashRecovery = await connectLocalAgentMux()
const uncommittedRun = (await beforeCrashRecovery.listRuns()).find(
  (run) => run.runId === crashCheckpoint.runId
)
assert.equal(uncommittedRun?.state, 'running')
assert.ok(uncommittedRun?.pid)
await beforeCrashRecovery.dispose()
crashWorker.kill('SIGKILL')
await once(crashWorker, 'exit')
const afterCrashRecovery = await connectLocalAgentMux()
assert.deepEqual(afterCrashRecovery.agentSessions(), [])
assert.equal((await afterCrashRecovery.listRuns()).some(
  (run) => run.runId === crashCheckpoint.runId
), false)
assert.equal(await processIsGone(uncommittedRun.pid), true)
assert.throws(
  () => afterCrashRecovery.resolveAgentSession({ kind: 'run', run: { runId: crashCheckpoint.runId } }),
  (error) => error?.code === 'STALE_AGENT_SESSION_BINDING'
)
await afterCrashRecovery.dispose()

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
  terminalHandshake: 'query-ack-prompt',
  stopEpochReadiness: [
    'missing-stop-rejected-before-payload',
    'tail-lookbehind-ready',
    'post-cursor-live-ready',
    'concurrent-single-consumer',
    'crash-recovered-once'
  ],
  promptCrashRecovery: true,
  cliResolveKinds: ['agent-session', 'provider-native', 'acp-native', 'run'],
  externalSwitch: true,
  naturalTerminalStop: true,
  crashRecovery: true,
  remote: 'unsupported'
})}\n`)
