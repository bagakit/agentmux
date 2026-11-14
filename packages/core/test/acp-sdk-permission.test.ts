import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider, AgentMuxControlServer, connectAgentMuxRpc,
  type AgentMuxAcpBinding, type AgentMuxAcpBridgeCallbacks, type AgentMuxAcpEvent, type AgentMuxClientEvent,
  type AgentMuxInteractionRequest } from '@agentmux/core'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runStorageSourceCli } from './helpers/storage-recovery-source-cli.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'

const sid = 'original-acp', runId = 'run-' + sid
const cleanups: Array<() => Promise<void>> = []
const privateRoots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  for (const root of privateRoots.splice(0)) {
    expect(existsSync(root), 'original private SDK fixture must be removed').toBe(false)
    if (process.env.AMX_A07_CLEANUP) appendFileSync(process.env.AMX_A07_CLEANUP, JSON.stringify({ root, removed: true }) + '\n')
  }
  if (failures.length) throw new AggregateError(failures, 'Private SDK fixture cleanup failed')
})
const provider = defineAgentProvider({ catalog: { id: 'private-sdk-acp', label: 'Private SDK adapter',
  executable: process.execPath, expectedProcess: 'node', promptDelivery: 'positional-argv',
  readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, hookStrategy: { kind: 'none' },
  resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'adapter' },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: false, replyCorrelation: 'none' } },
  buildArgs: (_prompt, args) => [...args], hook: { rules: [] } })

it('requires a declared response channel and accepts the explicit ACP adapter contribution', () => {
  expect(provider.catalog.capabilities.permission).toBe('respond')
  expect(() => defineAgentProvider({ catalog: { ...provider.catalog, acpStrategy: { kind: 'none' } },
    buildArgs: (_prompt, args) => [...args], hook: { rules: [] } })).toThrow('Permission response capability requires a native response contribution.')
})

async function fixture(deliver?: AgentMuxAcpBinding['respondPermission']) {
  const h = await rpcOwnerFixture([sid], { AgentMuxClient, AgentMuxFileAgentSessionStore },
    () => ({ providerId: provider.id, executorId: provider.id }), () => ({ providers: [provider] }))
  cleanups.push(h.close)
  privateRoots.push(h.root)
  const events: AgentMuxClientEvent[] = [], responses: Array<{ id: string; decision: unknown }> = []
  let emit!: (event: AgentMuxAcpEvent) => void
  const binding: AgentMuxAcpBinding = { adapterId: 'original-sdk-binding', sessionId: 'original-native',
    onEvent(listener) { emit = listener; return () => {} },
    respondPermission: vi.fn(async (id, decision, signal) => { responses.push({ id, decision }); await deliver?.(id, decision, signal) }),
    close: vi.fn(async () => {}) }
  const stop = h.client.onEvent(event => { events.push(event) }, { observeMessages: false })
  cleanups.push(async () => { stop() })
  await h.client.bindAcp(sid, binding)
  const permission = async (id: string) => {
    const request = new Promise<AgentMuxInteractionRequest>(resolve => {
      const release = h.client.onEvent(event => { if (event.type === 'interaction' && event.request.agentSessionId === sid) {
        release(); resolve(event.request)
      } }, { observeMessages: false })
    })
    emit({ type: 'permission', requestId: id, title: 'Original permission',
      options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }, { id: 'deny', label: 'Reject always', kind: 'reject-always' }] })
    return await request
  }
  const input = (request: AgentMuxInteractionRequest) => ({ agentSessionId: sid, expectedRun: { runId }, operationId: 'answer-' + request.id,
    expectedRequest: request, response: { kind: 'permission' as const, requestId: request.id, decision: { outcome: 'selected' as const, optionId: 'allow' } } })
  return { ...h, binding, events, responses, emit, permission, input }
}

