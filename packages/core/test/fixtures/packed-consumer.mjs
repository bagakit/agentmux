import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import {
  AgentMuxCompositionServer,
  AgentMuxFileAgentSessionStore,
  connectLocalAgentMux,
  connectSshAgentMux
} from '@agentmux/core'
import { resolveAgentMuxRegion } from '@agentmux/core/composition'
import { normalizeAgentTimelineMutation } from '@agentmux/core/timeline'

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

const ownedChildren = new Set()
function spawnOwned(...args) {
  const child = spawn(...args)
  ownedChildren.add(child)
  child.once('exit', () => ownedChildren.delete(child))
  return child
}
process.once('exit', () => {
  for (const child of ownedChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})
assert.deepEqual(
  resolveAgentMuxRegion(
    [{
      viewId: 'packed-agent-view',
      regionId: 'packed-agent-region',
      kind: 'agent',
      agentSessionId: 'packed-agent',
      workspaceId: 'packed-workspace',
      tabGroupId: 'packed-tab-group'
    }],
    { kind: 'agent-session', agentSessionId: 'packed-agent' }
  ),
  {
    viewId: 'packed-agent-view',
    regionId: 'packed-agent-region',
    kind: 'agent',
    agentSessionId: 'packed-agent',
    workspaceId: 'packed-workspace',
    tabGroupId: 'packed-tab-group'
  }
)
assert.throws(
  () => normalizeAgentTimelineMutation({
    type: 'update',
    agentSessionId: 'packed-agent',
    itemId: 'assistant-1',
    updatedAt: 1,
    contentDelta: 'legacy delta'
  }),
  (error) => error?.code === 'INVALID_AGENT_TIMELINE'
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

async function firstJsonLine(child, description) {
  let timer
  try {
    return await Promise.race([
      (async () => {
        let buffer = ''
        for await (const chunk of child.stdout) {
          buffer += chunk.toString('utf8')
          const newline = buffer.indexOf('\n')
          if (newline >= 0) return JSON.parse(buffer.slice(0, newline))
        }
        throw new Error('Child exited before reporting its lifecycle checkpoint.')
      })(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          reject(new Error(`Timed out waiting for ${description} lifecycle checkpoint.`))
        }, 5_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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
assert.equal(
  output(firstEvents, run.runId).includes('agentmux-env:1:true:agentmux 0.1.0'),
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
const sharedReplay = await third.readRunReplay(run, Buffer.byteLength('prefix:'))
assert.equal(sharedReplay.replay[0]?.startByte, Buffer.byteLength('prefix:'))
assert.equal(sharedReplay.replay.map((event) => event.data).join('').includes('😀:tail'), true)
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

const cli = async (args, env = {}) => await execFileAsync(agentmuxCli, args, {
  timeout: 15_000,
  maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, ...env }
})
let codexFirst = await connectLocalAgentMux()
const codexFirstEvents = []
const codexTimelinePublicationSnapshots = []
codexFirst.onEvent((event) => {
  codexFirstEvents.push(event)
  if (event.type === 'agent-timeline') {
    codexTimelinePublicationSnapshots.push(
      codexFirst.sessionTimeline(event.agentSessionId).then((snapshot) => ({ event, snapshot }))
    )
  }
})
const codex = await codexFirst.createAgent({
  agentSessionId: 'codex-semantic-1',
  createOperationId: `packed-codex-${crypto.randomUUID()}`,
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  prompt: 'first',
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_PROMPT_RENDER_MODE: 'historical-match' }
})
assert.equal('hookBindingId' in codex, false)
assert.equal('hookToken' in codex, false)
assert.equal('hookBindingId' in codexFirst.agentSessions()[0], false)
assert.equal('hookToken' in codexFirst.agentSessions()[0], false)
const codexSubject = (await codexFirst.runtimeProjection()).subjects.find((subject) => subject.kind === 'agent')
assert.ok(codexSubject)
assert.equal('hookBindingId' in codexSubject.agentSession, false)
assert.equal('hookToken' in codexSubject.agentSession, false)
assert.deepEqual(codex.terminalHandshake, {
  run: { runId: codex.run.runId },
  operationId: codex.terminalHandshake?.operationId,
  inputByteRange: { startByte: 0, endByte: 5 },
  acknowledged: true
})
assert.ok(codex.terminalHandshake.operationId)
const codexAttachment = await codexFirst.reattachAgent(codex.agentSessionId, 0)
const codexSharedReplay = await codexFirst.readRunReplay(codex.run, 0)
assert.equal(codexSharedReplay.run.kind, 'agent')
assert.equal(codexSharedReplay.run.agentSessionId, codex.agentSessionId)
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
const initialTimeline = await codexFirst.sessionTimeline(codex.agentSessionId)
const initialTimelineEvents = codexFirstEvents.filter((event) => (
  event.type === 'agent-timeline' && event.agentSessionId === codex.agentSessionId
))
assert.ok(initialTimeline.revision > 0)
assert.equal(initialTimeline.agentSessionId, codex.agentSessionId)
assert.equal(initialTimelineEvents.length, initialTimeline.revision)
assert.deepEqual(
  initialTimelineEvents.map((event) => event.revision).sort((left, right) => left - right),
  Array.from({ length: initialTimeline.revision }, (_value, index) => index + 1)
)
assert.equal(initialTimeline.items.some((item) => (
  item.kind === 'user_message' && item.source === 'user' && item.content === 'first'
)), true)
assert.equal(initialTimeline.items.some((item) => (
  item.kind === 'permission' && item.source === 'native-hook' &&
  item.toolName === 'request_user_input'
)), true)
for (const publication of await Promise.all(codexTimelinePublicationSnapshots)) {
  assert.equal(publication.snapshot.agentSessionId, publication.event.agentSessionId)
  assert.ok(publication.snapshot.revision >= publication.event.revision)
}
const acknowledgedThroughByte = (await codexFirst.statusAgent(codex.agentSessionId)).run.latestOutputBytes
assert.ok(acknowledgedThroughByte > 0)
await codexFirst.acknowledgeAgentOutput(codex.agentSessionId, acknowledgedThroughByte)
await codexFirst.acknowledgeAgentOutput(codex.agentSessionId, acknowledgedThroughByte - 1)
assert.equal(codexFirst.agentSession(codex.agentSessionId).outputCursorBytes, acknowledgedThroughByte)
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

const cliStatus = JSON.parse((await cli(['session', 'status', codex.agentSessionId])).stdout)
assert.equal(cliStatus.schemaVersion, 1)
assert.equal(cliStatus.operation, 'session.status')
assert.equal(cliStatus.result.status.session.agentSessionId, codex.agentSessionId)
assert.equal(cliStatus.result.status.run.runId, codex.run.runId)
const cliList = JSON.parse((await cli(['session', 'list'])).stdout)
assert.equal(cliList.operation, 'session.list')
assert.equal(cliList.result.sessions.length, 1)
assert.equal(cliList.result.sessions[0].session.agentSessionId, codex.agentSessionId)
for (const args of [
  ['agent-session', codex.agentSessionId],
  ['provider-native', 'codex', 'native-codex-semantic-1'],
  ['run', codex.run.runId]
]) {
  const resolved = JSON.parse((await cli(['session', 'resolve', ...args])).stdout)
  assert.equal(resolved.operation, 'session.resolve')
  assert.equal(resolved.result.session.agentSessionId, codex.agentSessionId)
}
const compositionRequests = []
const agentRegion = {
  viewId: 'packed-agent-view',
  regionId: 'packed-agent-region',
  kind: 'agent',
  agentSessionId: codex.agentSessionId,
  workspaceId: 'packed-workspace',
  tabGroupId: 'packed-tab-group'
}
const terminalRegion = {
  viewId: 'packed-terminal-view',
  regionId: 'packed-terminal-region',
  kind: 'terminal',
  runId: 'packed-terminal-run',
  workspaceId: 'packed-workspace',
  tabGroupId: 'packed-tab-group'
}
const compositionServer = new AgentMuxCompositionServer({
  async execute(request) {
    compositionRequests.push(request)
    if (request.operation === 'context') {
      return {
        operation: request.operation,
        context: {
          agentSessionId: request.caller.agentSessionId,
          workspaceId: agentRegion.workspaceId,
          viewId: agentRegion.viewId,
          regionId: agentRegion.regionId,
          tabGroupId: agentRegion.tabGroupId,
          regions: [{
            regionId: agentRegion.regionId,
            kind: 'agent',
            providerId: 'codex',
            executorId: 'codex',
            agentSessionId: request.caller.agentSessionId,
            bounds: { x: 0, y: 0, width: 1, height: 1 }
          }],
          executors: [{ executorId: 'codex', label: 'Codex', providerId: 'codex', available: true }]
        }
      }
    }
    if (request.operation === 'region.focus') {
      return {
        operation: request.operation,
        region: request.regionId === terminalRegion.regionId ? terminalRegion : agentRegion
      }
    }
    if (request.operation === 'region.open') {
      return {
        operation: request.operation,
        region: {
          ...agentRegion,
          viewId: 'packed-opened-view',
          regionId: 'packed-opened-region',
          agentSessionId: request.agentSessionId
        }
      }
    }
    if (request.operation === 'launch') {
      return {
        operation: request.operation,
        agentSessionId: 'packed-launched-session',
        region: {
          ...agentRegion,
          regionId: 'packed-launched-region',
          agentSessionId: 'packed-launched-session'
        }
      }
    }
    throw Object.assign(new Error('Unsupported packed Composition request.'), {
      code: 'COMPOSITION_OPERATION_UNAVAILABLE'
    })
  }
})
await compositionServer.start()
const managedEnv = { AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: codex.agentSessionId }
const cliContext = JSON.parse((await cli(['context'], managedEnv)).stdout)
assert.equal(cliContext.operation, 'context')
assert.equal(cliContext.result.context.regionId, agentRegion.regionId)
const launchedRegion = JSON.parse((await cli([
  'launch', '--agent', 'codex', '--prompt', '--help', '--placement', 'split-right', '--relative-to', 'self'
], managedEnv)).stdout)
assert.equal(launchedRegion.operation, 'launch')
assert.equal(launchedRegion.result.region.regionId, 'packed-launched-region')
const openedRegion = JSON.parse((await cli([
  'region', 'open', '--session', codex.agentSessionId, '--placement', 'tab', '--relative-to', agentRegion.regionId
], managedEnv)).stdout)
assert.equal(openedRegion.operation, 'region.open')
assert.equal(openedRegion.result.region.regionId, 'packed-opened-region')
const focusedRegion = JSON.parse((await cli([
  'region', 'focus', '--region', 'packed-terminal-region'
])).stdout)
assert.equal(focusedRegion.operation, 'region.focus')
assert.deepEqual(focusedRegion.result.region, terminalRegion)
assert.deepEqual(compositionRequests.map((request) => request.operation), [
  'context', 'launch', 'region.open', 'region.focus'
])
assert.equal(compositionRequests[1].executorId, 'codex')
assert.equal(compositionRequests[1].prompt, '--help')
await compositionServer.stop()
const cliAttachment = JSON.parse((await cli([
  'session', 'output', codex.agentSessionId, '--after-byte', '0'
])).stdout)
assert.equal(cliAttachment.result.session.agentSessionId, codex.agentSessionId)
const followReader = spawnOwned(agentmuxCli, [
  'session', 'output', codex.agentSessionId, '--after-byte', '0', '--follow'
], { stdio: ['ignore', 'pipe', 'pipe'] })
const followAttached = await firstJsonLine(followReader, 'session output follower')
assert.deepEqual(
  {
    schemaVersion: followAttached.schemaVersion,
    operation: followAttached.operation,
    event: followAttached.event,
    agentSessionId: followAttached.result.session.agentSessionId
  },
  {
    schemaVersion: 1,
    operation: 'session.output',
    event: 'attached',
    agentSessionId: codex.agentSessionId
  }
)
followReader.kill('SIGINT')
await once(followReader, 'exit')
assert.equal((await cli(['session', 'status', codex.agentSessionId])).stdout.includes('"running"'), true)
await cli(['session', 'send', codex.agentSessionId, '--text', 'continue'])
await cli(['session', 'interrupt', codex.agentSessionId])

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
assert.equal(codexReplayText.includes('codex-historical-prompt-match'), true)
assert.equal(codexReplayText.includes('codex-ignored-early-enter'), false)
assert.equal(codexReplayText.includes('codex-interrupt'), true)
assert.equal(codexReplayText.includes('\u001b[?7u'), false)
assert.equal(codexReplayText.includes('\u001b[13u'), false)
const timelineAfterSubmittedPrompt = await codexSecond.sessionTimeline(codex.agentSessionId)
assert.ok(timelineAfterSubmittedPrompt.revision > initialTimeline.revision)
assert.equal(timelineAfterSubmittedPrompt.items.some((item) => (
  item.kind === 'user_message' && item.source === 'user' && item.content === 'continue'
)), true)
const handshakeQueryIndex = codexReplayText.indexOf('\u001b[?u')
const handshakeAckIndex = codexReplayText.indexOf('codex-handshake:kitty-flags-0')
const initialPromptIndex = codexReplayText.indexOf('codex-ready:first')
const submittedPromptIndex = codexReplayText.indexOf('codex-submit:continue:accepted')
assert.ok(handshakeQueryIndex >= 0)
assert.ok(handshakeAckIndex > handshakeQueryIndex)
assert.ok(initialPromptIndex > handshakeAckIndex)
assert.ok(submittedPromptIndex > handshakeAckIndex)
try {
  await waitFor('next ready Stop receipt', () => {
    const receipt = codexSecond.agentSession(codex.agentSessionId).terminalStopReceipt
    return receipt?.id !== initialStopReceipt.id && receipt?.readyThroughByte !== undefined
  })
} catch (error) {
  const session = codexSecond.agentSession(codex.agentSessionId)
  const agentErrors = codexSecondEvents.filter((event) => event.type === 'agent-error')
  const debugAttachment = JSON.parse((await cli([
    'session', 'output', codex.agentSessionId, '--after-byte', '0'
  ])).stdout)
  throw new Error(`${error.message}\n${JSON.stringify({
    terminalStopReceipt: session.terminalStopReceipt,
    terminalPromptSubmission: session.terminalPromptSubmission,
    agentErrors,
    outputTail: debugAttachment.result.replay.map((event) => event.data).join('').slice(-1_500)
  }, null, 2)}`)
}
await codexSecond.submitAgentPrompt({
  agentSessionId: codex.agentSessionId,
  operationId: 'packed-codex-exit',
  prompt: 'exit'
})
await waitFor('Codex Run exit', async () => (
  (await codexSecond.statusAgent(codex.agentSessionId)).run.state === 'exited'
))
await codexSecond.dispose()

const continuityClient = await connectLocalAgentMux()
const continuityContender = await connectLocalAgentMux()
const continuityTimelineBefore = await continuityClient.sessionTimeline(codex.agentSessionId)
const continuityResults = await Promise.all([
  continuityContender.ensureAgentContinuity({
    agentSessionId: codex.agentSessionId,
    expectedRun: codex.run,
    operationId: 'packed-continuity-owner',
    commandOverride: fakeCodex
  }),
  continuityClient.ensureAgentContinuity({
    agentSessionId: codex.agentSessionId,
    expectedRun: codex.run,
    operationId: 'packed-continuity-contender',
    commandOverride: fakeCodex
  })
])
assert.deepEqual(
  continuityResults.map((result) => result.kind).sort(),
  ['conflict', 'resumed']
)
const continuityConflict = continuityResults.find((result) => result.kind === 'conflict')
assert.equal(continuityConflict?.evidence.kind, 'hook-ingress-owner')
const continuityResumed = continuityResults.find((result) => result.kind === 'resumed')
assert.ok(continuityResumed)
assert.equal(continuityResumed.session.agentSessionId, codex.agentSessionId)
assert.notEqual(continuityResumed.run.runId, codex.run.runId)
const continuityRuns = (await continuityClient.listRuns()).filter((run) => (
  run.kind === 'agent' && run.agentSessionId === codex.agentSessionId
))
assert.deepEqual(continuityRuns.map((run) => run.runId), [continuityResumed.run.runId])
const disconnectedContinuity = await connectLocalAgentMux()
disconnectedContinuity.disconnect()
await assert.rejects(
  disconnectedContinuity.ensureAgentContinuity({
    agentSessionId: codex.agentSessionId,
    expectedRun: continuityResumed.run,
    operationId: 'packed-continuity-transport-error',
    commandOverride: fakeCodex
  }),
  (error) => error?.code === 'CTXMUX_DISCONNECTED'
)
assert.deepEqual(
  (await continuityClient.listRuns()).filter((run) => (
    run.kind === 'agent' && run.agentSessionId === codex.agentSessionId
  )).map((run) => run.runId),
  [continuityResumed.run.runId]
)
await disconnectedContinuity.dispose()
const continuityAttachment = await continuityClient.reattachAgent(codex.agentSessionId, 0)
const continuityEvents = []
continuityClient.onEvent((event) => continuityEvents.push(event))
await waitFor('promptless native continuity', () => (
  `${continuityAttachment.attachment.replay.map((event) => event.data).join('')}` +
  output(continuityEvents, continuityResumed.run.runId)
).includes('codex-ready:'))
await waitFor('promptless continuity Stop receipt', () => (
  continuityClient.agentSession(codex.agentSessionId).terminalStopReceipt?.readyThroughByte !== undefined
))
const continuityTimelineAfter = await continuityClient.sessionTimeline(codex.agentSessionId)
assert.deepEqual(
  continuityTimelineAfter.items.filter((item) => item.kind === 'user_message').map((item) => item.content),
  continuityTimelineBefore.items.filter((item) => item.kind === 'user_message').map((item) => item.content)
)
await continuityClient.submitAgentPrompt({
  agentSessionId: codex.agentSessionId,
  operationId: 'packed-continuity-exit',
  prompt: 'exit'
})
await waitFor('promptless continuity Run exit', async () => (
  (await continuityClient.statusAgent(codex.agentSessionId)).run.state === 'exited'
))
await continuityClient.dispose()
await continuityContender.dispose()

const resumeRollbackDelegate = new AgentMuxFileAgentSessionStore()
let failedResumeReservation = null
let failedResumeRetiredRuns = []
const resumeRollbackStore = {
  load: async () => await resumeRollbackDelegate.load(),
  loadRetiredRuns: async () => await resumeRollbackDelegate.loadRetiredRuns(),
  loadRetiredAgentSessions: async () => await resumeRollbackDelegate.loadRetiredAgentSessions(),
  compareAndSwap: async (...args) => await resumeRollbackDelegate.compareAndSwap(...args),
  reserveLifecycle: async (reservation) => await resumeRollbackDelegate.reserveLifecycle(reservation),
  claimStaleLifecycles: async (claim) => await resumeRollbackDelegate.claimStaleLifecycles(claim),
  retireRuns: async (runs) => await resumeRollbackDelegate.retireRuns(runs),
  loadTimeline: async (agentSessionId) => await resumeRollbackDelegate.loadTimeline(agentSessionId),
  applyTimelineMutation: async (...args) => await resumeRollbackDelegate.applyTimelineMutation(...args),
  async commitLifecycle(reservation, next) {
    if (reservation.kind === 'resume') throw new Error('packed resume commit failed')
    await resumeRollbackDelegate.commitLifecycle(reservation, next)
  },
  async releaseLifecycle(reservation, retiredRuns) {
    if (reservation.kind === 'resume') {
      failedResumeReservation = reservation
      failedResumeRetiredRuns = retiredRuns ?? []
      throw new Error('packed resume rollback receipt failed')
    }
    await resumeRollbackDelegate.releaseLifecycle(reservation, retiredRuns)
  }
}
const resumeRollbackClient = await connectLocalAgentMux({ store: resumeRollbackStore })
const runsBeforeResumeRollback = new Set((await resumeRollbackClient.listRuns()).map((run) => run.runId))
let resumeRollbackError = null
try {
  await resumeRollbackClient.ensureAgentContinuity({
    agentSessionId: codex.agentSessionId,
    expectedRun: continuityResumed.run,
    operationId: 'packed-continuity-resume-commit-failure',
    commandOverride: fakeCodex
  })
} catch (error) {
  resumeRollbackError = error
}
assert.ok(resumeRollbackError instanceof AggregateError)
assert.ok(resumeRollbackError.errors.some((error) => `${error}`.includes('packed resume commit failed')))
assert.ok(resumeRollbackError.errors.some((error) => `${error}`.includes('packed resume rollback receipt failed')))
const rollbackRuns = (await resumeRollbackClient.listRuns()).filter((run) => !runsBeforeResumeRollback.has(run.runId))
assert.equal(rollbackRuns.length, 1)
assert.notEqual(rollbackRuns[0].state, 'running')
assert.equal(
  resumeRollbackClient.agentSession(codex.agentSessionId).run.runId,
  continuityResumed.run.runId
)
assert.ok(failedResumeReservation)
await resumeRollbackDelegate.releaseLifecycle(failedResumeReservation, failedResumeRetiredRuns)
await resumeRollbackClient.dispose()

const resumePrompt = 'packed native resume prompt'
const resumeResult = JSON.parse((await cli([
  'session', 'resume', codex.agentSessionId, '--text', resumePrompt
])).stdout)
const resumed = resumeResult.result.session
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
const resumedTimeline = await codexThird.sessionTimeline(resumed.agentSessionId)
assert.equal(resumedTimeline.agentSessionId, codex.agentSessionId)
assert.ok(resumedTimeline.revision > timelineAfterSubmittedPrompt.revision)
assert.equal(resumedTimeline.items.some((item) => (
  item.kind === 'user_message' && item.source === 'user' && item.content === resumePrompt
)), true)
assert.equal(resumedTimeline.items.some((item) => item.content === 'continue'), true)
assert.equal(resumedTimeline.items.some((item) => item.id.startsWith(`${resumed.run.runId}:`)), true)
await waitFor('resumed Codex ready Stop receipt', () => (
  codexThird.agentSession(resumed.agentSessionId).terminalStopReceipt?.readyThroughByte !== undefined
))
assert.throws(
  () => codexThird.resolveAgentSession({ kind: 'run', run: codex.run }),
  (error) => error?.code === 'STALE_AGENT_SESSION_BINDING'
)
const reboundBeforeStaleResize = (await codexThird.statusAgent(resumed.agentSessionId)).run
assert.equal(reboundBeforeStaleResize.runId, resumed.run.runId)
await assert.rejects(
  codexThird.resizeAgent(resumed.agentSessionId, codex.run, 111, 43),
  (error) => error?.code === 'STALE_AGENT_SESSION'
)
const reboundAfterStaleResize = (await codexThird.statusAgent(resumed.agentSessionId)).run
assert.deepEqual(
  {
    runId: reboundAfterStaleResize.runId,
    cols: reboundAfterStaleResize.cols,
    rows: reboundAfterStaleResize.rows
  },
  {
    runId: reboundBeforeStaleResize.runId,
    cols: reboundBeforeStaleResize.cols,
    rows: reboundBeforeStaleResize.rows
  }
)
assert.deepEqual(
  await codexThird.resizeAgent(resumed.agentSessionId, resumed.run, 109, 41),
  { runId: resumed.run.runId, cols: 109, rows: 41 }
)
await assert.rejects(
  codexThird.stopAgent(resumed.agentSessionId, codex.run),
  (error) => error?.code === 'STALE_AGENT_SESSION'
)
const reboundAfterStaleStop = (await codexThird.statusAgent(resumed.agentSessionId)).run
assert.deepEqual(
  {
    runId: reboundAfterStaleStop.runId,
    state: reboundAfterStaleStop.state
  },
  { runId: resumed.run.runId, state: 'running' }
)
await assert.rejects(
  cli(['session', 'resolve', 'run', codex.run.runId]),
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
await cli(['session', 'stop', resumed.agentSessionId])
const codexStopped = await connectLocalAgentMux()
assert.deepEqual(codexStopped.agentSessions(), [])
const retiredContinuity = await codexStopped.ensureAgentContinuity({
  agentSessionId: resumed.agentSessionId,
  expectedRun: resumed.run,
  operationId: 'packed-continuity-retired'
})
assert.deepEqual({
  ...retiredContinuity,
  evidence: { kind: retiredContinuity.evidence.kind }
}, {
  kind: 'retired',
  agentSessionId: resumed.agentSessionId,
  previousRun: resumed.run,
  evidence: { kind: 'user-retired' }
})
assert.equal(typeof retiredContinuity.evidence.observedAt, 'number')
await codexStopped.dispose()

const literalPromptClient = await connectLocalAgentMux()
const literalPromptEvents = []
literalPromptClient.onEvent((event) => literalPromptEvents.push(event))
const literalPromptAgent = await literalPromptClient.createAgent({
  agentSessionId: 'codex-literal-option-prompt',
  createOperationId: 'packed-codex-literal-option-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex
})
await literalPromptClient.reattachAgent(literalPromptAgent.agentSessionId, 0)
await waitFor('literal prompt Agent ready Stop receipt', () => (
  literalPromptClient.agentSession(literalPromptAgent.agentSessionId)
    .terminalStopReceipt?.readyThroughByte !== undefined
))
await cli(['session', 'send', literalPromptAgent.agentSessionId, '--text', '--help'])
await waitFor('literal option-like prompt submitted', () => (
  output(literalPromptEvents, literalPromptAgent.run.runId).includes('codex-submit:--help:accepted')
))
await literalPromptClient.dispose()
const literalPromptCleanup = await connectLocalAgentMux()
await literalPromptCleanup.stopAgent(literalPromptAgent.agentSessionId, literalPromptAgent.run)
await literalPromptCleanup.dispose()

const noStopClient = await connectLocalAgentMux()
const noStopEvents = []
noStopClient.onEvent((event) => noStopEvents.push(event))
const noStop = await noStopClient.createAgent({
  agentSessionId: 'codex-no-stop',
  createOperationId: 'packed-codex-no-stop-create',
  providerId: 'codex',
  executorId: 'codex',
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
assert.equal((await noStopClient.sessionTimeline(noStop.agentSessionId)).items.some((item) => (
  item.kind === 'user_message' && item.content === 'must-not-reach-pty'
)), false)
assert.equal((await noStopClient.statusAgent(noStop.agentSessionId)).run.acceptedInputBytes, 5)
assert.equal(output(noStopEvents, noStop.run.runId).includes('codex-dropped-pre-ready-payload'), false)
await noStopClient.stopAgent(noStop.agentSessionId, noStop.run)
await noStopClient.dispose()

const afterCursorClient = await connectLocalAgentMux()
const afterCursorEvents = []
afterCursorClient.onEvent((event) => afterCursorEvents.push(event))
const afterCursor = await afterCursorClient.createAgent({
  agentSessionId: 'codex-frame-after-cursor',
  createOperationId: 'packed-codex-after-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'after' }
})
const afterCursorAttachment = await afterCursorClient.reattachAgent(afterCursor.agentSessionId, 0)
const afterCursorReplay = afterCursorAttachment.attachment.replay.map((event) => event.data).join('')
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
await waitFor('after-cursor fake control readiness', () => (
  `${afterCursorReplay}${output(afterCursorEvents, afterCursor.run.runId)}`
    .includes('codex-controlled-ready-pending')
))
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
await afterCursorClient.stopAgent(afterCursor.agentSessionId, afterCursor.run)
await afterCursorClient.dispose()

const assistantMarkerClient = await connectLocalAgentMux()
const assistantMarkerEvents = []
assistantMarkerClient.onEvent((event) => assistantMarkerEvents.push(event))
const assistantMarker = await assistantMarkerClient.createAgent({
  agentSessionId: 'codex-assistant-marker',
  createOperationId: 'packed-codex-assistant-marker-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'after-assistant' }
})
const assistantMarkerAttachment = await assistantMarkerClient.reattachAgent(
  assistantMarker.agentSessionId,
  0
)
const assistantMarkerReplay = assistantMarkerAttachment.attachment.replay
  .map((event) => event.data)
  .join('')
const assistantMarkerStop = await waitFor('Stop with assistant marker but no composer', () => (
  assistantMarkerClient.agentSession(assistantMarker.agentSessionId).terminalStopReceipt ?? null
))
assert.equal(assistantMarkerStop.readyThroughByte, undefined)
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(
  assistantMarkerClient.agentSession(assistantMarker.agentSessionId).terminalStopReceipt?.readyThroughByte,
  undefined
)
await assert.rejects(
  assistantMarkerClient.submitAgentPrompt({
    agentSessionId: assistantMarker.agentSessionId,
    operationId: 'packed-assistant-marker-too-early',
    prompt: 'must-not-reach-pty'
  }),
  (error) => error?.code === 'AGENT_PROMPT_NOT_READY'
)
await waitFor('assistant-marker fake control readiness', () => (
  `${assistantMarkerReplay}${output(assistantMarkerEvents, assistantMarker.run.runId)}`
    .includes('codex-controlled-ready-pending')
))
await assistantMarkerClient.writeAgent(assistantMarker.agentSessionId, '\u001d')
await waitFor('real composer after misleading assistant marker', () => (
  assistantMarkerClient.agentSession(assistantMarker.agentSessionId)
    .terminalStopReceipt?.readyThroughByte ?? null
))
await assistantMarkerClient.stopAgent(assistantMarker.agentSessionId, assistantMarker.run)
await assistantMarkerClient.dispose()

const concurrentOwner = await connectLocalAgentMux()
const concurrent = await concurrentOwner.createAgent({
  agentSessionId: 'codex-concurrent-stop',
  createOperationId: 'packed-codex-concurrent-create',
  providerId: 'codex',
  executorId: 'codex',
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
await concurrentOwner.stopAgent(concurrent.agentSessionId, concurrent.run)
await concurrentOwner.dispose()

const promptCrashWorker = spawnOwned(process.execPath, [promptCrashFixture], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENTMUX_FAKE_CODEX: fakeCodex }
})
const promptCrashCheckpoint = await firstJsonLine(promptCrashWorker, 'prompt crash worker')
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
await promptRecovered.stopAgent(
  promptCrashCheckpoint.agentSessionId,
  { runId: promptCrashCheckpoint.runId }
)
await promptRecovered.dispose()

const acpStore = new AgentMuxFileAgentSessionStore()
const acpSession = {
  kind: 'agent',
  agentSessionId: 'acp-semantic',
  providerId: 'codex',
  executorId: 'codex',
  hostId: 'local',
  workspacePath: process.cwd(),
  run: { runId: '00000000-0000-4000-8000-000000000001' },
  retiredRuns: [],
  hookBindingId: 'acp-synthetic-binding',
  hookToken: 'acp-synthetic-token',
  outputCursorBytes: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  nativeHandle: { kind: 'acp', adapterId: 'packed-acp', sessionId: 'packed-native' }
}
await acpStore.compareAndSwap(null, acpSession)
const resolvedAcp = JSON.parse((await cli([
  'session', 'resolve', 'acp-native', 'packed-acp', 'packed-native'
])).stdout)
assert.equal(resolvedAcp.result.session.agentSessionId, acpSession.agentSessionId)
const missingStopClient = await connectLocalAgentMux()
await missingStopClient.stopAgent(acpSession.agentSessionId, acpSession.run)
assert.equal((await missingStopClient.ensureAgentContinuity({
  agentSessionId: acpSession.agentSessionId,
  expectedRun: acpSession.run,
  operationId: 'packed-missing-run-retirement'
})).kind, 'retired')
assert.equal((await missingStopClient.ensureAgentContinuity({
  agentSessionId: 'another-agent-session',
  expectedRun: acpSession.run,
  operationId: 'packed-cross-session-retirement'
})).kind, 'unavailable')
await missingStopClient.dispose()

const crashWorker = spawnOwned(process.execPath, [lifecycleCrashFixture], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENTMUX_FAKE_CODEX: fakeCodex }
})
const crashCheckpoint = await firstJsonLine(crashWorker, 'lifecycle crash worker')
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
const cleanupSentinel = await third.createTerminal({
  workspacePath: process.cwd(),
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1_000)']
})
assert.ok(cleanupSentinel.pid)
await third.dispose()

process.stdout.write(`${JSON.stringify({
  runId: run.runId,
  pid: originalPid,
  replayStartByte: suffix.replay[0]?.startByte,
  sharedReplayWhileAttached: true,
  agentSharedReplayWhileAttached: true,
  multiViewAcknowledgementMonotonic: true,
  resize: '101x37',
  interruptStillLive: true,
  dedupOccurrences,
  stubbornPids,
  codexSemanticSession: codex.agentSessionId,
  codexNativeSession: 'native-codex-semantic-1',
  semanticContinuity: 'conflict-resumed-retired',
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
  cliComposition: true,
  naturalTerminalStop: true,
  crashRecovery: true,
  cleanupSentinelPid: cleanupSentinel.pid,
  remote: 'unsupported'
})}\n`)
