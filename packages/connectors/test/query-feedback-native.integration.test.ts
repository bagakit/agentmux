import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import * as core from '../../core/src/index.js'
import * as processLeaves from '../../core/src/agent-native-process.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { signedRoomAdapter } from './fixtures/signed-room-adapter.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { feishuConfig } from './fixtures/feishu.js'
import type { RoomBinding, ConnectionIngressMessage } from '@agentmux/core/connections'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const source = { providerId: 'codex', nativeSessionId: 'original-native-thread' }, turn = 'original-native-turn'
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
async function fixture() {
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'codex', executorId: 'codex', nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId, transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl'), ref = { hostId: 'local', agentSessionId: 'original-agent' }
  await writeFile(transcript, jsonl([{ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: f.root, history_mode: 'paginated' } }]))
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
  const reactions: any[] = [], http = await feishuPublicationHttp(call => {
    if (!call.path.endsWith('/reactions')) return
    if (call.method === 'POST') { const reaction = { reaction_id: 'reaction-' + reactions.length, operator: { operator_type: 'app', operator_id: feishuConfig.application.appId }, reaction_type: JSON.parse(call.body).reaction_type }; reactions.push({ ...reaction, path: call.path }); return { status: 200, body: { code: 0, data: reaction } } }
    return { status: 200, body: { code: 0, data: { items: reactions.filter(value => value.path === call.path && value.reaction_type.emoji_type === call.query.reaction_type), has_more: false } } }
  }); cleanup.push(http.close)
  const wire = signedRoomAdapter('feishu'), verify = wire.adapter.ingress!.verify
  const adapter = { ...wire.adapter, publication: new FeishuAdapter({ http: http.http }).publication, ingress: { ...wire.adapter.ingress!, verify: async (...args: Parameters<typeof verify>) => ({ ...await verify(...args), conversationKind: 'group' as const }) } }
  const services = await createConnectionServices({ directory: join(f.root, 'connections'), adapters: [adapter], bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, ingress: { core: host => host === 'local' ? f.client : undefined }, publication: createPublicationConversationPort(f.coreClients) }); cleanup.push(() => services.close())
  const secret = await services.secrets.store({ operationId: 'original-secret', secret: 'fixture-signing-key' })
  await services.connections.configure({ operationId: 'original-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: secret.credentialRef } })
  const context = { actor: { kind: 'user' as const, id: 'owner' } }
  const linked = await services.bindings!.bind({ operationId: 'original-bind', bindingId: 'original-binding', connectionId: feishuConfig.connectionId, expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: ref.agentSessionId, regionAnchor: { regionId: 'region' }, externalConversationId: 'original-room', expectedSource: source,
    inputTarget: { kind: 'native-conversation', source }, scope: { input: 'all-messages', publication: 'future-shared-conversation' } }, context)
  expect(linked.state).toBe('applied'); const binding = (linked as { binding: RoomBinding }).binding
  const member = { application: feishuConfig.application, idType: 'email', userId: 'original@example.test' }
  const grant = { operationId: 'original-grant', bindingId: binding.bindingId, expectedBindingRevision: 1, grantId: 'original-member', expectedRevision: null, actor: member, state: 'active' as const, capabilities: ['input' as const] }
  await services.bindings!.grant(grant, context)
  await expect.poll(() => wire.endpoint).toBeDefined()
  const operations = () => services.publication!.store.list(binding, 100).filter(value => value.queryFeedback)
  const stages = () => operations().map(value => value.queryFeedback!.stage)
  const restore = () => { f.inner.connected = true; f.inner.kernel.isConnected = () => true; Reflect.get(f.client, 'publisher').publish({ type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() } }) }
  return { ...f, transcript, ref, services, wire, sends, reactions, binding, member, stages, operations, restore,
    revoke: () => services.bindings!.grant({ ...grant, operationId: 'revoke-original', expectedRevision: 1, state: 'revoked', capabilities: [] }, context),
    async send() { await wire.post({ deliveryKey: 'original-event', recordKey: 'original-query', roomKey: 'original-room', person: member.userId, text: 'Original user query', addressing: 'broadcast' }); let query: ConnectionIngressMessage | undefined
      await expect.poll(async () => { query = (await services.ingress!.list({ connectionId: binding.connectionId })).ingresses.find(row => row.kind !== 'action' && row.externalMessageId === 'original-query') as ConnectionIngressMessage; return query?.state }).toBe('claimed'); return query! },
    async native(kind: 'valid' | 'wrong-source' | 'ambiguous') { const sent = sends[0]; expect(sent).toBeDefined(); const row = (id: string) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: kind === 'wrong-source' ? 'foreign-native-thread' : source.nativeSessionId, turn_id: turn, item: { type: 'UserMessage', id, client_id: sent.clientUserMessageId, content: sent.input } } }); await appendFile(transcript, jsonl([row('original-native-user'), ...(kind === 'ambiguous' ? [row('distinct-native-user')] : [])])); services.publication!.refresh() },
    async complete(target = turn) { await appendFile(transcript, jsonl([{ type: 'event_msg', payload: { type: 'task_complete', turn_id: target } }])); services.publication!.refresh() }
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
  await expect.poll(() => f.operations().every(value => value.state === 'confirmed')).toBe(true)
  expect(f.stages()).toEqual(['received', 'queued', 'dispatched', 'started', 'completed'])
  expect(f.reactions.map(value => value.reaction_type.emoji_type)).toEqual(['Get', 'OneSecond', 'CheckMark', 'OnIt', 'DONE'])
  expect(f.reactions.every(value => value.path.endsWith('/original-query/reactions'))).toBe(true)
}, 30000)

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
    await f.send(); await expect.poll(f.stages, { timeout: 5000 }).toContain('queued')
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
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false, forwardRpc: (method, params, context) => rpc.call(method, params as never, { signal: context?.signal }) }); cleanup.push(() => hosted.dispose())
  const route = createHostedIngressCorePort(() => [{ hostId: 'exact-host', client: hosted }])
  const port = route('exact-host', hostedTestOwner(f.client).runtimeId)!, cut = await port.readAgentInputChanges!({ agentSessionId: 'recipient' })
  const receipt = await f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'hosted-original', prompt: 'Private unchanged input', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  const changed = await port.readAgentInputChanges!({ agentSessionId: 'recipient', after: cut.checkpoint!, limit: 25 })
  expect(changed.changes.map(value => value.key)).toEqual([receipt.key])
  expect(await port.inspectAgentInput({ key: receipt.key })).toMatchObject({ persistence: 'confirmed', status: 'waiting', ref: receipt.ref })
  expect(JSON.stringify(changed)).not.toContain('Private unchanged input')
  await expect(route('exact-host', 'wrong-original-runtime')!.readAgentInputChanges!({ agentSessionId: 'recipient', after: cut.checkpoint! })).rejects.toBeDefined()
  expect(route('foreign-host')).toBeUndefined(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 15000)