it('public SDK keeps an unanswered request, continues observations and accepts the later explicit choice', async () => {
  const h = await fixture()
  vi.useFakeTimers()
  const request = await h.permission('waiting')
  await vi.advanceTimersByTimeAsync(120_000)
  expect(h.responses, 'unanswered SDK permission must remain undecided').toEqual([])
  vi.useRealTimers()
  expect((await h.store.readMetadata(sid))?.pendingInteraction?.request.id).toBe(request.id)
  h.emit({ type: 'status', state: 'working' })
  await vi.waitFor(() => expect(h.events.some(event => event.type === 'agent-session' && event.session.semanticStatus?.state === 'working')).toBe(true))
  const receipt = await h.client.respondAgentInteraction(h.input(request))
  expect(receipt).toMatchObject({ operationId: h.input(request).operationId, delivery: 'acp-acknowledged', nativeAdoption: 'unknown' })
  expect(h.responses).toEqual([{ id: 'waiting', decision: { outcome: 'selected', optionId: 'allow' } }])
  expect(await h.client.inspectAgentInteractionOperation({ agentSessionId: sid, operationId: receipt.operationId })).toEqual(receipt)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('an explicit public SDK read recovers the same unsent request after FileStore publication fails', async () => {
  const h = await fixture()
  const write = h.store.compareAndSwapMetadata.bind(h.store)
  let unavailable = true
  let original: AgentMuxInteractionRequest | undefined
  vi.spyOn(h.store, 'compareAndSwapMetadata').mockImplementation(async (expected, next, ...rest) => {
    if (next?.pendingInteraction && unavailable) {
      original ??= structuredClone(next.pendingInteraction.request)
      throw new Error('Original permission metadata storage unavailable')
    }
    await write(expected, next, ...rest)
  })
  h.emit({ type: 'permission', requestId: 'publication-storage-failure', title: 'Original permission',
    options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }] })
  await vi.waitFor(() => expect(h.events.some(event => event.type === 'agent-error' && event.code === 'ACP_OBSERVATION_UNCONFIRMED')).toBe(true))
  expect(original).toBeDefined()
  const request = original!
  expect((await h.store.readMetadata(sid))?.pendingInteraction).toBeUndefined()
  await expect(h.client.respondAgentInteraction(h.input(request))).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_INTERACTION' })
  const stillUnavailable = await h.client.readAgentSession(sid)
  expect(stillUnavailable?.run).toEqual({ runId })
  expect(stillUnavailable?.pendingInteraction).toBeUndefined()
  expect(h.binding.close).not.toHaveBeenCalled()
  expect(h.responses).toEqual([])
  unavailable = false
  const recovered = await h.client.readAgentSession(sid)
  expect(recovered?.pendingInteraction?.request, 'explicit exact read must republish the original unsent permission after its FileStore recovers').toEqual(request)
  expect((await h.store.readMetadata(sid))?.pendingInteraction?.request).toEqual(request)
  expect(h.events.filter(event => event.type === 'interaction')).toEqual([expect.objectContaining({ request })])
  expect(await h.client.respondAgentInteraction(h.input(request))).toMatchObject({ delivery: 'acp-acknowledged', expectedRequest: request })
  await h.client.readAgentSession(sid)
  expect(h.responses).toEqual([{ id: 'publication-storage-failure', decision: { outcome: 'selected', optionId: 'allow' } }])
  expect(h.binding.close).not.toHaveBeenCalled()
  const callbacks = Reflect.get(Reflect.get(h.client, 'acp'), 'callbacks') as AgentMuxAcpBridgeCallbacks
  const observe = callbacks.onEvent.bind(callbacks)
  let release!: () => void, entered = false, pointReadComplete = false
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(callbacks, 'onEvent').mockImplementation(async (...args) => {
    if (args[1].type === 'status') { entered = true; await held }
    await observe(...args)
  })
  h.emit({ type: 'status', state: 'working' })
  await vi.waitFor(() => expect(entered).toBe(true))
  const pointRead = h.client.readAgentSession(sid).then(value => {
    expect(value?.run).toEqual({ runId }); pointReadComplete = true
  })
  try { await vi.waitFor(() => expect(pointReadComplete, 'a healthy exact point-read must not wait for an unrelated ACP callback').toBe(true)) }
  finally { release(); await pointRead }
})

