import { fixturePath } from './helpers/fixture-values.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentPromptSubmissionCoordinator } from '../src/prompt-submission.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'

const clients: AgentMuxClient[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
})

type Input = { operationId: string; expectedByte: number; data: string | Uint8Array }
type Ack = { run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }
type Internals = {
  connected: boolean
  registry: AgentMuxAgentSessionRegistry
  kernel: {
    isConnected(): boolean
    identity(): { daemonInstanceId: string }
    status(runId: string): Promise<CtxmuxAdapterRun>
    input(runId: string, input: Input): Promise<Ack>
  }
  promptSubmission: AgentPromptSubmissionCoordinator
  screenEvidence: AgentScreenEvidenceStore
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(singlePhase = false) {
  const template = new AgentProviderRegistry().get('codex')
  const { providerFork: _fork, promptExecution: _immediate, ...capabilities } = template.catalog.capabilities
  const generic = defineAgentProvider({
    catalog: { ...template.catalog, capabilities, id: 'generic', label: 'Generic', executable: 'generic', expectedProcess: 'generic', hookStrategy: { kind: 'native', installation: 'unmanaged' } },
    hook: template.hook,
    buildArgs: (_prompt, args) => [...args]
  })
  const providerId = singlePhase ? generic.id : 'codex'
  const store = new AgentMuxMemoryAgentSessionStore()
  const initial: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'bound-agent', providerId, executorId: providerId,
    hostId: 'local', workspacePath: fixturePath("repo"), run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'bound-binding', hookToken: 'bound-token',
    createdAt: 1, updatedAt: 100,
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: 100, stateEnteredAt: 100 }
  }
  await store.compareAndSwap(null, initial)
  const cursors = new Map<string, number>()
  const accepted = new Map<string, Ack>()
  const writes: Array<{ runId: string } & Input> = []
  let beforeStatus: (() => Promise<void>) | undefined
  let beforeAck: (() => Promise<void>) | undefined
  const run = (runId: string): CtxmuxAdapterRun => ({
    nativeService: null,
    runId, lifecycleOperationId: null, program: 'codex', args: [], workspacePath: fixturePath("repo"),
    pid: runId === 'original-run' ? 123 : 124, state: { type: 'running' }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursors.get(runId) ?? 0
  })
  const setup = async () => {
    const client = new AgentMuxClient({ store, ...(singlePhase ? { providers: [generic] } : {}) })
    clients.push(client)
    const inner = client as unknown as Internals
    await inner.registry.load('local')
    inner.connected = true
    inner.kernel.isConnected = () => true
    inner.kernel.identity = () => ({ daemonInstanceId: 'bound-daemon' })
    inner.kernel.status = async (runId) => {
      const snapshot = run(runId)
      await beforeStatus?.()
      return snapshot
    }
    inner.kernel.input = async (runId, input) => {
      const key = `${runId}:${input.operationId}`
      const prior = accepted.get(key)
      if (prior) return prior
      writes.push({ runId, ...input })
      const endByte = input.expectedByte + (typeof input.data === 'string' ? Buffer.byteLength(input.data) : input.data.byteLength)
      cursors.set(runId, endByte)
      const receipt = { run: run(runId), appliedByteRange: { startByte: input.expectedByte, endByte } }
      accepted.set(key, receipt)
      await beforeAck?.()
      return receipt
    }
    vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(1)
    const events: AgentMuxClientEvent[] = []
    client.onEvent((event) => { events.push(event) })
    return { client, inner, events }
  }
  const current = await setup()
  const replace = async (newRunId = 'replacement-run', refreshRegistry = true) => {
    const previous = (await loadAgentSessions(store))[0]!
    const next = { ...initial, run: { runId: newRunId }, updatedAt: previous.updatedAt + 1 }
    await store.compareAndSwap(previous, next)
    if (refreshRegistry) await current.inner.registry.load('local')
  }
  const input = { ...agentPromptCondition(current.client.agentSession('bound-agent')), agentSessionId: 'bound-agent', expectedRun: { runId: 'original-run' }, operationId: 'bound-operation', prompt: 'hello' }
  return { ...current, store, run, writes, input, replace, freshClient: setup,
    beforeStatus: (callback?: () => Promise<void>) => { beforeStatus = callback },
    beforeAck: (callback?: () => Promise<void>) => { beforeAck = callback } }
}

