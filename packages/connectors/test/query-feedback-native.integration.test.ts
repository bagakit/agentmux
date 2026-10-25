import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import * as core from '../../core/src/index.js'
import * as processLeaves from '../../core/src/agent-native-process.js'
import { runSourceObjectCli } from '../../core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { signedRoomAdapter } from './fixtures/signed-room-adapter.js'
import { feishuPublicationHttp, type FeishuHttpCall, type FeishuHttpResponse } from './fixtures/feishu-publication.js'
import { feishuReactions } from './fixtures/feishu-reactions.js'
import { feishuConfig } from './fixtures/feishu.js'
import type { RoomBinding, ConnectionIngressMessage } from '@agentmux/core/connections'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const source = { providerId: 'codex', nativeSessionId: 'original-native-thread' }, turn = 'original-native-turn'
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
async function fixture(options: { providerId?: 'codex' | 'claude'; narrow?: boolean; missingCapturedCut?: boolean; beforeBind?: unknown[]; beforeBindCapture?: boolean; response?: (call: FeishuHttpCall) => FeishuHttpResponse | undefined } = {}) {
  const source = { providerId: options.providerId ?? 'codex', nativeSessionId: 'original-native-thread' }
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: source.providerId, executorId: source.providerId, nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId, transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl'), ref = { hostId: 'local', agentSessionId: 'original-agent' }
  await writeFile(transcript, jsonl([...(source.providerId === 'claude' ? [{ sessionId: source.nativeSessionId, uuid: 'original-before-cut', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Private before bind.' }] } }] : [{ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: f.root, history_mode: 'paginated' } }]), ...options.beforeBind ?? []]))
  const capturedBefore = { id: 'captured-before-binding', agentSessionId: ref.agentSessionId, kind: 'lifecycle' as const, source: 'native-hook' as const, status: 'complete' as const, title: 'Original process', createdAt: 1, updatedAt: 1 }
  if (options.beforeBindCapture) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: capturedBefore })
  const actor = { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-actor', lifecycleOperationId: 'original-launch', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
  const saved = (await f.store.readMetadata(ref.agentSessionId))!
  await f.store.compareAndSwapMetadata(saved, { ...saved, nativeActor: actor, nativeBinding: { source: 'user-selected', run: saved.run, observedAt: saved.updatedAt } }); await f.inner.registry.load('local')
  f.inner.kernel.status = async (id: string) => ({ ...f.run(id), pid: 1234 })
  // Only Runtime process observations and the native server are controlled. The real
  // built-in Provider prepares, rechecks, serializes and confirms its native RPC input.
  const sends: any[] = [], server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const endpoint = 'ws://127.0.0.1:' + (server.address() as { port: number }).port
  vi.spyOn(processLeaves, 'nativeProcessBirth').mockResolvedValue('original-process-birth')
  vi.spyOn(processLeaves, 'nativeProcessTcpListeners').mockResolvedValue([{ processId: 1234, endpoint }])
  server.on('connection', (socket, request) => {
    expect(request.headers.authorization).toBe('Bearer ' + actor.token)
    socket.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (!Object.hasOwn(message, 'id')) return
      let result: unknown = {}
      if (message.method === 'thread/read') result = { thread: { id: source.nativeSessionId, canAcceptDirectInput: true, status: { type: 'idle' } } }
      else if (message.method === 'turn/start') { sends.push(message.params); result = { turn: { id: turn } } }
      else expect(message.method).toBe('initialize')
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: ref.agentSessionId, runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {} } })
  const remote = feishuReactions(), reactions = remote.active
  const http = await feishuPublicationHttp(call => options.response?.(call) ?? remote.handle(call)); cleanup.push(http.close)
  const wire = signedRoomAdapter('feishu'), verify = wire.adapter.ingress!.verify
  const adapter = { ...wire.adapter, publication: new FeishuAdapter({ http: http.http }).publication, ingress: { ...wire.adapter.ingress!, verify: async (...args: Parameters<typeof verify>) => ({ ...await verify(...args), conversationKind: 'group' as const }) } }
  let missingCapturedCut = options.missingCapturedCut
  const checkpoint = async (input: Parameters<typeof f.client.conversationCheckpoint>[0]) => {
    const page = await f.client.conversationCheckpoint(input)
    if (!missingCapturedCut) return page
    // An original native-only grant is a frozen historical fixture, not a new cut.
    const scope = { sources: page.scope.sources.filter(source => source.kind === 'native') }
    return { ...page, scope, coverage: page.coverage.filter(value => value.source.kind === 'native'), checkpoint: { ...page.checkpoint, frontier: { ...page.checkpoint.frontier, scope, cuts: page.checkpoint.frontier.cuts.filter(cut => cut.kind === 'native') } } }
  }
  let activatePublication = !options.narrow
  const openServices = () => createConnectionServices({ directory: join(f.root, 'connections'), adapters: [adapter], bindings: { spatial, checkpoint }, ingress: { core: host => host === 'local' ? f.client : undefined }, ...(activatePublication ? { publication: createPublicationConversationPort(f.coreClients) } : {}) })
  let services = await openServices(); cleanup.push(() => services.close())
  const secret = await services.secrets.store({ operationId: 'original-secret', secret: 'fixture-signing-key' })
  await services.connections.configure({ operationId: 'original-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: secret.credentialRef } })
  const context = { actor: { kind: 'user' as const, id: 'owner' } }
  const bindInput = { operationId: 'original-bind', bindingId: 'original-binding', connectionId: feishuConfig.connectionId, expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: ref.agentSessionId, regionAnchor: { regionId: 'region' }, externalConversationId: 'original-room', expectedSource: source,
    inputTarget: { kind: 'native-conversation', source }, scope: { input: 'all-messages', publication: 'future-shared-conversation' } } as const
  const linked = await services.bindings!.bind(bindInput, context)
  expect(linked.state).toBe('applied'); let binding = (linked as { binding: RoomBinding }).binding
  if (options.narrow) {
    // Load an original recorded narrow grant. The public bind/relink API intentionally
    // accepts shared scope only; this fixture does not grant a new narrow capability.
    binding = { ...binding, scope: { ...binding.scope, publication: 'future-native-user-facing' } }
    services.database!.prepare('UPDATE room_binding_revision SET snapshot_json=? WHERE binding_id=? AND revision=?').run(JSON.stringify(binding), binding.bindingId, binding.revision)
    services.database!.prepare('UPDATE room_binding_operation SET result_json=? WHERE operation_id=?').run(JSON.stringify({ ...linked, binding }), bindInput.operationId)
    await services.close(); activatePublication = true; services = await openServices()
  }
  const member = { application: feishuConfig.application, idType: 'email', userId: 'original@example.test' }
  const grant = { operationId: 'original-grant', bindingId: binding.bindingId, expectedBindingRevision: 1, grantId: 'original-member', expectedRevision: null, actor: member, state: 'active' as const, capabilities: ['input' as const] }
  await services.bindings!.grant(grant, context)
  await expect.poll(() => wire.endpoint).toBeDefined()
  const operations = () => services.publication!.store.list(binding, 100).filter(value => value.queryFeedback && value.effect === 'upsert')
  const stages = () => operations().map(value => value.queryFeedback!.stage)
  const restore = () => { f.inner.connected = true; f.inner.kernel.isConnected = () => true; Reflect.get(f.client, 'publisher').publish({ type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() } }) }
  return { ...f, transcript, ref, capturedBefore, get services() { return services }, wire, http, sends, reactions, remote, get binding() { return binding }, member, stages, operations, restore,
    async relink() { missingCapturedCut = false; const linked = await services.bindings!.relink({ ...bindInput, operationId: 'explicit-fresh-relink', expectedRevision: binding.revision }, context); expect(linked.state).toBe('applied'); if (linked.state === 'applied') binding = linked.binding; services.publication!.refresh(); return linked },
    async hook(receiptId: string, sequence: number, turnId: string) {
      const accept = Reflect.get(f.client, 'acceptHookEvent') as (envelope: core.NativeHookEnvelope, signal: AbortSignal) => Promise<void>
      await accept.call(f.client, { receiptId, eventName: 'turn.complete', agentSessionId: ref.agentSessionId, providerId: source.providerId, runId: saved.run.runId, payload: { hook_event_name: 'turn.complete', session_id: source.nativeSessionId, sourceId: 'original-hook-observer', sequence, turnId, reason: 'error', isAborted: false } }, AbortSignal.timeout(5000))
      services.publication!.refresh()
    },
    async reopen() { await services.close(); services = await openServices(); services.publication!.refresh() },
    revoke: () => services.bindings!.grant({ ...grant, operationId: 'revoke-original', expectedRevision: 1, state: 'revoked', capabilities: [] }, context),
    async send() { await wire.post({ deliveryKey: 'original-event', recordKey: 'original-query', roomKey: 'original-room', person: member.userId, text: 'Original user query', addressing: 'broadcast' }); let query: ConnectionIngressMessage | undefined
      await expect.poll(async () => { query = (await services.ingress!.list({ connectionId: binding.connectionId })).ingresses.find(row => row.kind !== 'action' && row.externalMessageId === 'original-query') as ConnectionIngressMessage; return query?.state }).toBe('claimed'); return query! },
    async native(kind: 'valid' | 'wrong-source' | 'ambiguous') { const sent = sends[0]; expect(sent).toBeDefined(); const row = (id: string) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: kind === 'wrong-source' ? 'foreign-native-thread' : source.nativeSessionId, turn_id: turn, item: { type: 'UserMessage', id, client_id: sent.clientUserMessageId, content: sent.input } } }); await appendFile(transcript, jsonl([row('original-native-user'), ...(kind === 'ambiguous' ? [row('distinct-native-user')] : [])])); services.publication!.refresh() },
    async complete(target = turn, error?: unknown, interrupted = false) { await appendFile(transcript, jsonl([{ type: 'event_msg', payload: { type: interrupted ? 'turn_aborted' : 'task_complete', turn_id: target, ...(error === undefined ? {} : { error }), ...(interrupted ? { reason: 'interrupted' } : {}) } }])); services.publication!.refresh() }
  }
}

it('default group feeds the real native RPC Provider and publishes five distinct factual milestones through the SDK', async () => {
  const f = await fixture(); f.inner.connected = false; f.inner.kernel.isConnected = () => false
  const query = await f.send()
  await expect.poll(f.stages, { timeout: 5000 }).toContain('queued')
  f.restore(); await expect.poll(f.stages, { timeout: 10000 }).toContain('dispatched')
  expect((await f.services.ingress!.inspect({ ingressId: query.ingressId })).inputReceipt?.status).toBe('admitted')
  expect(f.sends).toHaveLength(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.native('valid'); await expect.poll(f.stages, { timeout: 5000 }).toContain('started')
  await f.complete('other-turn'); await new Promise<void>(resolve => setImmediate(resolve)); expect(f.stages()).not.toContain('completed')
  await f.complete(); await expect.poll(f.stages, { timeout: 5000 }).toContain('completed')
  const completed = (await f.client.sessionHistoryPage(f.ref.agentSessionId)).items.find(item => item.turnId === turn && item.turnOutcome?.status === 'completed')
  expect(completed).toBeDefined(); expect(completed!.metrics).toBeUndefined()
  await expect.poll(() => f.operations().every(value => ['confirmed', 'superseded'].includes(value.state))).toBe(true)
  expect(f.stages()).toEqual(['received', 'queued', 'dispatched', 'started', 'completed'])
  await expect.poll(() => f.reactions.map(value => value.reaction_type.emoji_type)).toEqual(['DONE'])
  expect(f.reactions.every(value => value.path.endsWith('/original-query/reactions'))).toBe(true)
}, 30000)

it.each([['completed', 'DONE'], ['failed', 'CrossMark'], ['interrupted', 'MinusOne']] as const)('replaces earlier markers with the same terminal phase for an original %s outcome', async (outcome, emoji) => {
  const f = await fixture(); await f.send(); await expect.poll(f.stages, { timeout: 10000 }).toContain('dispatched')
  await f.native('valid'); await expect.poll(() => f.operations().find(value => value.queryFeedback?.stage === 'started')?.state).toBe('confirmed')
  const started = f.operations().find(value => value.queryFeedback?.stage === 'started')!
  const path = '/open-apis/im/v1/messages/original-query/reactions'
  const unrelated = [f.remote.seed(path, 'OnIt', { operator_type: 'user', operator_id: 'another-person' }), f.remote.seed(path, 'SMILE')]
  await f.complete(turn, outcome === 'failed' ? { message: 'Original native turn failed' } : undefined, outcome === 'interrupted')
  await expect.poll(() => f.operations().find(value => value.queryFeedback?.stage === outcome)?.state, { timeout: 5000 }).toBe('confirmed')
  const active = () => f.reactions.filter(value => !unrelated.includes(value)).map(value => value.reaction_type.emoji_type)
  try { await expect.poll(active, { timeout: 5000 }).toEqual([emoji]) }
  catch (error) { expect(active(), 'A confirmed terminal outcome must retire earlier managed markers').toEqual([emoji]); throw error }
  const withdrawal = f.services.publication!.store.list(f.binding, 100).find(value => value.predecessorOperationId === started.operationId)!
  expect(withdrawal).toMatchObject({ effect: 'withdraw', state: 'confirmed', mapping: started.mapping })
  expect(f.reactions.filter(value => unrelated.includes(value))).toEqual(unrelated)
  const created = f.remote.calls.findIndex(call => call.method === 'POST' && JSON.parse(call.body).reaction_type.emoji_type === emoji)
  const deleted = f.remote.calls.findIndex(call => call.method === 'DELETE' && call.path.endsWith('/' + started.mapping!.reactionId))
  expect(created).toBeGreaterThanOrEqual(0); expect(deleted).toBeGreaterThan(created)
  expect(f.sends).toHaveLength(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('a late started acknowledgement cannot retain or downgrade a confirmed failed outcome', async () => {
  const f = await fixture(); await f.send(); await expect.poll(f.stages, { timeout: 10000 }).toContain('dispatched')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), request = f.http.http.request.bind(f.http.http)
  f.http.http.request = async (...args: Parameters<typeof request>) => {
    const result: any = await request(...args)
    if (String(args[0].method).toUpperCase() === 'POST' && result?.data?.reaction_type?.emoji_type === 'OnIt') await held
    return result
  }
  try {
    await f.native('valid'); await expect.poll(() => f.remote.created.some(value => value.reaction_type.emoji_type === 'OnIt')).toBe(true)
    await f.complete(turn, { message: 'Original native turn failed' })
    await expect.poll(() => f.operations().find(value => value.queryFeedback?.stage === 'failed')?.state, { timeout: 35000 }).toBe('confirmed')
    const failed = f.operations().find(value => value.queryFeedback?.stage === 'failed')!
    release()
    await expect.poll(() => f.reactions.map(value => value.reaction_type.emoji_type), { timeout: 5000 }).toEqual(['CrossMark'])
    expect(f.operations().find(value => value.queryFeedback?.stage === 'failed')).toEqual(failed)
    expect(f.remote.created.filter(value => value.reaction_type.emoji_type === 'OnIt')).toHaveLength(1)
    expect(f.sends).toHaveLength(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release() }
}, 45000)

it.each(['wrong-source', 'ambiguous', 'revoked'] as const)('retains input availability but cannot invent native processing for %s evidence', async kind => {
  const f = await fixture(); await f.send(); await expect.poll(f.stages, { timeout: 10000 }).toContain('dispatched')
  if (kind === 'revoked') await f.revoke()
  const committed = vi.spyOn(f.services.publication!.store, 'commitPage')
  await f.native(kind === 'revoked' ? 'valid' : kind); await f.complete()
  await expect.poll(async () => (await f.client.sessionHistoryPage(f.ref.agentSessionId)).items.length).toBeGreaterThanOrEqual(kind === 'ambiguous' ? 3 : 2)
  // Await the real original publication read, not an arbitrary sleep.
  const publication = f.services.publication!; publication.refresh()
  await expect.poll(() => committed.mock.calls.some(call => call[4]?.units.some(unit => unit.records.some(record => record.original.kind === 'native' && record.original.item.turnId === turn))), { timeout: 5000 }).toBe(true)
  await expect.poll(() => Reflect.get(publication, 'lanes').get(f.binding.bindingId)?.work === undefined).toBe(true)
  expect(f.stages().filter(stage => stage !== 'queued')).toEqual(['received', 'dispatched']); expect(f.sends).toHaveLength(1)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 30000)

it.each(['revoked', 'temporarily-unavailable'] as const)('a retained reaction with %s authority cannot block independent speech or lose its original recovery identity', async kind => {
  const f = await fixture(); f.inner.connected = false; f.inner.kernel.isConnected = () => false
  const connections = Reflect.get(f.services.publication!, 'options').connections as import('../src/connection-host.js').ConnectionHost
  const resolveCredential = connections.resolveCredential.bind(connections)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const credentials = vi.spyOn(connections, 'resolveCredential').mockImplementation(async id => { await held; return await resolveCredential(id) })
  let restoreAuthority: (() => void) | undefined
  let queuedId = ''
  try {
    await f.send(); await expect.poll(f.stages, { timeout: 10000 }).toContain('queued')
    queuedId = f.operations().find(value => value.queryFeedback?.stage === 'queued')!.operationId
    expect(f.services.publication!.store.inspect(queuedId)?.state).toBe('pending')
    if (kind === 'revoked') await f.revoke()
    else {
      const bindings = Reflect.get(f.services.ingress!, 'options').bindings
      const unavailable = vi.spyOn(bindings, 'effectiveGrant').mockImplementation(() => { throw Error('Original authority owner temporarily unavailable') })
      restoreAuthority = () => unavailable.mockRestore()
    }
  } finally { release(); credentials.mockRestore() }
  await appendFile(f.transcript, jsonl([{ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'independent-answer', content: [{ type: 'output_text', text: 'Original conversation can still publish an independent answer.' }] } }]))
  f.services.publication!.refresh()
  await expect.poll(() => f.services.publication!.store.list(f.binding, 100).some(value => value.payload.kind === 'speech' && value.state === 'confirmed'), { timeout: 10000 }).toBe(true)
  expect(f.services.publication!.store.inspect(queuedId)?.state).toBe('pending')
  expect(f.reactions.some(value => value.reaction_type.emoji_type === 'OneSecond')).toBe(false)
  if (restoreAuthority) {
    restoreAuthority(); f.services.publication!.refresh()
    await expect.poll(() => f.services.publication!.store.inspect(queuedId)?.state, { timeout: 5000 }).toBe('confirmed')
    expect(f.operations().filter(value => value.queryFeedback?.stage === 'queued').map(value => value.operationId)).toEqual([queuedId])
    expect(f.reactions.filter(value => value.reaction_type.emoji_type === 'OneSecond')).toHaveLength(1)
  }
}, 30000)

it('the original Hosted ingress port consumes recipient changes and exact receipts through the fenced public Runtime owner', async () => {
  const { AgentMuxHostedRuntimeService } = await import('../../core/src/hosted-runtime-service.js')
  const { connectHostedAgentMux } = await import('../../core/src/hosted-client.js')
  const { hostedTestOwner } = await import('../../core/test/helpers/hosted-runtime-port.js')
  const { createHostedIngressCorePort } = await import('../src/core-ingress-port.js')
  const f = await rpcOwnerFixture(['recipient'], core); cleanup.push(f.close)
  f.inner.connected = false; f.inner.kernel.isConnected = () => false
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client)); cleanup.push(() => service.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'hosted.sock'), coreClients: f.coreClients, hostedRuntime: () => service })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  vi.spyOn(f.client, 'connect').mockRejectedValue(new Error('Controlled Runtime observation unavailable'))
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false, forwardRpc: (method, params, context) => rpc.call(method, params as never, context?.signal ? { signal: context.signal } : {}) }); cleanup.push(() => hosted.dispose())
  const route = createHostedIngressCorePort(() => [{ hostId: 'exact-host', client: hosted }])
  const port = route('exact-host', hostedTestOwner(f.client).runtimeId)!, cut = await port.readAgentInputChanges!({ agentSessionId: 'recipient' })
  const receipt = await f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'hosted-original', prompt: 'Private unchanged input', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  if (!receipt) throw Error('Original prompt receipt is missing')
  const changed = await port.readAgentInputChanges!({ agentSessionId: 'recipient', after: cut.checkpoint!, limit: 25 })
  expect(changed.changes.map(value => value.key)).toEqual([receipt.key])
  expect(await port.inspectAgentInput({ key: receipt.key })).toMatchObject({ persistence: 'confirmed', status: 'waiting', ref: receipt.ref })
  expect(JSON.stringify(changed)).not.toContain('Private unchanged input')
  await expect(route('exact-host', 'wrong-original-runtime')!.readAgentInputChanges!({ agentSessionId: 'recipient', after: cut.checkpoint! })).rejects.toBeDefined()
  expect(route('foreign-host')).toBeUndefined(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 15000)


const capacity = { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' }
const failures = (f: Awaited<ReturnType<typeof fixture>>) => f.services.publication!.store.list(f.binding, 100).filter(operation => operation.payload.kind === 'failure')
const failurePosts = (f: Awaited<ReturnType<typeof fixture>>) => f.http.messageCalls().filter(call => call.method === 'POST' && call.path.endsWith('/messages') && call.body.includes('Request failed'))

it('provider outcome publishes capacity failure once through public conversation and the Feishu SDK without DONE, including exact same-event capture and reopen', async () => {
  const f = await fixture(); await f.send(); await expect.poll(f.stages, { timeout: 10000 }).toContain('dispatched')
  await f.native('valid'); await expect.poll(f.stages).toContain('started'); await f.complete(turn, capacity)
  await expect.poll(() => failures(f).map(value => value.state), { timeout: 10000 }).toEqual(['confirmed'])
  await expect.poll(() => f.operations().find(value => value.queryFeedback?.stage === 'failed')?.state).toBe('confirmed')
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'outcome.sock'), connections: f.services.connections, coreClients: f.coreClients })
  await server.start()
  try {
    const feedback = f.operations().find(value => value.queryFeedback?.stage === 'failed')!
    const result = await runSourceObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'inspect', '--operation-id', feedback.operationId], objectCliEnvironment(f.root), '', 30000,
      new URL('../../core/test/fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url))
    expect(result.code, result.stdout + result.stderr).toBe(0)
    const inspected = JSON.parse(result.stdout).result
    expect(inspected.delivery).toMatchObject({ operationId: feedback.operationId, state: 'confirmed', queryFeedback: { stage: 'failed', messageId: 'original-query' } })
    for (const privateField of ['queryTurn', 'queryCompletion', 'payload', capacity.message]) expect(JSON.stringify(inspected)).not.toContain(privateField)
  } finally { await server.stop() }
  expect(f.stages()).not.toContain('completed'); expect(f.reactions.map(value => value.reaction_type.emoji_type)).toContain('CrossMark')
  expect(f.reactions.map(value => value.reaction_type.emoji_type)).not.toContain('DONE')
  const first = failures(f)[0]!, history = await f.client.sessionHistoryPage(f.ref.agentSessionId)
  const native = history.items.find(item => item.turnOutcome?.status === 'failed')!
  expect(native.turnOutcome?.status).toBe('failed')
  expect(first.payload).toMatchObject({ kind: 'failure', turnId: turn, code: 'AGENT_MODEL_OVERLOADED' })
  expect(JSON.stringify(first.payload)).not.toContain('server_overloaded')
  expect(failurePosts(f)).toHaveLength(1)
  const card = JSON.parse(JSON.parse(failurePosts(f)[0]!.body).content)
  expect(card.header.title.content).toBe('Request failed'); expect(card.elements[0].text.content).toBe('The selected model is at capacity.')
  expect('httpStatusCode' in first.payload).toBe(false)
  expect(JSON.stringify(card)).toContain('amux://agent/original-agent')
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.ref.agentSessionId, item: {
    id: 'captured-same-failure', agentSessionId: f.ref.agentSessionId, kind: 'lifecycle', source: 'native-hook', status: 'failed', title: 'Original turn failure', createdAt: 100, updatedAt: 100,
    turnOutcome: native.turnOutcome, conversation: { sameEvent: first.reference as import('@agentmux/core/conversation').ConversationItemRef }
  } })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.ref.agentSessionId, item: {
    id: 'partial-answer-same-event', agentSessionId: f.ref.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Partial answer', createdAt: 101, updatedAt: 101,
    content: 'Partial answer retained with the original failure.', contentEligibility: 'public', authorAgentSessionId: f.ref.agentSessionId, conversation: { sameEvent: first.reference as import('@agentmux/core/conversation').ConversationItemRef }
  } })
  f.services.publication!.refresh()
  await expect.poll(() => JSON.stringify([...f.http.records.values()])).toContain('Partial answer retained with the original failure.')
  await expect.poll(() => f.services.publication!.store.coverage(f.binding).gaps.filter(value => value.code === 'CONVERSATION_ANCHOR_UNREAD')).toEqual([])
  await f.reopen()
  await expect.poll(() => Reflect.get(f.services.publication!, 'lanes').get(f.binding.bindingId)?.work === undefined).toBe(true)
  expect(failurePosts(f)).toHaveLength(1); expect(failures(f).map(value => value.operationId)).toEqual([first.operationId])
  await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: f.ref.agentSessionId, item: {
    id: 'captured-same-failure', agentSessionId: f.ref.agentSessionId, kind: 'lifecycle', source: 'native-hook', status: 'failed', title: 'Original turn failure', createdAt: 100, updatedAt: 102,
    turnOutcome: native.turnOutcome
  } })
  f.services.publication!.refresh()
  await expect.poll(() => f.services.publication!.store.coverage(f.binding).gaps.some(value => value.code === 'PUBLICATION_REPRESENTATION_RELATION_UNCONFIRMED')).toBe(true)
  expect(failurePosts(f)).toHaveLength(1)
  await f.complete('distinct-failed-turn', capacity)
  await expect.poll(() => failures(f).map(value => value.state)).toEqual(['confirmed', 'confirmed'])
  expect(failurePosts(f)).toHaveLength(2); expect(new Set(failures(f).map(value => value.operationId)).size).toBe(2)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 30000)

