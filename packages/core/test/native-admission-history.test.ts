import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore as SourceFileStore, AgentMuxMemoryAgentSessionStore as SourceMemoryStore } from '../src/agent-session-store.js'
import { AgentMuxControlServer as SourceServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc as SourceConnect } from '../src/public-rpc-client.js'
import { DurableAgentMuxMessageQueue as SourceQueue } from '../src/agent-global-message-queue.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentMuxStoredAgentSession, AgentNativePromptInputPlan } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { renderAgentMuxMessageEnvelope } from '../src/agent-global-message-queue.js'
import { AgentMuxHostedRuntimeService as SourceHostedService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux as SourceConnectHosted } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'

const entry = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY
const compiled = entry ? await import(entry) : null
const serverEntry = entry ? await import(new URL('./public-rpc-server.js', entry.startsWith('file:') ? entry : pathToFileURL(entry)).href) : null
const hostedEntry = entry ? await import(new URL('./hosted-runtime-service.js', entry.startsWith('file:') ? entry : pathToFileURL(entry)).href) : null
const AgentMuxFileAgentSessionStore: typeof SourceFileStore = compiled ? compiled.AgentMuxFileAgentSessionStore : SourceFileStore
const AgentMuxMemoryAgentSessionStore: typeof SourceMemoryStore = compiled ? compiled.AgentMuxMemoryAgentSessionStore : SourceMemoryStore
const AgentMuxControlServer: typeof SourceServer = serverEntry ? serverEntry.AgentMuxControlServer : SourceServer
const connectAgentMuxRpc: typeof SourceConnect = compiled ? compiled.connectAgentMuxRpc : SourceConnect
const DurableAgentMuxMessageQueue: typeof SourceQueue = compiled ? compiled.DurableAgentMuxMessageQueue : SourceQueue
const AgentMuxHostedRuntimeService: typeof SourceHostedService = hostedEntry ? hostedEntry.AgentMuxHostedRuntimeService : SourceHostedService
const connectHostedAgentMux: typeof SourceConnectHosted = compiled ? compiled.connectHostedAgentMux : SourceConnectHosted

afterEach(() => vi.unstubAllEnvs())
const plan: AgentNativePromptInputPlan = { kind: 'native-rpc', protocolId: 'controlled-native-contract', operation: 'start-or-steer',
  sourceId: 'original-source', actorId: 'original-peer', threadId: 'original-thread' }
const body = 'Original opaque body\n{"human":true,"cancelled":true} is user text.'

function stored(root: string, id = 'A'): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: 'original', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    hookBindingId: 'private-hook', hookToken: 'private-token', run: { runId: 'original-run' }, retiredRuns: [], createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1),
    promptCompletionAdmission: { transport: 'native', operationId: id, submissionId: id, native: { plan, outcome: 'unknown' },
      intent: { run: { runId: 'original-run' }, ownerInstanceId: 'original-runtime', prompt: body + id, plan,
        execution: 'immediate', message: { userContent: body + id, authorHuman: true } } } }
}