it('public SDK retains failed delivery as unknown without unbinding or replaying the original operation', async () => {
  const h = await fixture(async () => { throw new Error('Original adapter ACK lost') })
  const request = await h.permission('lost-ack'), input = h.input(request)
  await expect(h.client.respondAgentInteraction(input)).rejects.toThrow('Original adapter ACK lost')
  await vi.waitFor(() => expect(h.events.some(event => event.type === 'agent-error' && event.code === 'ACP_OBSERVATION_UNCONFIRMED')).toBe(true))
  expect(h.binding.close).not.toHaveBeenCalled()
  expect((await h.store.readMetadata(sid))?.pendingInteraction?.request.id).toBe(request.id)
  expect(await h.client.inspectAgentInteractionOperation(input)).toMatchObject({ operationId: input.operationId, delivery: 'unknown', nativeAdoption: 'unknown' })
  expect(await h.client.respondAgentInteraction(input)).toMatchObject({ delivery: 'unknown' })
  expect(h.binding.respondPermission, 'unknown delivery must not repeat its side effect').toHaveBeenCalledOnce()
  h.emit({ type: 'activity', operation: 'append', activityId: 'still-readable', kind: 'assistant_message', status: 'complete', title: 'Original observation', content: 'Same healthy binding' })
  await vi.waitFor(() => expect(h.events.some(event => event.type === 'agent-timeline' && event.mutation.type === 'append' && event.mutation.item.content === 'Same healthy binding' && event.evidence.acpSessionId === 'original-native')).toBe(true))
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('public SDK waits for an actual slow ACK while subsequent native observations remain readable', async () => {
  let acknowledge!: () => void
  const gate = new Promise<void>(resolve => { acknowledge = resolve })
  const h = await fixture(async () => { await gate })
  const request = await h.permission('slow-ack')
  const response = h.client.respondAgentInteraction(h.input(request))
  await vi.waitFor(() => expect(h.responses).toHaveLength(1))
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(h.binding.close).not.toHaveBeenCalled()
  vi.useRealTimers()
  expect(await h.client.inspectAgentInteractionOperation(h.input(request))).toMatchObject({ delivery: 'unknown' })
  h.emit({ type: 'status', state: 'working' })
  await vi.waitFor(() => expect(h.events.some(event => event.type === 'agent-session' && event.session.semanticStatus?.state === 'working')).toBe(true))
  acknowledge()
  expect(await response).toMatchObject({ delivery: 'acp-acknowledged' })
})

it('public SDK disposal cancels the exact unanswered binding without choosing reject-always', async () => {
  const h = await fixture()
  await h.permission('closing')
  await h.client.dispose()
  expect(h.responses).toEqual([{ id: 'closing', decision: { outcome: 'cancelled' } }])
  expect(h.binding.close).toHaveBeenCalledOnce()
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('public SDK keeps exact Run and offered-choice authority before responding on the binding', async () => {
  const h = await fixture()
  const request = await h.permission('identity'), input = h.input(request)
  await expect(h.client.respondAgentInteraction({ ...input, expectedRun: { runId: 'foreign-run' } })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  await expect(h.client.respondAgentInteraction({ ...input, response: { ...input.response,
    decision: { outcome: 'selected', optionId: 'not-offered' } } })).rejects.toMatchObject({ code: 'INVALID_AGENT_INTERACTION_RESPONSE' })
  expect(h.responses).toEqual([])
  expect((await h.store.readMetadata(sid))?.pendingInteraction?.request.id).toBe(request.id)
  expect(await h.client.respondAgentInteraction(input)).toMatchObject({ delivery: 'acp-acknowledged' })
  expect(h.responses).toHaveLength(1)
})

it('public SDK retains two original permission requests while intervening status remains readable', async () => {
  const h = await fixture()
  const first = await h.permission('first-queued')
  const secondPublished = h.permission('second-queued')
  h.emit({ type: 'status', state: 'working' })
  await vi.waitFor(() => expect(h.events.some(event => event.type === 'agent-session' && event.session.semanticStatus?.state === 'working')).toBe(true))
  expect(h.responses).toEqual([])
  expect((await h.store.readMetadata(sid))?.pendingInteraction?.request.id).toBe(first.id)
  expect(await h.client.respondAgentInteraction(h.input(first))).toMatchObject({ delivery: 'acp-acknowledged' })
  await vi.waitFor(() => expect(h.events.filter(event => event.type === 'interaction'), 'second original request must remain available').toHaveLength(2))
  const second = await secondPublished
  expect(await h.client.respondAgentInteraction(h.input(second))).toMatchObject({ delivery: 'acp-acknowledged' })
  expect(h.responses).toEqual([
    { id: 'first-queued', decision: { outcome: 'selected', optionId: 'allow' } },
    { id: 'second-queued', decision: { outcome: 'selected', optionId: 'allow' } }
  ])
  for (const request of [first, second]) expect(await h.client.inspectAgentInteractionOperation(h.input(request))).toMatchObject({ delivery: 'acp-acknowledged' })
  expect(h.events.filter(event => event.type === 'agent-error')).toEqual([])
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('an old binding ACK cannot settle a current Run request with the same original native ID', async () => {
  let acknowledge!: () => void
  const ack = new Promise<void>(resolve => { acknowledge = resolve })
  const h = await fixture(async () => { await ack })
  const original = await h.permission('reused-native-id')
  const answer = h.client.respondAgentInteraction(h.input(original)).catch(error => error)
  await vi.waitFor(() => expect(h.responses).toHaveLength(1))
  const before = (await h.store.readMetadata(sid))!
  // Controlled original Store fact: another lifecycle owner already committed
  // the current Run/request while this binding's real ACK was still outstanding.
  const currentRequest = { ...original, evidence: { ...original.evidence,
    run: { runId: 'replacement-run' }, acpSessionId: 'replacement-native' } }
  await h.store.compareAndSwapMetadata(before, { ...before, run: { runId: 'replacement-run' },
    retiredRuns: [...before.retiredRuns, before.run],
    nativeHandle: { kind: 'acp', adapterId: 'original-sdk-binding', sessionId: 'replacement-native' },
    pendingInteraction: { request: currentRequest } })
  await h.inner.registry.load('local')
  acknowledge()
  await answer
  expect((await h.store.readMetadata(sid))?.pendingInteraction?.request,
    'old binding ACK must not clear the current original request').toEqual(currentRequest)
  expect(await h.client.inspectAgentInteractionOperation(h.input(original))).toMatchObject({ delivery: 'unknown' })
})

it('rebinding the same native request ID yields a distinct Core subject without a clock assumption', async () => {
  const h = await fixture()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  const first = await h.permission('reused-id')
  const oldInput = h.input(first)
  expect(await h.client.respondAgentInteraction(oldInput)).toMatchObject({ delivery: 'acp-acknowledged' })
  const bridge = Reflect.get(h.client, 'acp') as import('../src/acp-adapter.js').AgentMuxAcpBridge
  await bridge.unbind(sid)
  let emit!: (event: AgentMuxAcpEvent) => void
  const replacementResponses: unknown[] = []
  await h.client.bindAcp(sid, { adapterId: h.binding.adapterId, sessionId: h.binding.sessionId,
    onEvent(listener) { emit = listener; return () => {} },
    async respondPermission(id, decision) { replacementResponses.push({ id, decision }) }, async close() {} })
  emit({ type: 'permission', requestId: 'reused-id', title: 'Original permission',
    options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }, { id: 'deny', label: 'Reject always', kind: 'reject-always' }] })
  await vi.waitFor(() => expect(h.events.filter(event => event.type === 'interaction')).toHaveLength(2))
  const second = h.events.filter((event): event is Extract<AgentMuxClientEvent, { type: 'interaction' }> => event.type === 'interaction')[1]!.request
  expect(second.id).not.toBe(first.id)
  expect(second.evidence.acpBindingId).not.toBe(first.evidence.acpBindingId)
  expect(second.evidence.observedAt).toBe(first.evidence.observedAt)
  expect(second.evidence.run).toEqual(first.evidence.run)
  const permissionItems = h.events.filter((event): event is Extract<AgentMuxClientEvent, { type: 'agent-timeline' }> => event.type === 'agent-timeline')
    .flatMap(event => event.mutation.type === 'append' && event.mutation.item.kind === 'permission' ? [event.mutation.item.id] : [])
  expect(permissionItems).toHaveLength(2)
  expect(new Set(permissionItems).size).toBe(2)
  await expect(h.client.respondAgentInteraction({ ...oldInput, operationId: 'wrong-original-subject' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_INTERACTION' })
  expect(h.client.agentSession(sid).pendingInteraction?.request.id).toBe(second.id)
  expect(await h.client.inspectAgentInteractionOperation(oldInput)).toMatchObject({ delivery: 'acp-acknowledged', expectedRequest: first })
  expect(await h.client.respondAgentInteraction(h.input(second))).toMatchObject({ delivery: 'acp-acknowledged' })
  expect(replacementResponses).toEqual([{ id: 'reused-id', decision: { outcome: 'selected', optionId: 'allow' } }])
  vi.restoreAllMocks()
})

it('old binding observations cannot acquire a replacement Run for status, activity, native handle or permission', async () => {
  const h = await fixture()
  const before = (await h.store.readMetadata(sid))!
  await h.store.compareAndSwapMetadata(before, { ...before, run: { runId: 'replacement-run' }, retiredRuns: [before.run],
    nativeHandle: { kind: 'acp', adapterId: 'replacement-adapter', sessionId: 'replacement-native' } })
  await h.inner.registry.load('local')
  h.emit({ type: 'status', state: 'working' })
  h.emit({ type: 'activity', operation: 'append', activityId: 'old-activity', kind: 'assistant_message', status: 'complete', title: 'Old observation' })
  h.emit({ type: 'native-session', sessionId: 'old-native-transition' })
  h.emit({ type: 'permission', requestId: 'old-permission', title: 'Old permission', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }] })
  await vi.waitFor(() => expect(h.events.filter(event => event.type === 'agent-error' && event.code === 'ACP_OBSERVATION_UNCONFIRMED')).toHaveLength(4))
  const current = (await h.store.readMetadata(sid))!
  expect(current.nativeHandle).toEqual({ kind: 'acp', adapterId: 'replacement-adapter', sessionId: 'replacement-native' })
  expect(current.semanticStatus).toBeUndefined()
  expect(current.pendingInteraction).toBeUndefined()
  expect(h.events.filter(event => event.type === 'agent-timeline')).toEqual([])
  expect(h.responses).toEqual([])
})

it('original RPC and source CLI preserve the binding-qualified expectedRequest and reject a foreign result subject', async () => {
  const h = await fixture(), request = await h.permission('wire-request'), input = h.input(request)
  const socket = join(h.root, 'original.sock')
  const server = new AgentMuxControlServer({ socketPath: socket, coreClients: h.coreClients })
  await server.start()
  cleanups.push(async () => { await server.stop() })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
  cleanups.push(async () => { await rpc.dispose() })
  const file = join(h.root, 'response.json')
  await writeFile(file, JSON.stringify(input), { mode: 0o600 })
  const sent = await runStorageSourceCli(h.root, socket, ['agent', 'interaction', 'respond', '--input', file])
  expect(sent.code, sent.stderr + sent.stdout).toBe(0)
  const receipt = JSON.parse(sent.stdout).result
  expect(receipt.expectedRequest).toEqual(request)
  expect(receipt.expectedRequest.evidence.acpBindingId).toEqual(expect.any(String))
  expect(receipt.delivery).toBe('acp-acknowledged')
  expect((await rpc.call('agent.interaction.inspect', { agentSessionId: sid, operationId: input.operationId })).receipt).toEqual(receipt)
  const inspected = await runStorageSourceCli(h.root, socket, ['agent', 'interaction', 'inspect', '--session', sid, '--operation-id', input.operationId])
  expect(inspected.code, inspected.stderr + inspected.stdout).toBe(0)
  expect(JSON.parse(inspected.stdout).result.receipt).toEqual(receipt)
  expect(() => parseRpcNativeResult('agent.interaction.respond', { ...receipt, expectedRequest: { ...request,
    evidence: { ...request.evidence, acpBindingId: 'foreign-binding' } } }, input)).toThrow()
  const reopened = new AgentMuxFileAgentSessionStore(h.store.path)
  expect((await reopened.readMetadata(sid))?.interactionOperations?.[input.operationId]?.expectedRequest).toEqual(request)
  expect(h.responses).toEqual([{ id: 'wire-request', decision: { outcome: 'selected', optionId: 'allow' } }])
})

it('legacy receipts without binding facts remain inspectable unknown and never adopt a current binding', async () => {
  const h = await fixture(), current = await h.permission('legacy-native-id')
  const { acpBindingId: _binding, ...legacyEvidence } = current.evidence
  const legacyRequest = { ...current, id: 'legacy-native-id', evidence: legacyEvidence }
  const legacy = { operationId: 'legacy-original-answer', agentSessionId: sid, run: { runId }, expectedRequest: legacyRequest,
    response: { kind: 'permission' as const, requestId: legacyRequest.id, decision: { outcome: 'selected' as const, optionId: 'allow' } },
    delivery: 'unknown' as const, nativeAdoption: 'unknown' as const }
  const stored = (await h.store.readMetadata(sid))!
  await h.store.compareAndSwapMetadata(stored, { ...stored, interactionOperations: { ...stored.interactionOperations, [legacy.operationId]: legacy } })
  await h.inner.registry.load('local')
  const inspected = await h.client.inspectAgentInteractionOperation(legacy)
  expect(inspected).toEqual(legacy)
  expect(Object.hasOwn(inspected!.expectedRequest.evidence, 'acpBindingId')).toBe(false)
  expect(parseRpcNativeResult('agent.interaction.inspect', { receipt: legacy }, legacy)).toEqual({ receipt: legacy })
  expect(await h.client.respondAgentInteraction({ ...h.input(legacyRequest), operationId: legacy.operationId })).toEqual(legacy)
  expect(h.responses).toEqual([])
  expect(h.client.agentSession(sid).pendingInteraction?.request.id).toBe(current.id)
  expect(await h.client.respondAgentInteraction(h.input(current))).toMatchObject({ delivery: 'acp-acknowledged' })
  expect(h.responses).toEqual([{ id: 'legacy-native-id', decision: { outcome: 'selected', optionId: 'allow' } }])
})

it('same binding can reuse a native request ID after its earlier occurrence completed', async () => {
  const h = await fixture()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  const first = await h.permission('connection-key')
  expect(await h.client.respondAgentInteraction(h.input(first))).toMatchObject({ delivery: 'acp-acknowledged' })
  const second = await h.permission('connection-key')
  expect(second.id, 'wire correlation reuse must not alias Core occurrences').not.toBe(first.id)
  expect(second.evidence.acpBindingId).toBe(first.evidence.acpBindingId)
  expect(second.evidence.observedAt).toBe(first.evidence.observedAt)
  expect(await h.client.inspectAgentInteractionOperation(h.input(first))).toMatchObject({ expectedRequest: first, delivery: 'acp-acknowledged' })
  expect(await h.client.respondAgentInteraction(h.input(second))).toMatchObject({ expectedRequest: second, delivery: 'acp-acknowledged' })
  const permissionItems = h.events.filter((event): event is Extract<AgentMuxClientEvent, { type: 'agent-timeline' }> => event.type === 'agent-timeline')
    .flatMap(event => event.mutation.type === 'append' && event.mutation.item.kind === 'permission' ? [event.mutation.item.id] : [])
  expect(new Set(permissionItems).size).toBe(2)
  expect(h.responses).toEqual([
    { id: 'connection-key', decision: { outcome: 'selected', optionId: 'allow' } },
    { id: 'connection-key', decision: { outcome: 'selected', optionId: 'allow' } }
  ])
})

it('a reader without the original binding cannot clear a healthy owner request', async () => {
  const h = await fixture(), request = await h.permission('owner-still-waiting')
  const observer = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path), providers: [provider] })
  cleanups.push(async () => { await observer.dispose() })
  const registry = Reflect.get(observer, 'registry') as typeof h.inner.registry
  await registry.load('local')
  await Reflect.get(observer, 'recoverPendingInteractionResponses').call(observer, [])
  expect((await h.store.readMetadata(sid))?.pendingInteraction?.request,
    'missing local binding is not original request completion').toEqual(request)
  expect(observer.agentSession(sid).pendingInteraction?.request.responseUnavailableReason).toMatch(/original ACP binding/u)
  expect(h.client.agentSession(sid).pendingInteraction?.request.responseUnavailableReason).toBeUndefined()
  expect(await h.client.respondAgentInteraction(h.input(request))).toMatchObject({ delivery: 'acp-acknowledged' })
  expect(h.responses).toEqual([{ id: 'owner-still-waiting', decision: { outcome: 'selected', optionId: 'allow' } }])
})
