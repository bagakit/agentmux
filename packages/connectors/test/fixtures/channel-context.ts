import { expect, vi } from 'vitest'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '@agentmux/core'
import { connectHostedAgentMux } from '@agentmux/core/hosted'
import { AgentMuxHostedRuntimeService } from '../../../core/src/hosted-runtime-service.js'
import { nativeInputCorrelationKey } from '../../../core/src/native-input-correlation.js'
import { rpcOwnerFixture } from '../../../core/test/helpers/public-rpc-owner.js'
import { hostedTestOwner } from '../../../core/test/helpers/hosted-runtime-port.js'
import { objectCliEnvironment } from '../../../core/test/helpers/object-cli-rpc.js'
import { runSourceObjectCli } from '../../../core/test/helpers/source-object-cli.js'
import { createWorkspaceLayout } from '../../../core/src/spatial-layout.js'
import { createConnectionServices } from '../../src/connection-services.js'
import { createRpcExternalInputAuthority } from '../helpers/rpc-external-input-authority.js'
import { createHostedIngressCorePort } from '../../src/core-ingress-port.js'
import { createPublicationConversationPort } from '../../src/core-conversation-port.js'
import { feishuConfig, feishuPayload } from './feishu.js'
import { feishuHistoryMessage, feishuHistoryTransport } from './channel-history.js'
import { feishuPublicationHttp } from './feishu-publication.js'
import { discordConfig, discordRoomId, discordTransport } from './discord.js'

/** Default native registry, original semantic Host/authority RPC and File Input journal.
 * Only platform network I/O and the original Provider native send port are controlled. */