describe('conditional exact Run prompt admission', () => {
  it.each([false, true])('rejects a stale bound target before planning, claim or input (single phase=%s)', async (singlePhase) => {
    const h = await fixture(singlePhase)
    await h.replace()
    expect(h.client.agentSession('bound-agent').run).toEqual({ runId: 'replacement-run' })
    expect(h.run('replacement-run').state).toEqual({ type: 'running' })
    const before = await h.store.load()
    const planning = vi.spyOn(h.client.providers.get(singlePhase ? 'generic' : 'codex'), 'planPromptInput')
    await expect(h.client.submitAgentPrompt(h.input)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(planning).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
    expect(await h.store.load()).toEqual(before)
    expect((await h.store.loadTimeline('bound-agent')).items).toEqual([])
  })

  it.each([false, true])('accepts the matching target and replays its acknowledged transaction without duplicate bytes (single phase=%s)', async (singlePhase) => {
    const h = await fixture(singlePhase)
    await h.client.submitAgentPrompt(h.input)
    expect(h.writes.map(({ runId, data }) => ({ runId, data }))).toEqual(singlePhase
      ? [{ runId: 'original-run', data: 'hello\r' }]
      : [{ runId: 'original-run', data: 'hello' }, { runId: 'original-run', data: '\r' }])
    const firstWrites = [...h.writes]
    const restored = await h.freshClient()
    await restored.client.submitAgentPrompt(h.input)
    expect(h.writes).toEqual(firstWrites)
    expect((await h.store.loadTimeline('bound-agent')).items.map(({ id, content }) => ({ id, content })))
      .toEqual([{ id: 'prompt:bound-operation', content: 'hello' }])
    await h.replace()
    await restored.inner.registry.load('local')
    await expect(restored.client.submitAgentPrompt(h.input)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(h.writes).toEqual(firstWrites)
    expect(restored.client.agentSession('bound-agent').promptCompletionAdmission).toBeUndefined()
  })

  it.each([false, true])('captures the current Run for a fresh Session-addressed operation (single phase=%s)', async (singlePhase) => {
    const h = await fixture(singlePhase)
    await h.replace()
    await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession('bound-agent')), agentSessionId: 'bound-agent', operationId: 'fresh-operation', prompt: 'fresh' })
    expect(h.writes.map(({ runId, data }) => ({ runId, data }))).toEqual(singlePhase
      ? [{ runId: 'replacement-run', data: 'fresh\r' }]
      : [{ runId: 'replacement-run', data: 'fresh' }, { runId: 'replacement-run', data: '\r' }])
  })

  it('retains the existing exact Run fence while a bound prompt waits behind actual raw input', async () => {
    const h = await fixture()
    const acknowledged = deferred()
    const release = deferred()
    h.beforeAck(async () => { acknowledged.resolve(); await release.promise })
    const first = h.client.writeAgent({ agentSessionId: 'bound-agent', expectedRun: h.client.agentSession('bound-agent').run, data: 'x', source: 'user' })
    await acknowledged.promise
    const second = h.client.submitAgentPrompt(h.input).then(() => null, (error: unknown) => error)
    await h.replace()
    h.beforeAck()
    release.resolve()
    await expect(first).resolves.toMatchObject({ runId: 'original-run', acceptedThroughByte: 1 })
    expect(await second).toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(h.writes.map(({ runId, data }) => ({ runId, data }))).toEqual([{ runId: 'original-run', data: 'x' }])
    expect(h.client.agentSession('bound-agent').promptCompletionAdmission).toBeUndefined()
  })

  it.each([false, true])('retains the durable CAS fence when a different owner changes the Run during native status (single phase=%s)', async (singlePhase) => {
    const h = await fixture(singlePhase)
    h.beforeStatus(async () => { h.beforeStatus(); await h.replace('replacement-run', false) })
    await expect(h.client.submitAgentPrompt(h.input)).rejects.toMatchObject({
      code: 'STALE_AGENT_SESSION'
    })
    expect(h.writes).toEqual([])
    const durable = (await loadAgentSessions(h.store))[0]!
    expect(durable.run).toEqual({ runId: 'replacement-run' })
    expect(durable.promptCompletionAdmission).toBeUndefined()
    expect(durable.semanticStatus?.stateEnteredAt).toBe(100)
  })

  it.each([false, true])('attributes history to the acknowledged original Run when continuity changes before history recording (single phase=%s)', async (singlePhase) => {
    const h = await fixture(singlePhase)
    const originalSubmit = h.inner.promptSubmission.submitInputPlan.bind(h.inner.promptSubmission)
    let acceptedSubmission: AgentMuxStoredAgentSession | undefined
    vi.spyOn(h.inner.promptSubmission, 'submitInputPlan').mockImplementation(async (...args) => {
      const delivered = await originalSubmit(...args)
      acceptedSubmission = (await loadAgentSessions(h.store))[0]!
      await h.replace()
      return delivered
    })
    await expect(h.client.submitAgentPrompt(h.input)).resolves.toBeUndefined()
    if (singlePhase) expect(acceptedSubmission?.promptCompletionAdmission?.submissionId).toBe('bound-operation')
    else expect(acceptedSubmission?.terminalPromptSubmission?.submit.acknowledged).toBe(true)
    expect(h.client.agentSession('bound-agent').run).toEqual({ runId: 'replacement-run' })
    expect(h.writes.map(({ runId, data }) => ({ runId, data }))).toEqual(singlePhase
      ? [{ runId: 'original-run', data: 'hello\r' }]
      : [{ runId: 'original-run', data: 'hello' }, { runId: 'original-run', data: '\r' }])
    const history = h.events.filter((event) => event.type === 'agent-timeline')
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ evidence: { run: { runId: 'original-run' } },
      mutation: { type: 'append', item: { id: 'prompt:bound-operation', status: 'complete' } } })
    await expect(h.client.submitAgentPrompt(h.input)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(h.writes).toHaveLength(singlePhase ? 1 : 2)
  })
})

