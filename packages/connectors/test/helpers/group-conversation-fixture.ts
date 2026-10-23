import { expect, vi } from 'vitest'
import { join } from 'node:path'
import { appendFile, writeFile } from 'node:fs/promises'
import * as core from '@agentmux/core'
import { nativeInputCorrelationKey } from '../../../core/src/native-input-correlation.js'
import { connectHostedAgentMux } from '../../../core/dist/hosted.js'
import { AgentMuxHostedRuntimeService } from '../../../core/dist/hosted-runtime-service.js'
import { rpcOwnerFixture } from '../../../core/test/helpers/public-rpc-owner.js'
import { hostedTestOwner } from '../../../core/test/helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'
import { createWorkspaceLayout } from '../../../core/src/spatial-layout.js'
import { createConnectionServices } from '../../src/connection-services.js'
import { createDesktopExternalInputAuthority } from '../../../../apps/host/src/external-input-authority.js'
import { createHostedIngressCorePort, createPublicationConversationPort, type ConnectionAdapter } from '@agentmux/connectors'
import { signedRoomAdapter, type SignedRoomMessage } from '../fixtures/signed-room-adapter.js'

export const cleanup: Array<() => void | Promise<void>> = []
export async function groupConversationFixture(running = false, updatePublications = false, nativeOutcome?: 'admitted' | 'unknown' | 'not-applied') {
  let bridge: ReturnType<typeof createDesktopExternalInputAuthority>
  class Owner extends core.AgentMuxClient {
    constructor(options: { store: core.AgentMuxAgentSessionStore }) {
      super({ ...options, externalConversationAuthority: { resolveConversationMessage: input => bridge.resolveConversationMessage!(input) } })
    }
  }
  const f = await rpcOwnerFixture(['original-agent'], { AgentMuxClient: Owner, AgentMuxFileAgentSessionStore: core.AgentMuxFileAgentSessionStore }, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'group-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(() => f.close())
  await writeFile(join(f.root, 'native.jsonl'), JSON.stringify({ type: 'user', sessionId: 'group-native', uuid: 'before-link', message: { role: 'user', content: 'Existing conversation' } }) + '\n')
  f.inner.connected = running; f.inner.kernel.isConnected = () => running
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  if (running) vi.spyOn(f.client.providers.get('claude'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const nativeSend = vi.fn(async (_prompt: string, plan: core.AgentNativePromptInputPlan) => {
    const key = nativeInputCorrelationKey(plan.clientCorrelation!)!
    const admitted = await new core.AgentMuxFileAgentSessionStore(f.store.path).readPromptAdmission('original-agent', key.expectedRun, key.kind === 'message' ? key.messageId : key.submissionId)
    expect(admitted?.admission?.inputKey).toEqual(key)
    expect(admitted?.admission?.intent?.plan).toEqual(plan)
    if (nativeOutcome === 'unknown') throw Error('Original native response was lost')
    return nativeOutcome === 'not-applied' ? { outcome: 'not-applied' as const, errorCode: -32600 } : { outcome: 'admitted' as const, turnId: 'original-native-turn' }
  })
  if (nativeOutcome) {
    const actor = { protocolId: 'fixture-native-protocol', actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', token: 'a'.repeat(64), launch: { command: 'claude', args: [] } }
    const original = (await f.store.readMetadata('original-agent'))!
    await f.store.compareAndSwapMetadata(original, { ...original, nativeActor: actor }); await f.inner.registry.load('local')
    f.inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), pid: 1234 }))
    f.client.providers.get('claude').prepareNativeInput = async (_context, selected) => ({
      plan: { kind: 'native-rpc', protocolId: actor.protocolId, actorId: actor.actorId, sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]), threadId: selected.nativeSessionId, operation: 'start-or-steer' },
      assertCurrent: async () => {}, send: nativeSend, dispose: async () => {}
    })
  }
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId: 'space', kind: 'topic', name: 'Original', hostId: 'local', directoryPath: f.root, projectId: 'project' }], zones: [{ zoneId: 'zone', workspaceId: 'workspace', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }], tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: null, regionIds: ['region'] }], regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }], bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { workspace: createWorkspaceLayout('group', ['tab']) }, tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {} } })
  const desktopPath = join(f.root, 'desktop.sock')
  bridge = createDesktopExternalInputAuthority({ desktopSocketPath: desktopPath, executionHostId: 'local' })
  const runtime = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client), undefined, bridge)
  cleanup.push(() => runtime.dispose())
  const host = new core.AgentMuxControlServer({ socketPath: join(f.root, 'host.sock'), coreClients: f.coreClients, hostedRuntime: () => runtime })
  await host.start(); cleanup.push(() => host.stop())
  const hostRpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.path } }); cleanup.push(() => hostRpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc: hostRpc }); cleanup.push(() => hosted.dispose())
  const clients = () => [{ hostId: 'local', client: hosted }]
  const wire = signedRoomAdapter(), verify = wire.adapter.ingress!.verify
  if (updatePublications) {
    const original = wire.adapter.publication!.dispatch
    wire.adapter.publication!.dispatch = async (...args) => {
      const mapping = args[4]
      if (!mapping) return original(...args)
      // The controlled transport supports exact updates to its original platform message.
      wire.ledger.set(args[0].requestKey, mapping)
      return { state: 'confirmed', mapping }
    }
  }
  const adapter: ConnectionAdapter = { ...wire.adapter, ingress: { ...wire.adapter.ingress!, verify: async (...args) => ({ ...await verify(...args), conversationKind: 'group' }) } }
  let services: Awaited<ReturnType<typeof createConnectionServices>>, desktop: core.AgentMuxControlServer, rpc: Awaited<ReturnType<typeof core.connectAgentMuxRpc>>
  async function open() {
    services = await createConnectionServices({ directory: join(f.root, 'connectors'), adapters: [adapter],
      bindings: { spatial, checkpoint: ref => hosted.conversationCheckpoint(ref) }, publication: createPublicationConversationPort(clients), ingress: { core: createHostedIngressCorePort(clients) } })
    desktop = new core.AgentMuxControlServer({ socketPath: desktopPath, connections: services.connections, spatialState: spatial, coreClients: clients })
    await desktop.start(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } })
  }
  async function close() { await rpc?.dispose(); await desktop?.stop(); services?.close() }
  await open(); cleanup.push(close)
  const application = { domain: 'signed.example', appId: 'group-app' }, actor = { application, idType: 'email', userId: 'member@example.test' }
  const secret = await services!.secrets.store({ operationId: 'save-secret', secret: 'fixture-signing-key' })
  const config = { connectionId: 'group-bot', adapterId: adapter.adapterId, application, label: 'Group bot', enabled: true, credentialRef: secret.credentialRef }
  await rpc!.call('connection.configure', { operationId: 'configure-bot', expectedRevision: null, connection: config })
  const binding = { ...(nativeOutcome ? { inputTarget: { kind: 'native-conversation' as const, source: { providerId: 'claude', nativeSessionId: 'group-native' } } } : {}), operationId: 'link-group', bindingId: 'group-binding', connectionId: config.connectionId, expectedConnectionRevision: 1, expectedSource: { providerId: 'claude', nativeSessionId: 'group-native' }, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'region' }, externalConversationId: 'native-group', scope: { input: 'mentions-and-replies' as const, publication: 'future-shared-conversation' as const } }
  expect(await rpc!.call('connection.bind', binding)).toMatchObject({ state: 'applied' })
  await vi.waitFor(() => expect(wire.endpoint).toBeDefined())
  const message = (changes: Partial<SignedRoomMessage> = {}): SignedRoomMessage => ({ deliveryKey: 'event', recordKey: 'message', roomKey: 'native-group', person: actor.userId, text: 'Original group message', addressing: 'broadcast', ...changes })
  const receive = async (changes: Partial<SignedRoomMessage> = {}) => {
    const native = message(changes)
    expect(await wire.post(native)).toBe(202)
    let record: Awaited<ReturnType<NonNullable<typeof services.ingress>['list']>>['ingresses'][number] | undefined
    await vi.waitFor(async () => { record = (await services.ingress!.list({ connectionId: config.connectionId })).ingresses.find(record => record.kind !== 'action' && record.externalMessageId === native.recordKey); expect(record).toBeDefined() })
    return record!
  }
  const captured = async () => (await f.store.readCapturedHistory('original-agent')).records.filter(record => record.item.authorExternal)
  const cli = async (args: string[]) => { const result = await runCompiledObjectCli(['--endpoint', 'unix:' + desktopPath, ...args], objectCliEnvironment(f.root)); expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result }
  return { ...f, wire, actor, config, binding, message, receive, captured, cli, hosted, hostRpc, nativeSend, get services() { return services }, get rpc() { return rpc }, reopen: async () => { await close(); await open() } }
}
