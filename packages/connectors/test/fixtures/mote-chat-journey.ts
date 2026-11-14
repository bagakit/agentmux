import { connectHostedAgentMux } from '@agentmux/core/hosted'
import { AgentMuxHostedRuntimeService } from '../../../core/src/hosted-runtime-service.js'
import { hostedTestOwner } from '../../../core/test/helpers/hosted-runtime-port.js'
import { createConnectionExternalInputAuthority } from '../../../../apps/host/src/external-input-authority.js'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { connectionApplicationScope } from '@agentmux/core/connections'
import { MoteChatStore } from '../../src/mote-chat-store.js'
import type { ConnectionApplication, ConnectionIngressMessage } from '@agentmux/core/connections'
import { spatialCatalog } from '@agentmux/core/spatial-state'
import { createPublicationConversationPort, PublicationHost, type ConnectionAdapter, type MoteChatAgentPort } from '@agentmux/connectors'
import { rpcOwnerFixture } from '../../../core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'
import { createConnectionServices } from '../../src/connection-services.js'
import { ScratchTopics, createMoteChatResources, readMoteResourceConfiguration } from '@agentmux/host/mote-resources'
import { createMoteChatAgents as createHostMoteChatAgents } from '@agentmux/host/mote-chat-agents'
import { createHostMoteMembership } from '@agentmux/host/mote-membership'
import { directoryIdentity, homeZoneId } from '@agentmux/host/mote-model'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import type { AppConfig, WorkspaceRecord } from '../../../../apps/desktop/src/shared/contracts.js'
import { encodeCwdDirname } from '../../../core/src/providers/grok-native-history.js'
import { grokChunk, grokDone, grokUpdate } from '../../../core/test/fixtures/grok-updates.js'
import { createHostConnectionOwner } from '../../../../apps/host/src/connections.js'
import { createHostMoteMainReader, createHostMoteDialogue } from '../../../../apps/host/src/mote-dialogue.js'
import { FileReadOwner } from '../../../../apps/host/src/file-read-owner.js'
import { OrdinaryWorkspaceFiles } from '../../../../apps/host/src/ordinary-files.js'
import { MoteDialogueStore } from '@agentmux/core/mote-dialogue-store'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '@agentmux/core/spatial-layout'
import { feishuConfig } from './feishu.js'
import { feishuPublicationHttp, type FeishuHttpCall, type FeishuHttpResponse } from './feishu-publication.js'
import { FeishuAdapter } from '../../src/adapters/feishu/index.js'
import { signedRoomAdapter, type SignedRoomMessage } from './signed-room-adapter.js'
import { AgentHookServer } from '../../../core/src/hook-server.js'
import { moteChatNativeProcess } from './mote-chat-native-process.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })
type DirectMessage = SignedRoomMessage & { nativeKind: 'direct' | 'group' }