describe('saved future-message admission', () => {
  it('delegates a borrowed future-message save and occurrence through the finite original Host transport', async () => {
    const h = await fixture(true)
    h.inner.kernel.identity = () => ({ daemonInstanceId: 'bound-daemon', protocolVersion: 18, buildIdentity: 'private-future-host' })
    vi.spyOn(h.client, 'connect').mockResolvedValue()
    const saves = vi.spyOn(h.client, 'saveAgentFuturePromptIntent')
    const service = new AgentMuxHostedRuntimeService(h.client, null, () => hostedTestOwner(h.client))
    const invocations: unknown[] = []
    const producerDevice = { hostId: 'local', deviceId: 'original-device', name: 'Original device' }
    let receivingDevice = producerDevice
    const port = {
      call: async (method: string, params: unknown, options?: { signal?: AbortSignal }) => {
        const decoded = JSON.parse(JSON.stringify(params)); if (method === 'runtime.invoke') invocations.push(decoded.invocation)
        return JSON.parse(JSON.stringify(await service.call(method, decoded, { ...options, sourceDevice: receivingDevice })))
      },
      subscribe: async (method: string, params: unknown, handlers: { onInitial(value: unknown): void; onEvent(value: unknown): void; signal?: AbortSignal }) => {
        const stream = await service.subscribe(method, params, event => handlers.onEvent(JSON.parse(JSON.stringify(event))), handlers.signal ? { signal: handlers.signal } : {})
        handlers.onInitial(JSON.parse(JSON.stringify(stream.initial))); await stream.start?.()
        return { dispose: async () => await stream.dispose() }
      }
    } as unknown as AgentMuxHostedRpcPort
    const borrowed = await connectHostedAgentMux({ rpc: port })
    try {
      expect(borrowed.saveAgentFuturePromptIntent).toEqual(expect.any(Function))
      const saved = { agentSessionId: 'bound-agent', intentId: 'schedule-borrowed', operationId: 'borrowed-save', prompt: 'hello', active: true }
      await borrowed.saveAgentFuturePromptIntent(saved)
      expect(saves).toHaveBeenCalledExactlyOnceWith({ ...saved, sourceDevice: producerDevice })
      expect(invocations).toContainEqual({ method: 'saveAgentFuturePromptIntent', args: [saved] })
      expect((await loadAgentSessions(h.store))[0]!.futurePromptIntents!['schedule-borrowed']).toMatchObject({ operationId: 'borrowed-save', prompt: 'hello', active: true, message: { userContent: 'hello', sourceDevice: producerDevice } })
      receivingDevice = { hostId: 'local', deviceId: 'later-device', name: 'Later timer device' }
      await borrowed.submitAgentPrompt({ ...h.input, expectedInputByte: 0, expectedFutureIntent: { intentId: 'schedule-borrowed', occurrenceAt: 1000 } })
      expect(h.writes).toHaveLength(1)
      expect(h.client.agentSession('bound-agent').promptCompletionAdmission!.intent!.message).toMatchObject({ sourceDevice: producerDevice })
      const forged = await borrowed.saveAgentFuturePromptIntent({ ...saved, sourceDevice: receivingDevice }).then(() => undefined, error => error)
      expect(forged).toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      await borrowed.saveAgentFuturePromptIntent({ ...saved, active: false })
      expect((await loadAgentSessions(h.store))[0]!.futurePromptIntents!['schedule-borrowed']!.active).toBe(false)
      expect((await loadAgentSessions(h.store))[0]!.futurePromptIntents!['schedule-borrowed']!.message.sourceDevice).toEqual(producerDevice)
      expect(borrowed.runtimeOwnerIdentity()).toMatchObject({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' })
    } finally { await borrowed.dispose(); await service.dispose() }
  })
  it('authenticates future producer through original Core capabilities and freezes its first source across later callers', async () => {
    const h = await fixture(true), seed = (await loadAgentSessions(h.store))[0]!
    const first = issueAgentCapability(), later = issueAgentCapability()
    await h.store.compareAndSwap(null, { ...seed, agentSessionId: 'first-author', run: { runId: 'first-run' }, capabilityHash: hashAgentCapability(first) })
    await h.store.compareAndSwap(null, { ...seed, agentSessionId: 'later-author', run: { runId: 'later-run' }, capabilityHash: hashAgentCapability(later) })
    const request = { agentSessionId: 'bound-agent', intentId: 'schedule-source', operationId: 'source-create', prompt: 'hello', active: true }
    const invalid = await h.client.saveAgentFuturePromptIntent({ ...request, caller: { agentSessionId: 'first-author', capability: later } }).then(() => undefined, error => error)
    expect(invalid).toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(h.client.agentSession('bound-agent').futurePromptIntents).toBeUndefined()
    const sourceDevice = { hostId: 'local', deviceId: 'first-device', name: 'First device' }
    await h.client.saveAgentFuturePromptIntent({ ...request, caller: { agentSessionId: 'first-author', capability: first }, sourceDevice })
    const firstMessage = h.client.agentSession('bound-agent').futurePromptIntents!['schedule-source']!.message
    expect(firstMessage).toEqual({ userContent: 'hello', authorAgentSessionId: 'first-author', sourceDevice })
    const invalidReplay = await h.client.saveAgentFuturePromptIntent({ ...request, active: false, caller: { agentSessionId: 'first-author', capability: later } }).then(() => undefined, error => error)
    expect(invalidReplay).toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(h.client.agentSession('bound-agent').futurePromptIntents!['schedule-source']).toMatchObject({ active: true, message: firstMessage })
    await h.client.saveAgentFuturePromptIntent({ ...request, active: false, caller: { agentSessionId: 'later-author', capability: later }, sourceDevice: { ...sourceDevice, deviceId: 'later-device' } })
    await h.client.saveAgentFuturePromptIntent({ ...request, caller: { agentSessionId: 'later-author', capability: later } })
    expect((await loadAgentSessions(h.store))[0]!.futurePromptIntents!['schedule-source']!.message).toEqual(firstMessage)
    await h.client.submitAgentPrompt({ ...h.input, expectedInputByte: 0, expectedFutureIntent: { intentId: 'schedule-source', occurrenceAt: 1000 }, sourceDevice: { ...sourceDevice, deviceId: 'timer-device' } })
    expect(h.writes).toHaveLength(1)
    expect(h.client.agentSession('bound-agent').promptCompletionAdmission!.intent!.message).toEqual(firstMessage)
    const forged = await h.client.saveAgentFuturePromptIntent({ ...request, authorHuman: true } as never).then(() => undefined, error => error)
    expect(forged).toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
    expect(h.writes).toHaveLength(1)
  })
  it('refuses changed future content fields even when their composed native bytes are identical', async () => {
    const h = await fixture(true)
    await h.client.saveAgentFuturePromptIntent({ agentSessionId: 'bound-agent', intentId: 'schedule-split', operationId: 'split-create', prompt: 'hello', agentMuxNote: 'Original context', active: true })
    const saved = h.client.agentSession('bound-agent').futurePromptIntents!['schedule-split']!
    const rejected = await h.client.submitAgentPrompt({ ...h.input, prompt: saved.prompt, expectedInputByte: 0, expectedFutureIntent: { intentId: 'schedule-split', occurrenceAt: 1000 } }).then(() => undefined, error => error)
    expect(h.writes).toEqual([])
    expect(rejected).toMatchObject({ code: 'AGENT_FUTURE_INTENT_CHANGED' })
    expect(h.client.agentSession('bound-agent').futurePromptIntents!['schedule-split']).not.toHaveProperty('lastOccurrenceAt')
  })
  it('persists exact future intent through the production client and admits each occurrence once', async () => {
    const h = await fixture(true)
    await h.client.saveAgentFuturePromptIntent({ agentSessionId: 'bound-agent', intentId: 'schedule-1', operationId: 'saved-operation', prompt: 'hello', active: true })
    expect((await loadAgentSessions(h.store))[0]!.futurePromptIntents!['schedule-1']).toMatchObject({ operationId: 'saved-operation', prompt: 'hello', active: true, message: { userContent: 'hello' } })
    const future = { intentId: 'schedule-1', occurrenceAt: 1000 }
    await h.client.submitAgentPrompt({ ...h.input, expectedInputByte: 0, expectedFutureIntent: future })
    const admitted = h.client.agentSession('bound-agent')
    expect(admitted.futurePromptIntents!['schedule-1']).toMatchObject({ lastOccurrenceAt: 1000, lastOperationId: 'bound-operation' })
    const count = h.writes.length
    await h.client.submitAgentPrompt({ ...h.input, expectedInputByte: 0, expectedFutureIntent: future })
    expect(h.writes).toHaveLength(count)
    // The Native idle gate is also satisfied: removing occurrence monotonicity
    // must admit a second real Input, rather than only change the error code.
    const provider = h.client.providers.get('generic')
    provider.readPromptExecutionEvidence = async () => ({ sourceId: 'native-source', id: 'native-idle', state: 'idle' })
    provider.inspectPromptExecution = () => 'idle'
    vi.spyOn(h.inner.screenEvidence, 'wait').mockImplementation(async (_session, _boundary, _require, matcher) => {
      matcher?.({ geometryRevision: 2, snapshot: () => ({}) } as never); return 123
    })
    const rejected = await h.client.submitAgentPrompt({ ...h.input, ...agentPromptCondition(admitted), operationId: 'duplicate-new-operation', expectedInputByte: h.run('original-run').acceptedInputBytes!, expectedFutureIntent: future }).then(() => undefined, error => error)
    expect(h.writes).toHaveLength(count)
    expect(rejected).toMatchObject({ code: 'AGENT_FUTURE_INTENT_CHANGED' })
  })
  it.each(['changed-message','disabled','working','permission','null-input','changed-input','wrong-run'] as const)('keeps future occurrence and manual capability when %s', async mode => {
    const h = await fixture(true)
    await h.client.saveAgentFuturePromptIntent({ agentSessionId: 'bound-agent', intentId: 'schedule-1', operationId: 'saved-operation', prompt: 'hello', active: mode !== 'disabled' })
    if (mode === 'working') await h.inner.registry.update('bound-agent', { runId: 'original-run' }, current => ({ ...current, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 200 } }))
    if (mode === 'permission') await h.inner.registry.update('bound-agent', { runId: 'original-run' }, current => ({ ...current, pendingInteraction: { request: { id: 'permission', agentSessionId: 'bound-agent', kind: 'permission', title: 'Allow?', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }], evidence: { source: 'native-hook', observedAt: 200, run: { runId: 'original-run' }, hookReceiptId: 'permission' } } } as never }))
    if (mode === 'null-input') h.inner.kernel.status = async () => ({ ...h.run('original-run'), acceptedInputBytes: null })
    const input = { ...h.input, expectedInputByte: mode === 'changed-input' ? 4 : 0, expectedFutureIntent: { intentId: 'schedule-1', occurrenceAt: 1000 }, ...(mode === 'changed-message' ? { prompt: 'different' } : {}), ...(mode === 'wrong-run' ? { expectedRun: { runId: 'another-run' } } : {}) }
    await expect(h.client.submitAgentPrompt(input)).rejects.toBeInstanceOf(Error)
    expect(h.writes).toEqual([])
    expect(h.client.agentSession('bound-agent').futurePromptIntents!['schedule-1']).not.toHaveProperty('lastOccurrenceAt')
    if (mode !== 'permission' && mode !== 'null-input') {
      await h.client.submitAgentPrompt({ ...h.input, ...agentPromptCondition(h.client.agentSession('bound-agent')), operationId: 'manual-kept', allowUncertainTurn: true })
      expect(h.writes.length).toBeGreaterThan(0)
    }
  })
  it('does not treat a consumed old done marker as current idle while the next native start is delayed', async () => {
    const h = await fixture(true)
    await h.client.submitAgentPrompt(h.input)
    await h.client.saveAgentFuturePromptIntent({ agentSessionId: 'bound-agent', intentId: 'schedule-1', operationId: 'saved-operation', prompt: 'hello', active: true })
    const admitted = h.client.agentSession('bound-agent'), count = h.writes.length
    await expect(h.client.submitAgentPrompt({ ...h.input, ...agentPromptCondition(admitted), operationId: 'future-operation', expectedInputByte: h.run('original-run').acceptedInputBytes!, expectedFutureIntent: { intentId: 'schedule-1', occurrenceAt: 1000 } })).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    expect(h.writes).toHaveLength(count)
    await expect(h.client.submitAgentPrompt({ ...h.input, ...agentPromptCondition(admitted), operationId: 'interval-operation', expectedInputByte: h.run('original-run').acceptedInputBytes!, expectedCompletionId: '["original-run",100]' })).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
  })
})