it('provider outcome keeps unknown native details private, preserves the audience cut, and lets a new turn publish independently', async () => {
  const secret = 'private-native-error-details', nativeCode = 'private-unknown-native-code'
  const f = await fixture({ beforeBind: [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old-turn', error: capacity } }] })
  await f.complete(turn, { message: secret, codex_error_info: nativeCode })
  await appendFile(f.transcript, jsonl([
    { type: 'event_msg', payload: { type: 'unclassified-process', message: 'private-process-record' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'healthy-next-answer', content: [{ type: 'output_text', text: 'The next turn remains available.' }] } }
  ])); f.services.publication!.refresh()
  await expect.poll(() => failures(f).map(value => value.state), { timeout: 10000 }).toEqual(['confirmed'])
  await expect.poll(() => JSON.stringify([...f.http.records.values()])).toContain('The next turn remains available.')
  const operations = f.services.publication!.store.list(f.binding, 100), wire = JSON.stringify(f.http.messageCalls())
  expect(failures(f)[0]!.payload).toMatchObject({ kind: 'failure', turnId: turn })
  expect('message' in failures(f)[0]!.payload).toBe(false)
  expect(wire).toContain('The Agent could not complete this request.')
  for (const privateValue of [secret, nativeCode, 'private-process-record', 'old-turn']) expect(wire).not.toContain(privateValue)
  expect(operations.filter(value => value.queryFeedback)).toEqual([])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20000)

it('provider outcome distinguishes interruption and requires original adoption before failed query feedback', async () => {
  const f = await fixture(); await f.send(); await expect.poll(f.stages, { timeout: 10000 }).toContain('dispatched')
  await f.complete('unadopted-turn', capacity)
  await expect.poll(() => failures(f).map(value => value.state), { timeout: 10000 }).toEqual(['confirmed'])
  expect(f.stages()).not.toContain('failed')
  await f.native('valid'); await expect.poll(f.stages).toContain('started'); await f.complete(turn, undefined, true)
  await expect.poll(() => f.operations().find(value => value.queryFeedback?.stage === 'interrupted')?.state).toBe('confirmed')
  expect(f.reactions.map(value => value.reaction_type.emoji_type)).toContain('MinusOne')
  expect(f.stages()).not.toContain('completed'); expect(f.stages()).not.toContain('failed'); expect(failures(f)).toHaveLength(1)
}, 30000)

it('provider outcome preserves an unknown failure effect across reopen without replay or blocking the next answer', async () => {
  const f = await fixture({ response: call => call.method === 'POST' && call.path.endsWith('/messages') && call.body.includes('Request failed')
    ? { status: 503, body: { code: 1 } } : undefined })
  await f.complete(turn, capacity)
  await expect.poll(() => failures(f)[0]?.state, { timeout: 10000 }).toBe('unknown')
  const first = failures(f)[0]!, prepared = first.prepared
  await f.reopen()
  await appendFile(f.transcript, jsonl([{ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'next-independent-answer', content: [{ type: 'output_text', text: 'Independent next answer.' }] } }]))
  f.services.publication!.refresh()
  await expect.poll(() => JSON.stringify([...f.http.records.values()]), { timeout: 10000 }).toContain('Independent next answer.')
  expect(failures(f)[0]).toMatchObject({ operationId: first.operationId, state: 'unknown', prepared })
  expect(failurePosts(f)).toHaveLength(1)
}, 30000)


it('provider outcome publishes a generic captured failure without content bytes, keeps its original cut, and uses the same payload in Discord', async () => {
  const f = await fixture({ beforeBindCapture: true })
  const outcome: core.AgentTurnOutcome = { status: 'failed', failure: { code: 'AGENT_PROVIDER_ERROR', message: 'private raw captured failure', nativeCode: 'private native code', nativeTurnId: 'captured-turn', recovery: 'Inspect the original conversation before explicitly retrying.' } }
  await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: f.ref.agentSessionId, item: { ...f.capturedBefore, status: 'failed', updatedAt: 2, turnOutcome: outcome } })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.ref.agentSessionId, item: { ...f.capturedBefore, id: 'generic-new-failure', status: 'failed', updatedAt: 3, turnOutcome: outcome } })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.ref.agentSessionId, item: { ...f.capturedBefore, id: 'unclassified-process', status: 'failed', updatedAt: 4, content: 'private unclassified process' } })
  f.services.publication!.refresh()
  await expect.poll(() => failures(f).map(value => value.state), { timeout: 10000 }).toEqual(['confirmed'])
  expect(failures(f)[0]!.reference.source).toMatchObject({ kind: 'captured', recordId: 'generic-new-failure' })
  expect(f.services.publication!.store.coverage(f.binding).gaps).toContainEqual(expect.objectContaining({ reason: 'start-cut-unconfirmed', record: expect.objectContaining({ source: { kind: 'captured', recordId: 'captured-before-binding' } }) }))
  expect(failurePosts(f)).toHaveLength(1)
  const { prepareDiscordPublication } = await import('../src/adapters/discord/render.js')
  const original = failures(f)[0]!, { mapping: _mapping, ...pending } = original
  const prepared = prepareDiscordPublication({ ...pending, target: { ...original.target, externalConversationId: '123456789012345678', application: { ...original.target.application, appId: '123456789012345679', domain: 'discord.com' } } })
  const body = JSON.parse(prepared.request.body!)
  expect(body.allowed_mentions).toEqual({ parse: [] }); expect(prepared.requestKey).toBe(original.operationId)
  for (const wire of [JSON.stringify(f.http.messageCalls()), prepared.request.body!]) {
    expect(wire).toContain('The Agent could not complete this request.')
    expect(wire).toContain('amux://agent/original-agent')
    expect(wire).not.toContain('private raw captured failure'); expect(wire).not.toContain('private native code'); expect(wire).not.toContain('private unclassified process')
  }
}, 20000)