export async function channelContextFixture(cleanup: Array<() => void | Promise<void>>, mode: 'native' | 'terminal' = 'native', publish = false, channel: 'feishu' | 'discord' = 'feishu') {
  let bridge: ReturnType<typeof createRpcExternalInputAuthority>
  class Owner extends core.AgentMuxClient {
    constructor(options: { store: core.AgentMuxAgentSessionStore }) {
      super({ ...options, externalConversationAuthority: { resolveConversationMessage: input => bridge.resolveConversationMessage!(input) } })
    }
  }
  const f = await rpcOwnerFixture(['original-agent'], { AgentMuxClient: Owner, AgentMuxFileAgentSessionStore: core.AgentMuxFileAgentSessionStore }, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'context-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(f.close)
  await writeFile(join(f.root, 'native.jsonl'), JSON.stringify({ type: 'user', sessionId: 'context-native', uuid: 'original-before-binding', message: { role: 'user', content: 'Existing original work' } }) + '\n')
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  vi.spyOn(f.client.providers.get('claude'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  let outcome: 'admitted' | 'unknown' = 'admitted'
  const nativeSend = vi.fn(async (prompt: string, plan: core.AgentNativePromptInputPlan) => {
    const key = nativeInputCorrelationKey(plan.clientCorrelation!)!
    expect(key?.kind).toBe('message')
    const record = await new core.AgentMuxFileAgentSessionStore(f.store.path).readPromptAdmission(key.agentSessionId, key.expectedRun, key.kind === 'message' ? key.messageId : key.submissionId)
    expect(record?.admission?.inputKey).toEqual(key); expect(record?.admission?.intent?.plan).toEqual(plan)
    expect(record?.admission?.intent?.prompt).toBe(prompt)
    if (outcome === 'unknown') throw Error('Native response lost after the original send')
    return { outcome: 'admitted' as const, turnId: 'original-native-turn' }
  })
  if (mode === 'native') {
    const actor = { protocolId: 'fixture-native-protocol', actorId: 'context-actor', lifecycleOperationId: 'original-launch', token: 'a'.repeat(64), launch: { command: 'claude', args: [] } }
    const original = (await f.store.readMetadata('original-agent'))!
    await f.store.compareAndSwapMetadata(original, { ...original, nativeActor: actor }); await f.inner.registry.load('local')
    f.inner.kernel.status = vi.fn(async id => ({ ...f.run(id), pid: 1234 }))
    f.client.providers.get('claude').prepareNativeInput = async (_input, source) => ({ plan: { kind: 'native-rpc', protocolId: actor.protocolId, actorId: actor.actorId,
      sourceId: JSON.stringify([source.providerId, source.nativeSessionId]), threadId: source.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: async () => {}, send: nativeSend, dispose: async () => {} })
  }
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId: 'space', kind: 'topic', name: 'Original', hostId: 'local', directoryPath: f.root, projectId: 'project' }], zones: [{ zoneId: 'zone', workspaceId: 'workspace', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }], tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: null, regionIds: ['region'] }], regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }], bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { workspace: createWorkspaceLayout('group', ['tab']) }, tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {} } })
  const desktopPath = join(f.root, 'desktop.sock')
  bridge = createRpcExternalInputAuthority({ socketPath: desktopPath, executionHostId: 'local' })
  const runtime = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client), undefined, bridge)
  cleanup.push(() => runtime.dispose())
  const host = new core.AgentMuxControlServer({ socketPath: join(f.root, 'host.sock'), coreClients: f.coreClients, hostedRuntime: () => runtime })
  await host.start(); cleanup.push(() => host.stop())
  const hostRpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.path } }); cleanup.push(() => hostRpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc: hostRpc }); cleanup.push(() => hosted.dispose())
  const clients = () => [{ hostId: 'local', client: hosted }]
  const nativeRows: ReturnType<typeof feishuHistoryMessage>[] = [], transport = feishuHistoryTransport(nativeRows)
  const discord = channel === 'discord' ? await discordTransport() : undefined
  if (discord) { cleanup.push(discord.close); vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest) }
  const remote = publish ? await feishuPublicationHttp() : null
  if (remote) {
    cleanup.push(remote.close)
    const history = transport.request.getMockImplementation()!
    transport.request.mockImplementation(async input => {
      const call = input as { url?: string; method?: string }, method = String(call.method ?? 'GET').toUpperCase()
      if (call.url?.includes('/im/v1/messages') && (method !== 'GET' || call.url.includes('/platform-message-'))) return await remote.http.request(input as never) as never
      return history(input)
    })
  }
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(input => transport.request(input))
  let services: Awaited<ReturnType<typeof createConnectionServices>>, desktop: core.AgentMuxControlServer, rpc: Awaited<ReturnType<typeof core.connectAgentMuxRpc>>
  async function open() {
    services = await createConnectionServices({ directory: join(f.root, 'connectors'),
      bindings: { spatial, checkpoint: ref => hosted.conversationCheckpoint(ref) }, ingress: { core: createHostedIngressCorePort(clients) }, ...(publish ? { publication: createPublicationConversationPort(clients) } : {}) })
    desktop = new core.AgentMuxControlServer({ socketPath: desktopPath, connections: services.connections, spatialState: spatial, coreClients: clients })
    await desktop.start(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } })
  }
  async function close() { await rpc?.dispose(); await desktop?.stop(); services?.close() }
  await open(); cleanup.push(close)
  const secret = await services!.secrets.store({ operationId: 'context-secret', secret: 'fixture-native-secret' })
  const config = { ...(discord ? discordConfig : feishuConfig), credentialRef: secret.credentialRef }
  const externalConversationId = discord ? discordRoomId : 'original-room'
  const actor = { application: config.application, idType: discord ? 'snowflake' : 'open_id', userId: discord ? '400' : 'original-external-user' }
  await rpc!.call('connection.configure', { operationId: 'context-configure', expectedRevision: null, connection: config })
  const source = { providerId: 'claude', nativeSessionId: 'context-native' }
  const binding = { operationId: 'context-bind', bindingId: 'context-binding', connectionId: config.connectionId, expectedConnectionRevision: 1, expectedSource: source,
    executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'region' }, externalConversationId,
    scope: { input: 'mentions-and-replies' as const, publication: 'future-shared-conversation' as const }, ...(mode === 'native' ? { inputTarget: { kind: 'native-conversation' as const, source } } : {}) }
  expect(await rpc!.call('connection.bind', binding)).toMatchObject({ state: 'applied' })
  await rpc!.call('connection.grant', { operationId: 'context-grant', bindingId: binding.bindingId, expectedBindingRevision: 1, grantId: 'context-member', expectedRevision: null,
    actor, capabilities: ['input'], state: 'active' })
  await vi.waitFor(() => expect(discord ? discord.sessions : transport.sockets).toHaveLength(1))
  const addNative = (id: string, time: number, body: string, fields: Record<string, unknown> = {}) => {
    const row = feishuHistoryMessage(id, time, { sender: { id: 'original-external-user', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text: body }) }, ...fields })
    nativeRows.push(row); nativeRows.sort((a, b) => Number(b.create_time) - Number(a.create_time)); return row
  }
  const addHistory = (id: string, time: number, body: string, fields: Record<string, unknown> = {}) => {
    if (discord) return discord.historyMessage(id, body, fields)
    return addNative(id, time, body, fields)
  }
  const receive = async (id: string, time: number, body: string, addressed = true) => {
    if (discord) discord.message(id, body, { mentions: addressed ? [{ id: '200' }] : [] })
    else {
      addNative(id, time, body)
      const payload = feishuPayload({ message_id: id, create_time: String(time), content: JSON.stringify({ text: body }), ...(addressed ? {} : { mentions: [] }) })
      payload.header.event_id = 'event-' + id
      await transport.receive(payload)
    }
    let original: core.ConnectionIngressRecord | undefined
    await vi.waitFor(async () => { original = (await services.ingress!.list({ connectionId: config.connectionId, limit: 100 })).ingresses.find(row => row.kind !== 'action' && row.externalMessageId === id); expect(original).toBeDefined() })
    return original!
  }
  const inspect = (ingressId: string) => rpc.call('connection.ingress.inspect', { ingressId })
  const wait = async (id: string, status: core.AgentInputSubmissionReceipt['status']) => {
    await vi.waitFor(async () => expect((await inspect(id)).inputReceipt?.status).toBe(status), { timeout: 10000 })
    return await inspect(id)
  }
  const cli = async (args: string[]) => { const result = await runSourceObjectCli(['--endpoint', 'unix:' + desktopPath, ...args], objectCliEnvironment(f.root,
    process.env.INPUT_CONTEXT_CONTINUITY_CLI_LOADED ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.INPUT_CONTEXT_CONTINUITY_CLI_LOADED } : {}), '', 20_000, pathToFileURL(resolve('packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs'))); expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result }
  return { ...f, source, config, binding, actor, nativeSend, transport, discord, remote, nativeRows, addNative, addHistory, receive, inspect, wait, cli, outcome: (value: typeof outcome) => { outcome = value },
    get services() { return services }, get rpc() { return rpc }, reopen: async () => { await close(); await open(); await vi.waitFor(() => expect(discord ? discord.sessions.length : transport.sockets.length).toBeGreaterThan(1)) } }
}