for (const kind of ['memory', 'file'] as const) {
  it(`${kind} refuses an ordinary write that restarts a historical Native claim`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'am-admission-immutable-'))
    const store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
    const a = stored(root), b = { ...stored(root, 'B'), updatedAt: reshapeFixtureEpoch(0, 0, 2) }
    try {
      await store.compareAndSwap(null, a)
      const original = await store.readPromptAdmission('original', a.run, 'A')
      await store.compareAndSwapMetadata(a, b)
      const admission = a.promptCompletionAdmission!
      if (admission.transport !== 'native') throw new Error('Test requires its original Native record')
      const restarted = { ...a, promptCompletionAdmission: { ...admission, native: { plan, outcome: 'claimed' as const } } }
      await expect(store.compareAndSwapMetadata(b, restarted)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      expect(await store.readPromptAdmission('original', a.run, 'A')).toEqual(original)
      expect(await store.readMetadata('original')).toEqual(b)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each(['metadata', 'complete', 'delete', 'lifecycle'] as const)(`${kind} preserves original Native facts across %s writes`, async path => {
    const root = await mkdtemp(join(tmpdir(), 'am-admission-owner-'))
    const store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
    const a = stored(root)
    try {
      await store.compareAndSwap(null, a)
      const original = await store.readPromptAdmission('original', a.run, 'A')
      if (kind === 'file') {
        // An existing validated v1 database written by the old owner has no
        // history table. Only its original latest slot remains to be preserved.
        const old = new DatabaseSync(join(root, 'sessions.json')); old.exec('DROP TABLE prompt_admissions'); old.close()
      }
      if (path === 'delete') await store.compareAndSwap(a, null)
      else if (path === 'lifecycle') {
        const reservation = { kind: 'resume' as const, agentSessionId: a.agentSessionId, expectedRun: a.run,
          reservationId: 'original-reservation', operationId: 'original-resume', ownerId: 'original-owner', ownerPid: process.pid, expiresAt: Date.now() + 60_000 }
        await store.reserveLifecycle(reservation)
        const next = { ...a, run: { runId: 'next-run' }, retiredRuns: [a.run], updatedAt: reshapeFixtureEpoch(0, 0, 2) }
        delete next.promptCompletionAdmission
        await store.commitLifecycle(reservation, next)
      } else {
        const b = { ...stored(root, 'B'), updatedAt: reshapeFixtureEpoch(0, 0, 2) }
        if (path === 'metadata') await store.compareAndSwapMetadata(a, b)
        else await store.compareAndSwap(a, b)
      }
      const reopened = kind === 'file' ? new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) : store
      expect(await reopened.readPromptAdmission('original', a.run, 'A')).toEqual(original)
      expect(original?.admission).not.toHaveProperty('inputKey')
      expect(original?.admission?.intent).not.toHaveProperty('admissionIntent')
      expect(await reopened.loadMetadata()).not.toContainEqual(expect.objectContaining({ promptAdmissionHistory: expect.anything() }))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it(`${kind} settles a late exact receipt without replacing a later input`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'am-admission-late-'))
    const store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
    const a = stored(root), b = { ...stored(root, 'B'), updatedAt: reshapeFixtureEpoch(0, 0, 2) }
    try {
      await store.compareAndSwap(null, a)
      const original = (await store.readPromptAdmission('original', a.run, 'A'))!
      await store.compareAndSwapMetadata(a, b)
      if (original.admission?.transport !== 'native') throw new Error('Test requires its original Native record')
      const settled = { ...original, admission: { ...original.admission, acknowledged: true,
        native: { plan, outcome: 'admitted' as const, turnId: 'original-A-turn' } } }
      await store.settlePromptAdmission(original, settled)
      expect(await store.readPromptAdmission('original', a.run, 'A')).toEqual(settled)
      expect((await store.readMetadata('original'))?.promptCompletionAdmission).toEqual(b.promptCompletionAdmission)
      await expect(store.settlePromptAdmission(original, settled)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

/** Core/journal are actual owners; only Provider/Runtime machine ports are controlled here. */
async function sdkOwner() {
  const h = await rpcOwnerFixture(), dispatched: string[] = []
  let lose = 'A'
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'original-runtime', protocolVersion: 1, buildIdentity: 'controlled' })
  const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
  const prepare = vi.spyOn(provider as typeof provider & Required<Pick<typeof provider, 'prepareNativePromptInput'>>, 'prepareNativePromptInput')
    .mockImplementation(async () => ({ plan, assertCurrent: async () => {}, close: async () => {},
      dispatch: async (_prompt, id) => { dispatched.push(id)
        if (id === lose) throw new Error('Controlled Native receipt unavailable after dispatch')
        return { outcome: 'admitted', turnId: 'turn-' + id } } }))
  const input = (operationId: string) => ({ agentSessionId: 'recipient', expectedRun: h.client.agentSession('recipient').run,
    admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const, operationId, prompt: body,
    agentMuxNote: 'Original SDK platform note.', authorHuman: true, sourceChannel: 'api' as const })
  return { ...h, dispatched, prepare, input, lose(id: string) { lose = id }, close: async () => { prepare.mockRestore(); await h.close() } }
}

it('SDK admits an independent manual key after unknown and joins old history without preparation or replay', async () => {
  const h = await sdkOwner()
  try {
    const a = h.input('A')
    await expect(h.client.submitAgentPrompt(a)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    const keyA = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: a.expectedRun, submissionId: 'A' }
    const original = await h.client.inspectAgentPromptSubmission(keyA)
    expect(original?.admission?.native?.outcome).toBe('unknown')
    await expect(h.client.submitAgentPrompt(h.input('B'))).resolves.toBeUndefined()
    expect(h.dispatched).toEqual(['A', 'B'])
    expect(h.client.agentSession('recipient').promptCompletionAdmission?.submissionId).toBe('B')
    expect(await h.client.inspectAgentPromptSubmission(keyA)).toEqual(original)
    const before = h.prepare.mock.calls.length
    await expect(h.client.submitAgentPrompt(a)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    expect(h.prepare).toHaveBeenCalledTimes(before); expect(h.dispatched).toEqual(['A', 'B'])
    expect(original?.admission?.intent?.message).toEqual({ userContent: body, systemContext: 'Original SDK platform note.', authorHuman: true, sourceChannel: 'api' })
    const { admissionIntent: _manual, ...exact } = h.input('C')
    await expect(h.client.submitAgentPrompt({ ...exact, afterSubmissionId: 'A' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_CONDITION_CHANGED' })
    expect(h.dispatched).toEqual(['A', 'B'])
  } finally { await h.close() }
})

it.each(['afterSubmissionId', 'expectedCompletionId', 'expectedFutureIntent', 'expectedInputByte', 'preparationRetry'] as const)('manual SDK input cannot acquire authority from %s', async field => {
  const h = await sdkOwner()
  try {
    const value = field === 'afterSubmissionId' ? null : field === 'expectedInputByte' ? 0 : field === 'expectedFutureIntent'
      ? { intentId: 'original-future', occurrenceAt: reshapeFixtureEpoch(0, 0, 1) } : field === 'preparationRetry' ? { inputByte: 0, nativeSourceId: 'original-source' } : 'original-completion'
    await expect(h.client.submitAgentPrompt({ ...h.input('manual-mixed'), [field]: value } as never)).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.dispatched).toEqual([])
  } finally { await h.close() }
})

it('an old exact-turn plan remains readable data and cannot qualify a new Native writer', async () => {
  const h = await sdkOwner()
  try {
    const { operation: _operation, ...source } = plan
    h.prepare.mockResolvedValueOnce({ plan: { ...source, expectedTurnId: 'old-exact-turn' }, assertCurrent: async () => {},
      dispatch: async () => { h.dispatched.push('forbidden-old-writer'); return { outcome: 'admitted', turnId: 'old-exact-turn' } }, close: async () => {} })
    await expect(h.client.submitAgentPrompt(h.input('new-with-old-plan'))).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNCONFIRMED' })
    expect(h.dispatched).toEqual([])
    expect(await h.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'new-with-old-plan' })).toBeNull()
  } finally { await h.close() }
})

it('public immediate producer saves manual intent only for a new original message, and public history retains old unknown', async () => {
  const h = await sdkOwner(), server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const queue = new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson'))
  try {
    const params = { target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: body, execution: 'immediate' as const,
      sourceChannel: 'api' as const, operationId: 'original-public-control', messageId: 'A' }
    await expect(rpc.call('agent.send', params)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    const first = (await queue.listAfter())[0]!
    expect(first.admissionIntent).toEqual({ kind: 'manual-actor', expectedRun: { runId: 'run-recipient' } })
    expect(first.envelope.body).toBe(body); expect(first.promptCondition).toBeNull()
    const keyA = { kind: 'message' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, messageId: 'A' }
    const original = await rpc.call('agent.input.inspect', { key: keyA })
    expect(original.record?.admission?.native?.outcome).toBe('unknown')
    await expect(rpc.call('agent.send', { ...params, operationId: 'independent-public-control', messageId: 'B' })).resolves.toMatchObject({ delivery: { state: 'delivered' } })
    expect(h.dispatched).toEqual(['A', 'B'])
    expect(await rpc.call('agent.input.inspect', { key: keyA })).toEqual(original)
    const before = h.prepare.mock.calls.length
    await expect(rpc.call('agent.send', params)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    expect(h.prepare).toHaveBeenCalledTimes(before); expect(h.dispatched).toEqual(['A', 'B'])
    await expect(h.client.inspectAgentPromptSubmission({ ...keyA, kind: 'prompt', submissionId: 'A' } as never)).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
    await expect(h.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: keyA.expectedRun, submissionId: 'A' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})

it.each(['public-immediate', 'SDK-exact'] as const)('confirmed Native conversation preserves admitted A and accepts new B through %s', async entryPoint => {
  const h = await sdkOwner(), server = new AgentMuxControlServer({ socketPath: join(h.root, 'confirm.sock'), coreClients: h.coreClients })
  const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
  const oldHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-thread', transcriptPath: join(h.root, 'original.jsonl') }
  const newHandle = { ...oldHandle, sessionId: 'confirmed-thread', transcriptPath: join(h.root, 'confirmed.jsonl') }
  const nextPlan = { ...plan, sourceId: 'confirmed-source', threadId: newHandle.sessionId }
  let selected = oldHandle
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: process.pid }))
  const initial = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(initial, { ...initial, nativeHandle: oldHandle,
    nativeBinding: { source: 'process-witness', run: initial.run, observedAt: reshapeFixtureEpoch(0, 0, 1) } })
  await Reflect.get(h.client, 'registry').refresh('recipient', initial.run)
  h.prepare.mockImplementation(async context => {
    expect(context.nativeHandle).toEqual(selected)
    return { plan: selected === oldHandle ? plan : nextPlan, close: async () => {},
      assertCurrent: async () => { expect(context.nativeHandle).toEqual(selected) },
      dispatch: async (_prompt, id) => { h.dispatched.push(id); return { outcome: 'admitted', turnId: 'turn-' + id } } }
  })
  const witnessCurrent = vi.fn(async () => { expect(selected).toEqual(newHandle) })
  const witness = vi.spyOn(provider as typeof provider & Required<Pick<typeof provider, 'discoverNativeSession'>>, 'discoverNativeSession')
    .mockImplementation(async context => { expect(context.processId).toBe(process.pid); expect(context.workspacePath).toBe(h.root)
      return { handle: newHandle, assertCurrent: witnessCurrent } })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const send = (id: string) => ({ target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: body,
    execution: 'immediate' as const, operationId: 'control-' + id, messageId: id })
  try {
    await expect(rpc.call('agent.send', send('A'))).resolves.toMatchObject({ delivery: { state: 'delivered' } })
    const keyA = { kind: 'message' as const, agentSessionId: 'recipient', expectedRun: initial.run, messageId: 'A' }
    const original = await h.client.inspectAgentPromptSubmission(keyA)
    expect(original?.admission).toMatchObject({ acknowledged: true, native: { plan, outcome: 'admitted', turnId: 'turn-A' } })
    // A controlled Provider source event is persisted by the actual Store owner.
    // The transition itself must then pass the real public confirmation API.
    selected = newHandle
    const before = (await h.store.readMetadata('recipient'))!, observationAt = before.updatedAt + 1
    await h.store.compareAndSwapMetadata(before, { ...before, observedNativeHandle: newHandle,
      nativeSourceObservation: { state: 'changed', run: before.run, observedAt: observationAt, reason: 'controlled-machine-source-event' }, updatedAt: observationAt })
    const confirmation = await rpc.call('agent.native.confirm', { agentSessionId: 'recipient', expectedRun: initial.run,
      expectedNativeHandle: oldHandle, candidateNativeHandle: newHandle, expectedObservationAt: observationAt, operationId: 'explicit-confirmation' })
    expect(confirmation).toMatchObject({ persisted: true, current: true, confirmation: { previousPromptSubmissionId: 'A',
      previousNativeHandle: oldHandle, nativeHandle: newHandle }, session: { nativeHandle: newHandle, nativeBinding: { source: 'user-confirmed' } } })
    expect(witnessCurrent).toHaveBeenCalledTimes(2)
    const confirmed = (await h.store.readMetadata('recipient'))!
    const receipt = confirmed.nativeConfirmation!, binding = confirmed.nativeBinding!
    for (const [name, fields] of [
      ['no-confirmation', { nativeBinding: { ...binding, source: 'process-witness' as const } }],
      ['other-prior', { nativeConfirmation: { ...receipt, previousPromptSubmissionId: 'another-input' } }],
      ['other-run', { nativeConfirmation: { ...receipt, run: { runId: 'another-run' } } }],
      ['other-handle', { nativeConfirmation: { ...receipt, nativeHandle: { ...newHandle, sessionId: 'another-thread' } } }],
      ['other-binding-source', { nativeBinding: { ...binding, source: 'native-hook' as const } }]
    ] as const) {
      const altered = { ...confirmed, ...fields }
      if (name === 'no-confirmation') delete altered.nativeConfirmation
      await h.store.compareAndSwapMetadata(confirmed, altered)
      await expect(rpc.call('agent.send', send('refused-' + name))).rejects.toMatchObject({ code: 'AGENT_PROMPT_SOURCE_CHANGED' })
      expect(h.dispatched).toEqual(['A'])
      const rejected = (await h.store.readMetadata('recipient'))!
      await h.store.compareAndSwapMetadata(rejected, confirmed)
    }
    // The original main Hook preserves user-confirmed authority but refreshes
    // observedAt. This bounded metadata event models that exact owner contract;
    // it is not a real Native Hook producer or another confirmation generation.
    const refreshedBinding = { ...binding, observedAt: confirmed.updatedAt + 1 }
    await h.store.compareAndSwapMetadata(confirmed, { ...confirmed, nativeBinding: refreshedBinding, updatedAt: refreshedBinding.observedAt })
    await Reflect.get(h.client, 'registry').refresh('recipient', initial.run)
    if (entryPoint === 'public-immediate') {
      await expect(rpc.call('agent.send', send('B'))).resolves.toMatchObject({ delivery: { state: 'delivered' } })
      const readB = await rpc.call('agent.input.inspect', { key: { ...keyA, messageId: 'B' } })
      expect(readB.record?.admission?.native).toMatchObject({ plan: nextPlan, outcome: 'admitted', turnId: 'turn-B' })
    } else {
      const { admissionIntent: _manual, ...exact } = h.input('B')
      await expect(h.client.submitAgentPrompt({ ...exact, afterSubmissionId: 'A' })).resolves.toBeUndefined()
    }
    expect(h.dispatched).toEqual(['A', 'B'])
    expect(await rpc.call('agent.input.inspect', { key: keyA })).toEqual({ record: original })
    const prepared = h.prepare.mock.calls.length
    await expect(rpc.call('agent.send', send('A'))).resolves.toMatchObject({ delivery: { state: 'delivered' } })
    expect(h.prepare).toHaveBeenCalledTimes(prepared); expect(h.dispatched).toEqual(['A', 'B'])
    const journalA = (await new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')).listAfter()).find(value => value.envelope.messageId === 'A')!
    expect(journalA.envelope.body).toBe(body)
    expect(original?.admission?.intent?.message?.userContent).toBe(renderAgentMuxMessageEnvelope(journalA.envelope))
    expect(h.client.agentSession('recipient').run).toEqual(initial.run)
    expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.attach).not.toHaveBeenCalled()
  } finally { witness.mockRestore(); await rpc.dispose(); await server.stop(); await h.close() }
})

it.each([
  ['prepare', 'handle'], ['prepare', 'binding'], ['prepare', 'binding-observation'],
  ['preclaim', 'handle'], ['preclaim', 'binding'], ['preclaim', 'binding-observation'],
  ['dispatch', 'handle'], ['dispatch', 'binding'], ['dispatch', 'binding-observation']
] as const)('Native input keeps its original %s scope when %s changes across an await', async (phase, field) => {
  const h = await sdkOwner(), initial = (await h.store.readMetadata('recipient'))!
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-thread' }
  const nativeBinding = { source: 'process-witness' as const, run: initial.run, observedAt: reshapeFixtureEpoch(0, 0, 1) }
  await h.store.compareAndSwapMetadata(initial, { ...initial, nativeHandle, nativeBinding })
  await Reflect.get(h.client, 'registry').refresh('recipient', initial.run)
  let changedBindingAt = 0
  const changeScope = async () => {
    const current = (await h.store.readMetadata('recipient'))!
    changedBindingAt = current.updatedAt + 1
    await h.store.compareAndSwapMetadata(current, { ...current, updatedAt: changedBindingAt, ...(field === 'handle'
      ? { nativeHandle: { ...nativeHandle, sessionId: 'later-thread' } }
      : { nativeBinding: { ...nativeBinding, source: field === 'binding' ? 'semantic-resume-target' : nativeBinding.source, observedAt: changedBindingAt } }) })
  }
  let checks = 0
  h.prepare.mockImplementation(async context => {
    expect(context.nativeHandle).toEqual(nativeHandle)
    if (phase === 'prepare') await changeScope()
    return { plan, close: async () => {}, assertCurrent: async () => {
      checks++
      if (phase === 'preclaim' && checks === 1 || phase === 'dispatch' && checks === 2) await changeScope()
    }, dispatch: async (_prompt, id) => { h.dispatched.push(id); return { outcome: 'admitted', turnId: 'forbidden-turn' } } }
  })
  try {
    if (field === 'binding-observation') {
      await expect(h.client.submitAgentPrompt(h.input('scope-drift'))).resolves.toBeUndefined()
      expect(h.dispatched).toEqual(['scope-drift'])
    } else {
      await expect(h.client.submitAgentPrompt(h.input('scope-drift'))).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNCONFIRMED' })
      expect(h.dispatched).toEqual([])
    }
    const record = await h.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: initial.run, submissionId: 'scope-drift' })
    if (field === 'binding-observation') expect(record?.admission).toMatchObject({ acknowledged: true, native: { outcome: 'admitted' } })
    else if (phase === 'dispatch') expect(record?.admission).toMatchObject({ notApplied: true, native: { outcome: 'not-applied' } })
    else expect(record).toBeNull()
    const current = (await h.store.readMetadata('recipient'))!
    expect(field === 'handle' ? current.nativeHandle?.sessionId : current.nativeBinding?.source).toBe(field === 'handle' ? 'later-thread' : field === 'binding' ? 'semantic-resume-target' : 'process-witness')
    if (field === 'binding-observation') expect(current.nativeBinding?.observedAt).toBe(changedBindingAt)
    expect(current.run).toEqual(initial.run)
    expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.attach).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('a retry of an old queued immediate message cannot manufacture manual intent from its current predecessor', async () => {
  const h = await sdkOwner(), server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const queue = new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson'))
  try {
    await expect(h.client.submitAgentPrompt(h.input('A'))).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    const old = await queue.append({ messageId: 'old-queued', operationId: 'old-control', createdAt: reshapeFixtureEpoch(0, 0, 1),
      sender: { kind: 'human', principal: 'local-cli' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
      threadId: 'old-queued', correlationId: 'old-queued', replyTo: null, workspaceId: null,
      senderSessionId: null, senderRunId: null, recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
      body, execution: 'immediate', sourceChannel: 'api' })
    expect(old).not.toHaveProperty('admissionIntent')
    const before = h.prepare.mock.calls.length
    await expect(rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, text: body,
      execution: 'immediate', sourceChannel: 'api', operationId: 'old-control', messageId: 'old-queued' }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    const read = (await queue.listAfter()).find(value => value.envelope.messageId === 'old-queued')!
    expect(read).not.toHaveProperty('admissionIntent')
    expect(read.envelope).toEqual(old.envelope)
    expect(read.promptCondition).toEqual({ expectedRun: { runId: 'run-recipient' }, afterSubmissionId: 'A' })
    expect(h.dispatched).toEqual(['A'])
    // Preparation may observe a qualified transport; it never grants a new input.
    expect(h.prepare.mock.calls.length).toBeGreaterThanOrEqual(before)
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})

it.each(['terminal-partial', 'untyped-legacy'] as const)('manual input preserves %s instead of converting an unproven surface', async kind => {
  const h = await sdkOwner()
  try {
    const current = (await h.store.readMetadata('recipient'))!
    const terminal = { run: current.run, submissionId: 'original-TTY', promptDigest: 'a'.repeat(43), outputCursorBytes: 1,
      payload: { operationId: 'payload', inputByteRange: { startByte: 0, endByte: 3 }, acknowledged: true },
      submit: { operationId: 'submit', inputByteRange: { startByte: 3, endByte: 4 }, acknowledged: false } }
    const legacy = { operationId: 'original-opaque', startByte: 0, endByte: 4, acknowledged: false }
    const original = { ...current, ...(kind === 'terminal-partial' ? { terminalPromptSubmission: terminal } : { promptCompletionAdmission: legacy }) }
    await h.store.compareAndSwapMetadata(current, original)
    await expect(h.client.submitAgentPrompt(h.input('new-manual'))).rejects.toMatchObject({ code: 'AGENT_PROMPT_TRANSPORT_UNCONFIRMED' })
    expect(h.dispatched).toEqual([])
    expect(await h.store.readMetadata('recipient')).toEqual(original)
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: current.run,
      submissionId: kind === 'terminal-partial' ? 'original-TTY' : 'original-opaque' }
    const read = await h.client.inspectAgentPromptSubmission(key)
    expect(kind === 'terminal-partial' ? read?.terminalPromptSubmission : read?.admission).toEqual(kind === 'terminal-partial' ? terminal : legacy)
    if (kind === 'terminal-partial') expect(read?.admission).toBeUndefined()
    else expect(read?.admission).not.toHaveProperty('inputKey')
  } finally { await h.close() }
})

it('Native input retains an ended request response without pretending it is still answerable', async () => {
  const h = await sdkOwner()
  try {
    const current = (await h.store.readMetadata('recipient'))!
    const pending = { request: { kind: 'permission' as const, id: 'original-request', agentSessionId: 'recipient', title: 'Opaque title',
      nativeToolCallId: 'original-call', options: [{ id: 'allow-once', label: 'Opaque option', kind: 'allow-once' as const }],
      evidence: { source: 'native-hook' as const, observedAt: reshapeFixtureEpoch(0, 0, 1), run: current.run, hookReceiptId: 'original-hook-receipt' } },
      nativeCompleted: { source: 'native-hook' as const, observedAt: reshapeFixtureEpoch(0, 0, 2), run: current.run, hookReceiptId: 'original-completion-receipt' },
      response: { value: { kind: 'permission' as const, requestId: 'original-request', decision: { outcome: 'selected' as const, optionId: 'allow-once' } },
        responseDigest: 'private-digest', operationId: 'original-response', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false } }
    pending.response.responseDigest = createHash('sha256').update(JSON.stringify(pending.response.value)).digest('base64url')
    await h.store.compareAndSwapMetadata(current, { ...current, pendingInteraction: pending })
    await expect(h.client.submitAgentPrompt(h.input('manual-with-retained-response'))).rejects.toMatchObject({
      code: 'AGENT_INTERACTION_UNCONFIRMED', message: expect.stringContaining('earlier typed response has not been settled') })
    expect(h.dispatched).toEqual([])
    expect((await h.store.readMetadata('recipient'))?.pendingInteraction).toEqual(pending)
  } finally { await h.close() }
})

it('public history follows the original retained owner after its Store lifecycle retires the Session', async () => {
  const h = await sdkOwner(), server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    await expect(h.client.submitAgentPrompt(h.input('A'))).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'A' }
    const original = await h.client.inspectAgentPromptSubmission(key)
    const reservation = { kind: 'stop' as const, agentSessionId: 'recipient', expectedRun: key.expectedRun,
      stopOperation: { daemonInstance: 'original-runtime', operationKey: 'original-stop-receipt', runId: key.expectedRun.runId },
      reservationId: 'original-stop', operationId: 'original-stop-operation', ownerId: 'original-owner', ownerPid: process.pid, expiresAt: Date.now() + 60_000 }
    await h.store.reserveLifecycle(reservation); await h.store.commitLifecycle(reservation, null)
    await h.inner.registry.load('local')
    expect(await h.store.readMetadata('recipient')).toBeNull()
    expect(await rpc.call('agent.input.inspect', { key })).toEqual({ record: original })
    expect(await h.store.readMetadata('recipient')).toBeNull()
    expect(h.prepare).toHaveBeenCalledOnce(); expect(h.dispatched).toEqual(['A'])
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})

it('different producers cannot acquire the same logical input even with identical body, author and execution', async () => {
  const h = await sdkOwner()
  try {
    h.lose('never-lost')
    const envelope = { schema: 'agentmux.a2a.v1' as const, messageId: 'shared-input', operationId: 'original-control', createdAt: reshapeFixtureEpoch(0, 0, 1),
      sender: { kind: 'human' as const, principal: 'local-cli' as const }, recipient: { kind: 'agent-session' as const, agentSessionId: 'recipient' },
      threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null,
      senderSessionId: null, senderRunId: null, recipientSessionId: 'recipient', recipientRunId: 'run-recipient', body }
    const { agentMuxNote: _note, ...input } = h.input('shared-input')
    await expect(h.client.submitAgentPrompt({ ...input, prompt: renderAgentMuxMessageEnvelope(envelope) })).resolves.toBeUndefined()
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: input.expectedRun, submissionId: 'shared-input' }
    const original = await h.client.inspectAgentPromptSubmission(key)
    await expect(h.client.submitAgentMessage({ agentSessionId: 'recipient', envelope, sourceChannel: 'api', execution: 'immediate',
      admissionIntent: { kind: 'manual-actor', expectedRun: input.expectedRun } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect(h.prepare).toHaveBeenCalledOnce(); expect(h.dispatched).toEqual(['shared-input'])
    expect(await h.client.inspectAgentPromptSubmission(key)).toEqual(original)
  } finally { await h.close() }
})

it.each(['outer-run', 'input-run', 'frozen-intent-run', 'location-session', 'location-id', 'mixed-terminal-id'] as const)('SDK refuses %s record drift without deleting original history', async fault => {
  const h = await sdkOwner()
  try {
    await expect(h.client.submitAgentPrompt(h.input('A'))).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'A' }
    const wrong = structuredClone((await h.client.inspectAgentPromptSubmission(key))!)
    const admission = wrong.admission!
    if (fault === 'outer-run') wrong.run = { runId: 'other-run' }
    if (fault === 'input-run') admission.inputKey!.expectedRun = { runId: 'other-run' }
    if (fault === 'frozen-intent-run') admission.intent!.admissionIntent = { kind: 'manual-actor', expectedRun: { runId: 'other-run' } }
    if (fault === 'location-session') { wrong.agentSessionId = 'other-session'; admission.inputKey!.agentSessionId = 'other-session' }
    if (fault === 'location-id') { delete admission.inputKey; admission.submissionId = 'B'; admission.operationId = 'B' }
    if (fault === 'mixed-terminal-id') wrong.terminalPromptSubmission = { run: wrong.run, submissionId: 'B', promptDigest: 'a'.repeat(43), outputCursorBytes: 1,
      payload: { operationId: 'payload-B', inputByteRange: { startByte: 0, endByte: 3 }, acknowledged: true },
      submit: { operationId: 'submit-B', inputByteRange: { startByte: 3, endByte: 4 }, acknowledged: false } }
    const db = new DatabaseSync(join(h.root, 'sessions.json'))
    const bytes = JSON.stringify(wrong)
    try {
      db.prepare('UPDATE prompt_admissions SET json=? WHERE session_id=? AND run_id=? AND record_id=?')
        .run(bytes, 'recipient', 'run-recipient', JSON.stringify(['submission', 'A']))
      await expect(h.client.inspectAgentPromptSubmission(key)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
      expect(db.prepare('SELECT json FROM prompt_admissions WHERE session_id=? AND run_id=? AND record_id=?')
        .get('recipient', 'run-recipient', JSON.stringify(['submission', 'A']))!.json).toBe(bytes)
      expect(h.prepare).toHaveBeenCalledOnce(); expect(h.dispatched).toEqual(['A'])
    } finally { db.close() }
  } finally { await h.close() }
})

it('the public consumer rejects a legacy record returned for another logical ID', async () => {
  const h = await sdkOwner(), server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    await expect(h.client.submitAgentPrompt(h.input('A'))).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'A' }
    const original = (await h.client.inspectAgentPromptSubmission(key))!
    const wrong = structuredClone(original)
    delete wrong.admission!.inputKey; wrong.admission!.submissionId = 'B'; wrong.admission!.operationId = 'B'
    // Controlled wrong reply at the owning SDK port; actual public service,
    // JSON-RPC transport and consumer codec remain unmodified.
    vi.spyOn(h.client, 'inspectAgentPromptSubmission').mockResolvedValueOnce(wrong)
    await expect(rpc.call('agent.input.inspect', { key })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(await h.client.inspectAgentPromptSubmission(key)).toEqual(original)
    expect(h.prepare).toHaveBeenCalledOnce(); expect(h.dispatched).toEqual(['A'])
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})

it('Hosted carries manual intent to the same owner and reads history offline under its original fence', async () => {
  const h = await sdkOwner()
  let ownerId = 'original-owner'
  const connect = vi.spyOn(h.client, 'connect').mockResolvedValue()
  const service = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => ({ ...hostedTestOwner(h.client), ownerInstanceId: ownerId }))
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients, hostedRuntime: () => service })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const reader = await connectHostedAgentMux({ rpc })
  try {
    await expect(reader.submitAgentPrompt(h.input('A'))).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'A' }
    const original = await reader.inspectAgentPromptSubmission(key)
    await expect(reader.submitAgentPrompt(h.input('B'))).resolves.toBeUndefined()
    expect(h.dispatched).toEqual(['A', 'B'])
    const connections = connect.mock.calls.length
    connect.mockRejectedValue(new Error('Controlled Runtime connection is unavailable'))
    await expect(reader.inspectAgentPromptSubmission(key)).resolves.toEqual(original)
    expect(connect).toHaveBeenCalledTimes(connections)
    ownerId = 'changed-owner'
    await expect(reader.inspectAgentPromptSubmission(key)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
    expect(h.dispatched).toEqual(['A', 'B'])
  } finally { await reader.dispose(); await rpc.dispose(); await server.stop(); await service.dispose(); connect.mockRestore(); await h.close() }
})