it('provider outcome leaves an unqualified failure pending and diagnosed while independent conversation delivery remains available', async () => {
  const f = await fixture()
  const store = f.services.publication!.store, qualify = store.qualifyPending.bind(store)
  vi.spyOn(store, 'qualifyPending').mockImplementation((...args) => args[1].payload.kind === 'failure' ? 'unavailable' : qualify(...args))
  await f.complete(turn, capacity)
  await expect.poll(() => failures(f)[0]?.state).toBe('pending')
  const operationId = failures(f)[0]!.operationId
  await appendFile(f.transcript, jsonl([{ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'independent-public-answer', content: [{ type: 'output_text', text: 'Still able to publish an independent answer.' }] } }]))
  f.services.publication!.refresh()
  await expect.poll(() => JSON.stringify([...f.http.records.values()]), { timeout: 10000 }).toContain('Still able to publish an independent answer.')
  expect(f.services.publication!.store.inspect(operationId)).toMatchObject({ operationId, state: 'pending' })
  expect(failurePosts(f)).toHaveLength(0)
  expect(f.services.publication!.observation(f.binding.bindingId, f.binding.revision)).toMatchObject({ state: 'unavailable', reason: 'source-unconfirmed' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20000)


it('provider outcome publishes an existing narrow Claude captured failure through its original Hook and preserves the raw content boundary', async () => {
  const f = await fixture({ providerId: 'claude', narrow: true, beforeBindCapture: true })
  expect(f.binding.sourceFrontier!.frontier.cuts.some(cut => cut.kind === 'captured')).toBe(true)
  await f.hook('original-claude-failure', 1, 'original-claude-turn')
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.ref.agentSessionId, item: { ...f.capturedBefore, id: 'captured-private-reply', kind: 'assistant_message', content: 'Narrow private captured reply', contentEligibility: 'public' } })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.ref.agentSessionId, item: { ...f.capturedBefore, id: 'captured-private-process', content: 'Narrow private process content' } })
  f.services.publication!.refresh()
  await expect.poll(() => failures(f).map(value => value.state), { timeout: 10000 }).toEqual(['confirmed'])
  const original = failures(f)[0]!
  expect(original.reference.source.kind).toBe('captured')
  expect(original.payload).toMatchObject({ kind: 'failure', turnId: 'original-claude-turn', message: 'Claude could not finish this request.' })
  await f.reopen()
  await f.hook('original-claude-failure', 1, 'original-claude-turn')
  expect(failures(f).map(value => value.operationId)).toEqual([original.operationId])
  const wire = JSON.stringify(f.http.messageCalls())
  expect(wire).toContain('Claude could not finish this request.')
  expect(wire).not.toContain('Narrow private captured reply'); expect(wire).not.toContain('Narrow private process content')
  expect(wire).not.toContain('The native Claude turn ended in error')
  expect(failurePosts(f)).toHaveLength(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20000)