export async function moteChatJourneyFixture(strangerMessageLimit = 1, conversationIdleMs = 60_000, mode: 'desktop' | 'headless' = 'desktop', nativeAfterInput = false, nativeProvider: 'claude' | 'grok' | 'codex' = 'claude', publicationHttp?: (call: FeishuHttpCall) => FeishuHttpResponse | undefined, mainMode?: 'bound' | 'unbound', publicationMode: 'feishu' | 'signed-room' = 'feishu', execution: 'local' | 'remote' = 'local', native?: { adapter: ConnectionAdapter; application: ConnectionApplication; credential: string }) {
  const publicationRefresh = vi.spyOn(PublicationHost.prototype, 'refresh')
  class FixtureHostClient extends core.AgentMuxClient {
    constructor(options: core.AgentMuxClientOptions) {
      let client: core.AgentMuxClient
      const root = dirname((options.store as core.AgentMuxFileAgentSessionStore).path), runtimeId = 'original-mote-host'
      const hostExecutorOwner = new core.AgentMuxHostExecutorOwner({ path: join(root, 'host-executors.json'), runtimeId, catalog: () => client.catalog() })
      super({ ...options, hostExecutorOwner, creationAuthority: new core.AgentMuxCreationAuthority({ stateDirectory: join(root, 'creation'), runtimeId }) })
      client = this
    }
  }
  const original = await rpcOwnerFixture([], mode === 'headless' ? { ...core, AgentMuxClient: FixtureHostClient } : core)
  const client = original.client as core.AgentMuxClient
  const grokHome = join(original.root, 'grok')
  if (nativeProvider === 'grok') vi.stubEnv('GROK_HOME', grokHome)
  const feishu = nativeProvider !== 'claude' && publicationMode === 'feishu' ? await feishuPublicationHttp(publicationHttp) : undefined
  if (feishu) cleanup.push(feishu.close)
  const nativeProcesses: Array<Awaited<ReturnType<typeof moteChatNativeProcess>>> = []
  if (native) cleanup.push(async () => { for (const process of nativeProcesses.splice(0).reverse()) await process.close() })
  cleanup.push(async () => {
    try { await original.close() } catch (error) {
      // Aborted original read observers can finish their owned receipt write after dispose.
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
      await rm(original.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Mote homes', hostId: 'local', path: join(original.root, 'homes'), kind: 'folder' }
  await mkdir(workspace.path)
  const topics = new ScratchTopics(), topic = await topics.ensureMote(workspace, 'view:private-chat')
  await writeFile(join(topic.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults:\n  executorId: saved-chat\n---\n')
  await writeFile(join(topic.physicalDirectoryPath!, 'SOUL.md'), '# Original Mote\nKeep this Mote personality.\n')
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
  const target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const graph = { spaces: [{ spaceId, kind: 'mote' as const, name: 'Original Mote', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, projectId: null, topicId: topic.id }],
    zones: [{ zoneId, workspaceId: workspace.id, kind: 'home' as const, hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null }],
    bindings: [{ spaceId, zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} }
  const spatial = new core.AgentMuxSpatialStateStore(join(original.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph })
  const config = { hosts: [{ id: 'local', kind: 'local', label: 'Original host' }], workspaces: [workspace],
    executors: { 'saved-chat': { label: 'Saved Executor', providerId: nativeProvider, command: nativeProvider, injectAgentMuxGuide: false } },
    profile: { displayName: 'Original owner', about: '', avatar: '', shareWithAgents: true } } as unknown as AppConfig

  // Native process creation, Hook handshake and signed transport are controlled leaves.
  // Core creation/CAS, original message journal, native history and automatic publication execute.
  const inner = original.client as unknown as typeof original.inner & { hookServer: Record<string, unknown>; ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown;
    providers: { get(id: string): core.AgentProvider } }
  const runs = new Map<string, ReturnType<typeof original.run>>(), sources = new Map<number, { id: string; path: string }>()
  const start = vi.fn(async (input: { operationKey?: string; env?: Record<string, string>; args: string[] }) => {
    const previous = input.operationKey && [...runs.values()].find(run => run.lifecycleOperationId === input.operationKey)
    if (previous) return previous
    const number = runs.size + 1, runId = `native-run-${number}`
    const resumeIndex = input.args.indexOf('--resume'), resumed = resumeIndex < 0 ? undefined : [...sources.values()].find(source => source.id === input.args[resumeIndex + 1])
    if (resumeIndex >= 0 && !resumed) throw new Error('Resume must retain an existing original native conversation')
    const id = resumed?.id ?? `native-chat-${number}`
    const nativeProcess = native ? await moteChatNativeProcess(id, topic.physicalDirectoryPath!, input.env ?? {}) : undefined
    if (nativeProcess) nativeProcesses.push(nativeProcess)
    const pid = nativeProcess?.processId ?? 400_000 + number
    const path = nativeProcess?.source ?? resumed?.path ?? (nativeProvider === 'grok'
      ? join(grokHome, 'sessions', encodeCwdDirname(topic.physicalDirectoryPath!), id, 'updates.jsonl') : join(original.root, `${id}.jsonl`))
    if (nativeProvider === 'grok' && !resumed) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(join(path, '..', 'summary.json'), JSON.stringify({ info: { id, cwd: topic.physicalDirectoryPath! } }))
    }
    if (!native && !resumed && !nativeAfterInput) await writeFile(path, JSON.stringify(nativeProvider === 'grok' ? grokUpdate(id, { sessionUpdate: 'current_mode_update', currentModeId: 'chat' }) : { sessionId: id, uuid: 'original-context', type: 'system', message: { role: 'system', content: 'Native system context' } }) + '\n')
    const run = { ...original.run(runId), lifecycleOperationId: input.operationKey ?? null, program: nativeProvider, pid, workspacePath: topic.physicalDirectoryPath! }
    runs.set(runId, run); sources.set(pid, { id, path })
    if (nativeProvider === 'grok') {
      void fetch(input.env!.AGENTMUX_HOOK_URL!, { method: 'POST', headers: { authorization: 'Bearer ' + input.env!.AGENTMUX_HOOK_TOKEN!, 'content-type': 'application/json' },
        body: JSON.stringify({ receiptId: 'native-start-' + runId, eventName: 'session_start', payload: { hookEventName: 'session_start', sessionId: id, cwd: topic.physicalDirectoryPath! } })
      }).then(response => { if (response.status !== 204) throw Error('Original Grok startup Hook was not accepted') }).catch(error => { hookErrors.push(String(error)) })
    }
    return run
  })
  inner.kernel.start = start
  // The durable resume owner consumes a prepared Runtime dispatch, with the
  // same native Start leaf and operation-key retention as initial creation.
  const runtimeIdentity = { runtimeId: 'fixture-original-core', instanceId: 'fixture-instance', buildIdentity: 'fixture', protocolVersion: 1 }
  inner.kernel.creationRuntimeIdentity = () => runtimeIdentity
  inner.kernel.startPrepared = async (request: { args: string[]; env: Record<string, string> }, operationKey: string, expected: core.AgentMuxCreationRuntime) => {
    expect(expected).toEqual(runtimeIdentity)
    expect(request.env.AGENTMUX_LIFECYCLE_OPERATION_ID).toBe(operationKey)
    return await start({ ...request, operationKey })
  }
  inner.kernel.inspectPreparedStart = async (_request: unknown, operationKey: string) => [...runs.values()].find(run => run.lifecycleOperationId === operationKey) ?? null
  inner.kernel.status = async (id: string) => { const run = runs.get(id); if (!run) throw new Error('Unknown original native Run'); return { ...run, acceptedInputBytes: original.run(id).acceptedInputBytes } }
  inner.kernel.inspectCreation = async (operationId: string) => [...runs.values()].find(run => run.lifecycleOperationId === operationId) ?? null
  type RuntimeInput = (id: string, input: { operationId: string; expectedByte: number; data: string }) => Promise<{ run: ReturnType<typeof original.run>; appliedByteRange: { startByte: number; endByte: number } }>
  const runtimeInput = vi.mocked(inner.kernel.input as RuntimeInput), originalInputLeaf = runtimeInput.getMockImplementation()!
  runtimeInput.mockImplementation(async (...args: Parameters<typeof originalInputLeaf>) => {
    const receipt = await originalInputLeaf(...args)
    return { ...receipt, run: { ...runs.get(args[0])!, acceptedInputBytes: receipt.run.acceptedInputBytes } }
  })
  const hookErrors: string[] = []
  if (native || nativeProvider === 'grok') {
    const hooks = new AgentHookServer((event, signal) => Reflect.get(client, 'acceptHookEvent').call(client, event, signal), 0)
    await hooks.start(); Reflect.set(client, 'hookServer', hooks)
    const observeOutput = inner.kernel.observeOutput as (id: string, after: number, listener: unknown) => Promise<Record<string, unknown>>
    inner.kernel.observeOutput = async (...args: Parameters<typeof observeOutput>) => {
      const result = await observeOutput(...args), data = client.providers.get(nativeProvider).terminalHandshake!.query
      return { ...result, replay: [{ type: 'data', runId: args[0], startByte: 0, endByte: Buffer.byteLength(data), data, dataBytes: Buffer.from(data) }] }
    }
    inner.kernel.attach = async (id: string, after: number) => await (inner.kernel.observeOutput as typeof observeOutput)(id, after, () => {})
  } else {
    inner.hookServer.isRunning = () => true
    inner.hookServer.createBinding = (_session: string, _provider: string, bindingId?: string) => ({ bindingId: bindingId ?? 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
    inner.ensureTerminalHandshakeOrDegrade = async (session: core.AgentMuxAgentSession) => session
  }
  inner.ensureManagedHooks = async () => {}
  vi.spyOn(client as unknown as { probePreparedAgent: typeof client.probeAgent }, 'probePreparedAgent').mockImplementation(async id => ({ providerId: id, executable: id, installed: true, capabilities: new core.AgentProviderRegistry().get(id).catalog.capabilities }))
  const provider = inner.providers.get(nativeProvider) as core.AgentProvider & Required<Pick<core.AgentProvider, 'discoverNativeSession'>>
  if (nativeProvider === 'claude') {
    expect(typeof provider.discoverNativeSession).toBe('function')
    vi.spyOn(provider, 'discoverNativeSession').mockImplementation(async ({ processId }) => {
      const source = sources.get(processId)
      return source && (!nativeAfterInput || inputCreatedSources.has(processId)) ? { handle: { kind: 'provider' as const, providerId: 'claude', sessionId: source.id, transcriptPath: source.path }, assertCurrent: async () => {} } : null
    })
  }
  const inputCreatedSources = new Set<number>()
  if (nativeAfterInput && nativeProvider !== 'codex') {
    const inputLeaf = vi.mocked(inner.kernel.input as (id: string, input: { operationId: string; expectedByte: number; data: string }) => Promise<unknown>)
    const originalInput = inputLeaf.getMockImplementation()!
    inputLeaf.mockImplementation(async (...args) => {
      const run = runs.get(args[0])!, source = sources.get(run.pid!)!
      if (!inputCreatedSources.has(run.pid!)) {
        await writeFile(source.path, JSON.stringify({ sessionId: source.id, uuid: 'first-reply', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'First reply created with the original input' }] } }) + '\n')
        inputCreatedSources.add(run.pid!)
      }
      return await originalInput(...args)
    })
  }
  vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const clients = () => [{ hostId: 'local', client: original.client }]
  const checkpoint = (ref: Parameters<typeof original.client.conversationCheckpoint>[0]) => original.client.conversationCheckpoint(ref)
  const configurationPath = join(original.root, 'original-app-config.json')
  await writeFile(configurationPath, JSON.stringify(config))
  if (mode === 'headless') {
    await client.configureHostExecutor({ executorId: 'saved-chat', config: { label: 'Original saved chat', providerId: nativeProvider, command: process.execPath, args: ['--chosen'], env: { MOTE_VALUE: 'host-owned', ...(nativeProvider === 'grok' ? { GROK_HOME: grokHome } : {}) }, injectAgentMuxGuide: false } })
  }
  const mainHostId = execution === 'remote' ? 'original-execution' : 'local'
  let executionReader: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined, hostingReader: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  let executionEndpoint: { transport: 'unix'; path: string } | undefined
  let hostingOwnerInstanceId = execution === 'remote' ? 'fixture-hosting-owner' : 'fixture-instance'
  let hosting = original, hostingRuntime: AgentMuxHostedRuntimeService | undefined
  const mainFiles = mainMode ? new FileReadOwner({ catalog: async () => { const state = await spatial.read(); return state ? spatialCatalog(state.graph) : null },
    workspace: id => id === workspace.id ? workspace : undefined, files: new OrdinaryWorkspaceFiles(), topicForDirectory: (resource, path) => topics.readForDirectory(resource, path) }) : undefined
  const main = mainFiles ? createHostMoteMainReader({ configurationPath, spatial, files: mainFiles }) : undefined
  const dialogue = main ? createHostMoteDialogue({ main, spatial, store: new MoteDialogueStore(join(original.root, 'dialogue.sqlite')), clientForHost: () => executionReader ?? client }) : undefined
  async function bindMain(id: string, existing?: core.AgentMuxAgentSession) {
    const executor = (await client.listHostExecutors()).executors.find(e => e.executorId === 'saved-chat')!
    const session = existing ?? (await client.createHostAgentWithDelivery({ agentSessionId: id, createOperationId: `create-${id}`,
      executorId: 'saved-chat', executorRevision: executor.configRevision, workspacePath: topic.physicalDirectoryPath! })).session
    const tabId = `${id}-tab`, regionId = `${id}-region`, groupId = 'main-group'
    const state = (await spatial.read())!
    await spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph,
      tabs: [...state.graph.tabs, { tabId, zoneId, workspaceId: workspace.id, name: null, regionIds: [regionId] }],
      regions: [...state.graph.regions, { tabId, regionId, kind: 'agent', agentSessionId: id, runId: session.run.runId, execution: { hostId: mainHostId, cwd: topic.physicalDirectoryPath! } }],
      layouts: { ...state.graph.layouts, [workspace.id]: createWorkspaceLayout(groupId, [...state.graph.tabs.map(tab => tab.tabId), tabId]) },
      tabLayouts: { ...state.graph.tabLayouts, [tabId]: createWorkbenchViewLayout(regionId) } } })
    const reference = { hostId: mainHostId, sessionId: id, displayWorkspaceId: workspace.id, groupId, tabId, regionId }
    const save = async () => { await writeFile(join(topic.physicalDirectoryPath!, 'MOTE.md'), '---\n' + JSON.stringify({ version: 1, defaults: { executorId: 'saved-chat', conversation: reference, conversationRevision: `role-${id}` } }) + '\n---\n') }
    if (main?.withRole) await main.withRole(target, save); else await save()
    return session
  }
  if (mainMode === 'bound') await bindMain('original-main')
  const desktopAgents = mode === 'headless'
    ? createHostMoteChatAgents({ resources: createMoteChatResources({ topics, catalog: async () => spatialCatalog(graph), configuration: target => readMoteResourceConfiguration(configurationPath, target) }), clients })
    : (await import('../../../../apps/desktop/src/main/mote-chat-agents.js')).createMoteChatAgents({ config: () => config, catalog: async () => spatialCatalog(graph), topics, clients })
  const wire = signedRoomAdapter(nativeProvider !== 'claude' && publicationMode === 'feishu' ? 'feishu' : 'signed-room'), application = native?.application ?? { domain: nativeProvider !== 'claude' && publicationMode === 'feishu' ? 'open.feishu.cn' : 'signed.example', appId: nativeProvider !== 'claude' && publicationMode === 'feishu' ? feishuConfig.application.appId : 'original-mote-app' }
  const creator = { application, idType: 'email', userId: 'creator@example.test' }, guest = { ...creator, userId: 'guest@example.test' }
  const lanePerson = { ...creator, userId: 'lane-member@example.test' }
  const verify = wire.adapter.ingress!.verify
  const adapter: ConnectionAdapter = native?.adapter ?? { ...wire.adapter, ...(feishu ? { publication: new FeishuAdapter({ http: feishu.http }).publication, ...(mainMode ? { api: new FeishuAdapter({ http: feishu.http }).api } : {}) } : {}),
    ingress: { ...wire.adapter.ingress!, verify: async (...args) => {
      const verified = await verify(...args), native = JSON.parse(args[1]) as DirectMessage
      if (!['direct', 'group'].includes(native.nativeKind) || verified.kind === 'action') throw new Error('Missing signed native conversation kind')
      return { ...verified, conversationKind: native.nativeKind }
    } },
    profile: { get: async () => ({ connectionId: 'original-bot', connectionRevision: 1, application, language: null, state: 'observed', profile: null,
      metadata: null, creator: { idType: creator.idType, userId: creator.userId }, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }) } }
  let connectionOwner: ReturnType<typeof createHostConnectionOwner> | undefined
  let services!: Awaited<ReturnType<typeof createConnectionServices>>, server: core.AgentMuxControlServer, sdk: Awaited<ReturnType<typeof core.connectAgentMuxRpc>>
  const prepare = vi.fn<MoteChatAgentPort['prepare']>(async input => {
    wire.trace.push('prepare')
    const retained = (await services.ingress!.list({ connectionId: 'original-bot' })).ingresses
    expect(retained.some(record => record.kind !== 'action' && record.conversationKind === 'direct' && record.state === 'received')).toBe(true)
    return desktopAgents.prepare(input)
  })
  const agents = { ...desktopAgents, prepare }
  if (execution === 'remote') {
    hosting = await rpcOwnerFixture([], core); cleanup.push(hosting.close)
    const executionOwner = () => ({ ...hostedTestOwner(client), runtimeId: 'fixture-execution-runtime', ownerInstanceId: 'fixture-execution-owner' })
    const hostingOwner = () => ({ ...hostedTestOwner(hosting.client as core.AgentMuxClient), runtimeId: 'fixture-hosting-runtime', ownerInstanceId: hostingOwnerInstanceId })
    const authority = createConnectionExternalInputAuthority({ executionHostId: 'local', runtimeId: () => executionOwner().runtimeId,
      ingress: async () => services.ingress!, clients: () => hostingReader ? [{ hostId: 'original-hosting', client: hostingReader }] : [] })
    const executionRuntime = new AgentMuxHostedRuntimeService(client, original.store.path, executionOwner, undefined, authority)
    cleanup.push(() => executionRuntime.dispose())
    const executionServer = new core.AgentMuxControlServer({ socketPath: join(original.root, 'execution.sock'), coreClients: clients, hostedRuntime: () => executionRuntime })
    await executionServer.start(); executionEndpoint = { transport: 'unix', path: executionServer.path }; cleanup.push(() => executionServer.stop())
    const executionRpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: executionServer.path } }); cleanup.push(() => executionRpc.dispose())
    executionReader = await connectHostedAgentMux({ rpc: executionRpc, expectedRuntimeId: executionOwner().runtimeId,
      forwardRpc: async (method, params, context) => { wire.trace.push('remote-start:' + method); try { const result = await executionRpc.call(method, params, context); wire.trace.push('remote-done:' + method); return result } catch (error) { wire.trace.push('remote-error:' + method + ':' + (error as core.AgentMuxError).code); throw error } } })
    await executionReader.connect()
    const retainedReader = executionReader; cleanup.push(() => retainedReader.dispose())
    hostingRuntime = new AgentMuxHostedRuntimeService(hosting.client as core.AgentMuxClient, hosting.store.path, hostingOwner)
    cleanup.push(() => hostingRuntime!.dispose())
  }
  if (!hostingRuntime) {
    hostingRuntime = new AgentMuxHostedRuntimeService(client, original.store.path, () => ({ ...hostedTestOwner(client), runtimeId: 'fixture-original-core', ownerInstanceId: hostingOwnerInstanceId }))
    cleanup.push(() => hostingRuntime!.dispose())
  }
  const servingClients = () => executionReader ? [{ hostId: 'local', client: hosting.client }, { hostId: mainHostId, client: executionReader }] : clients()
  async function open() {
    if (mainMode) {
      connectionOwner = createHostConnectionOwner({ directory: join(original.root, 'connectors'), adapters: [adapter], spatial, moteMain: () => main, ...(executionReader ? { clients: () => [{ hostId: mainHostId, client: executionReader! }, { hostId: 'same-runtime-alias', client: executionReader! }] } : {}),
        moteChat: { agents, assertTarget: desktopAgents.assertTarget, assertReady: desktopAgents.assertReady, member: createHostMoteMembership(spatial) } })
      await connectionOwner.start({ client: hosting.client, ownerIdentity: () => execution === 'remote' ? { runtimeId: 'fixture-hosting-runtime', ownerInstanceId: hostingOwnerInstanceId } : { runtimeId: 'fixture-original-core', ownerInstanceId: hostingOwnerInstanceId } } as core.AgentMuxHeadlessRuntime)
      services = await connectionOwner.services()
    } else services = await createConnectionServices({ directory: join(original.root, 'connectors'), adapters: [adapter],
      bindings: { spatial, checkpoint }, moteChat: { ...(main ? { main: () => main } : {}), agents, assertTarget: desktopAgents.assertTarget, assertReady: desktopAgents.assertReady, member: createHostMoteMembership(spatial) },
      publication: createPublicationConversationPort(clients), ingress: { core: host => host === 'local' ? original.client : undefined } })
    server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'public.sock'), connections: services.connections, moteChat: services.moteChat!, ...(dialogue ? { moteDialogue: dialogue } : {}), spatialState: spatial, coreClients: servingClients, ...(hostingRuntime ? { hostedRuntime: () => hostingRuntime! } : {}) })
    await server.start()
    sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    if (executionReader) hostingReader = await connectHostedAgentMux({ rpc: sdk, expectedRuntimeId: 'fixture-hosting-runtime', forwardRpc: (method, params, context) => sdk.call(method, params, context) })
  }
  async function close() { await hostingReader?.dispose(); hostingReader = undefined; await sdk?.dispose(); await server?.stop(); if (connectionOwner) await connectionOwner.close(); else await services?.close() }
  await open(); cleanup.push(close)
  const cliRaw = async (command: 'configure' | 'allocate' | 'audience' | 'history' | 'diagnose' | 'events' | 'review' | 'reply' | 'inspect', input: unknown, credentials?: core.AgentMuxRpcCredentials) => {
    const overrides = credentials ? { AGENTMUX_AGENT_SESSION_ID: credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credentials.capability } : {}
    return await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'space', 'mote', 'chat', command, '--input', '-'], objectCliEnvironment(original.root, overrides), JSON.stringify(input))
  }
  const cli = async (...args: Parameters<typeof cliRaw>) => {
    const result = await cliRaw(...args)
    expect(result.code, result.stdout + result.stderr).toBe(0)
    return JSON.parse(result.stdout).result
  }
  const credential = await services!.secrets.store({ operationId: 'store-original-key', secret: native?.credential ?? 'fixture-signing-key' })
  await sdk!.call('connection.configure', { operationId: 'configure-original-bot', expectedRevision: null,
    connection: { connectionId: 'original-bot', adapterId: adapter.adapterId, application, label: 'Original bot', enabled: true, credentialRef: credential.credentialRef } })
  await cli('configure', { operationId: 'enable-original-chat', target, expectedRevision: null, expectedConnectionRevision: 1,
    ...(!native ? { refreshCreator: true } : {}),
    values: { enabled: true, connection: { connectionId: 'original-bot', application }, conversationIdleMs, strangerMessageLimit } })
  if (!native) await vi.waitFor(() => expect(wire.endpoint).toBeDefined())
  publicationRefresh.mockClear()
  const submit = client.submitAgentMessage.bind(client)
  const submissionErrors: Array<{ code?: string; message: string }> = []
  const submission = vi.spyOn(client, 'submitAgentMessage').mockImplementation(async (...args) => { wire.trace.push('core-submit');
    try { return await submit(...args) } catch (error) { submissionErrors.push({ code: (error as core.AgentMuxError).code, message: String(error) }); throw error } })
  // Dedicated-lane journeys use an invited member with an existing individual allowance.
  // Creator journeys exercise the actual logical Main path instead of a former routing assumption.
  if (!mainMode && !native) new MoteChatStore(services.database!).savePerson({ key: JSON.stringify([target.spaceId, connectionApplicationScope(application), application.appId, lanePerson.idType, lanePerson.userId]),
    spaceId: target.spaceId, person: { actor: lanePerson, creator: false, revision: 1, total: Number.MAX_SAFE_INTEGER, used: 0, remaining: Number.MAX_SAFE_INTEGER } })
  const message = (id: string, actor = mainMode ? creator : lanePerson): DirectMessage => ({ deliveryKey: `event/${id}`, recordKey: `message/${id}`, roomKey: `private/${actor.userId}`, person: actor.userId,
    text: `Original external question ${id}`, addressing: 'broadcast', nativeKind: 'direct' })
  const records = async () => (await services.ingress!.list({ connectionId: 'original-bot', limit: 100 })).ingresses as ConnectionIngressMessage[]
  async function claimed(id: string) {
    let record: ConnectionIngressMessage | undefined
    await vi.waitFor(async () => { record = (await records()).find(r => r.externalMessageId === `message/${id}`); expect(record?.state, JSON.stringify(record)).toBe('claimed') }, { timeout: 4_000 })
    return record!
  }
  async function shareMain(bindingId = 'ordinary-main-sharing', routeHostId = mainHostId) {
    await reply('original-main', 'existing-source-' + bindingId, 'Existing Main source before this explicit sharing')
    const session = (await client.readAgentSession('original-main'))!, source = session.nativeHandle
    if (source?.kind !== 'provider') throw Error('Original Main native source missing')
    const result = await sdk.call('connection.bind', { operationId: 'bind-' + bindingId, bindingId, connectionId: 'original-bot', expectedConnectionRevision: 1,
      externalConversationId: 'external-group/' + bindingId, executionHostId: routeHostId, agentSessionId: session.agentSessionId,
      expectedSource: { providerId: source.providerId, nativeSessionId: source.sessionId }, scope: { input: 'all-messages', publication: 'future-shared-conversation' } })
    if (result.state !== 'applied') throw Error('Original sharing intent not applied: ' + JSON.stringify(result))
    return result.binding
  }
  async function reply(agentSessionId: string, id: string, text: string) {
    const session = await original.client.readAgentSession(agentSessionId), source = session!.nativeHandle!
    if (source.kind !== 'provider') throw new Error('Original native source is missing')
    if (!source.transcriptPath && nativeProvider === 'grok') source.transcriptPath = join(grokHome, 'sessions', encodeCwdDirname(session!.workspacePath), source.sessionId, 'updates.jsonl')
    if (!source.transcriptPath) throw new Error('Original native path is missing')
    await appendFile(source.transcriptPath, nativeProvider === 'grok' ? [grokChunk(source.sessionId, text, id), grokDone(source.sessionId, id)].map(row => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify({ sessionId: source.sessionId, uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n')
  }
  return { ...original, shareMain, coldExecutionOwnerObservation() {
      if (!executionReader) throw Error('No original remote execution reader')
      let ready = false
      const originalOwner = executionReader.runtimeOwnerIdentity.bind(executionReader), originalRead = executionReader.readAgentSession.bind(executionReader)
      const owner = vi.spyOn(executionReader, 'runtimeOwnerIdentity').mockImplementation(() => ready ? originalOwner() : null)
      const read = vi.spyOn(executionReader, 'readAgentSession').mockImplementation(async (...args) => { const session = await originalRead(...args); ready = true; return session })
      return { owner, read }
    }, adapter, nativeInputs() { return nativeProcesses.flatMap(process => process.inputs) }, replaceHostingOwner() { hostingOwnerInstanceId += '-replacement' }, get executionEndpoint() { return executionEndpoint }, main, bindMain, endRun(runId: string) { const run = runs.get(runId)!; runs.set(runId, { ...run, state: { type: 'exited', code: 0, signal: null } }) }, feishu, agents, config, configurationPath, graph, spatial, workspace, get services() { return services }, get sdk() { return sdk }, get endpoint() { return { transport: 'unix' as const, path: server.path } }, topic, target, creator, lanePerson, guest, wire, message, records, claimed, reply, start, prepare, submission,
    cli, cliRaw, publicationRefresh, credentials(index: number) { const env = start.mock.calls[index]![0].env!; return { agentSessionId: env.AGENTMUX_AGENT_SESSION_ID!, capability: env.AGENTMUX_AGENT_CAPABILITY! } },
    submissionErrors, async restart() { await close(); await open(); if (!native) await vi.waitFor(() => expect(wire.endpoint).toBeDefined()) } }
}