it('allows a saved later future occurrence at a passively confirmed native idle frame while interval remains consumed', async () => {
  const h = await fixture(true)
  await h.client.submitAgentPrompt(h.input)
  await h.client.saveAgentFuturePromptIntent({ agentSessionId: 'bound-agent', intentId: 'schedule-1', operationId: 'saved-operation', prompt: 'hello', active: true })
  const provider = h.client.providers.get('generic')
  provider.readPromptExecutionEvidence = async () => ({ sourceId: 'native-source', id: 'native-idle', state: 'idle' })
  provider.inspectPromptExecution = () => 'idle'
  const frames: Array<Parameters<AgentScreenEvidenceStore['wait']>[4]> = []
  vi.spyOn(h.inner.screenEvidence, 'wait').mockImplementation(async (_session, _boundary, _require, matcher, options) => {
    frames.push(options); matcher?.({ geometryRevision: 2, snapshot: () => ({}) } as never); return 123
  })
  const before = h.client.agentSession('bound-agent'), count = h.writes.length
  await h.client.submitAgentPrompt({ ...h.input, ...agentPromptCondition(before), operationId: 'future-operation', expectedInputByte: h.run('original-run').acceptedInputBytes!, expectedFutureIntent: { intentId: 'schedule-1', occurrenceAt: 1000 } })
  expect(h.writes.length).toBe(count + 1)
  expect(frames.some(frame => frame?.requireFrameAfterBoundary === true && frame?.requireCompleteFrame === true && frame?.checkpointFrameFence?.resizeRevision === 2)).toBe(true)
  const admitted = h.client.agentSession('bound-agent')
  await expect(h.client.submitAgentPrompt({ ...h.input, ...agentPromptCondition(admitted), operationId: 'interval-operation', expectedInputByte: h.run('original-run').acceptedInputBytes!, expectedCompletionId: '["original-run",100]' })).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
})