it('provider outcome retains an old narrow missing cut across reopen and accepts only failures after explicit fresh relink', async () => {
  const f = await fixture({ providerId: 'claude', narrow: true, missingCapturedCut: true })
  const original = f.binding
  expect(original.sourceFrontier!.frontier.cuts.every(cut => cut.kind === 'native')).toBe(true)
  await f.hook('before-relink-failure', 1, 'before-relink-turn')
  await expect.poll(() => f.services.publication!.store.coverage(f.binding).gaps).toContainEqual(expect.objectContaining({ reason: 'start-cut-unconfirmed', code: 'PUBLICATION_CAPTURED_START_UNCONFIRMED' }))
  await f.reopen()
  expect(f.services.bindings!.readCurrent(original.bindingId)).toEqual(original)
  expect(failures(f)).toHaveLength(0)
  await f.relink()
  expect(f.binding.revision).toBe(2)
  expect(f.binding.sourceFrontier!.frontier.cuts.some(cut => cut.kind === 'captured')).toBe(true)
  await f.hook('after-relink-failure', 2, 'after-relink-turn')
  await expect.poll(() => failures(f).map(value => value.state), { timeout: 10000 }).toEqual(['confirmed'])
  expect(failures(f)[0]!.payload).toMatchObject({ turnId: 'after-relink-turn' })
  expect(f.services.publication!.store.coverage(original).gaps).toContainEqual(expect.objectContaining({ reason: 'start-cut-unconfirmed' }))
  expect(failurePosts(f)).toHaveLength(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20000)
