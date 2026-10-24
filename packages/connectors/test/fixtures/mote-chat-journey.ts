import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import type { ConnectionIngressMessage } from '@agentmux/core/connections'
import { spatialCatalog } from '@agentmux/core/spatial-state'
import { createPublicationConversationPort, PublicationHost, type ConnectionAdapter, type MoteChatAgentPort } from '@agentmux/connectors'
import { rpcOwnerFixture } from '../../../core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'
import { createConnectionServices } from '../../src/connection-services.js'
import { ScratchTopics, createMoteChatResources, readMoteResourceConfiguration } from '@agentmux/host/mote-resources'
import { createMoteChatAgents as createHostMoteChatAgents } from '@agentmux/host/mote-chat-agents'
import { directoryIdentity, homeZoneId } from '@agentmux/host/mote-model'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import type { AppConfig, WorkspaceRecord } from '../../../../apps/desktop/src/shared/contracts.js'
import { encodeCwdDirname } from '../../../core/src/providers/grok-native-history.js'
import { grokChunk, grokDone, grokUpdate } from '../../../core/test/fixtures/grok-updates.js'
import { feishuConfig } from './feishu.js'
import { feishuPublicationHttp } from './feishu-publication.js'
import { FeishuAdapter } from '../../src/adapters/feishu/index.js'
import { signedRoomAdapter, type SignedRoomMessage } from './signed-room-adapter.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })
type DirectMessage = SignedRoomMessage & { nativeKind: 'direct' | 'group' }

export async function moteChatJourneyFixture(strangerMessageLimit = 1, conversationIdleMs = 60_000, mode: 'desktop' | 'headless' = 'desktop', nativeAfterInput = false, nativeProvider: 'claude' | 'grok' = 'claude') {
  const publicationRefresh = vi.spyOn(PublicationHost.prototype, 'refresh')
  const original = await rpcOwnerFixture([], core)
  const client = original.client as core.AgentMuxClient
  const grokHome = join(original.root, 'grok')
  if (nativeProvider === 'grok') vi.stubEnv('GROK_HOME', grokHome)
  const feishu = nativeProvider === 'grok' ? await feishuPublicationHttp() : undefined
  if (feishu) cleanup.push(feishu.close)
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
    const number = runs.size + 1, runId = `native-run-${number}`, pid = 400_000 + number
    const resumeIndex = input.args.indexOf('--resume'), resumed = resumeIndex < 0 ? undefined : [...sources.values()].find(source => source.id === input.args[resumeIndex + 1])
    if (resumeIndex >= 0 && !resumed) throw new Error('Resume must retain an existing original native conversation')
    const id = resumed?.id ?? `native-chat-${number}`
    const path = resumed?.path ?? (nativeProvider === 'grok'
      ? join(grokHome, 'sessions', encodeCwdDirname(topic.physicalDirectoryPath!), id, 'updates.jsonl') : join(original.root, `${id}.jsonl`))
    if (nativeProvider === 'grok' && !resumed) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(join(path, '..', 'summary.json'), JSON.stringify({ info: { id, cwd: topic.physicalDirectoryPath! } }))
    }
    if (!resumed && !nativeAfterInput) await writeFile(path, JSON.stringify(nativeProvider === 'grok' ? grokUpdate(id, { sessionUpdate: 'current_mode_update', currentModeId: 'chat' }) : { sessionId: id, uuid: 'original-context', type: 'system', message: { role: 'system', content: 'Native system context' } }) + '\n')
    const run = { ...original.run(runId), lifecycleOperationId: input.operationKey ?? null, program: nativeProvider, pid, workspacePath: topic.physicalDirectoryPath! }
    runs.set(runId, run); sources.set(pid, { id, path }); return run
  })
  inner.kernel.start = start
  inner.kernel.status = async (id: string) => { const run = runs.get(id); if (!run) throw new Error('Unknown original native Run'); return run }
  inner.kernel.inspectCreation = async (operationId: string) => [...runs.values()].find(run => run.lifecycleOperationId === operationId) ?? null
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: core.AgentMuxAgentSession) => session
  vi.spyOn(client, 'probeAgent').mockImplementation(async id => ({ providerId: id, executable: id, installed: true, capabilities: new core.AgentProviderRegistry().get(id).catalog.capabilities }))
  const provider = inner.providers.get(nativeProvider) as core.AgentProvider & Required<Pick<core.AgentProvider, 'discoverNativeSession'>>
  if (nativeProvider === 'claude') {
    expect(typeof provider.discoverNativeSession).toBe('function')
    vi.spyOn(provider, 'discoverNativeSession').mockImplementation(async ({ processId }) => {
      const source = sources.get(processId)
      return source && (!nativeAfterInput || inputCreatedSources.has(processId)) ? { handle: { kind: 'provider' as const, providerId: 'claude', sessionId: source.id, transcriptPath: source.path }, assertCurrent: async () => {} } : null
    })
  } else {
    // Exact Hook/Run identity leaf; the real Grok normalizer supplies the native
    // handle. No Claude discovery or fake Grok changes method is substituted.
    inner.ensureTerminalHandshakeOrDegrade = async (session: core.AgentMuxAgentSession) => {
      const run = runs.get(session.run.runId)!, source = sources.get(run.pid!)!
      const normalized = provider.normalizeHook({ receiptId: 'synthetic-grok-hook', agentSessionId: session.agentSessionId,
        runId: run.runId, providerId: 'grok', payload: { hookEventName: 'user_prompt_submit', sessionId: source.id } }, {})
      expect(normalized.nativeHandle).toEqual({ kind: 'provider', providerId: 'grok', sessionId: source.id })
      const registry = Reflect.get(client, 'registry') as { update(id: string, run: core.AgentMuxAgentSession['run'], change: (current: core.AgentMuxStoredAgentSession) => core.AgentMuxStoredAgentSession): Promise<unknown> }
      await registry.update(session.agentSessionId, session.run, current => ({ ...current, nativeHandle: normalized.nativeHandle! }))
      return { ...session, nativeHandle: normalized.nativeHandle! }
    }
  }
  const inputCreatedSources = new Set<number>()
  if (nativeAfterInput) {
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
    const runtimeId = 'original-mote-host'
    const hostExecutorOwner = new core.AgentMuxHostExecutorOwner({ path: join(original.root, 'host-executors.json'), runtimeId, catalog: () => client.catalog() })
    Object.assign(client, { hostExecutorOwner, creationAuthority: new core.AgentMuxCreationAuthority({ stateDirectory: join(original.root, 'creation'), runtimeId }) })
    await client.configureHostExecutor({ executorId: 'saved-chat', config: { label: 'Original saved chat', providerId: nativeProvider, command: process.execPath, args: ['--chosen'], env: { MOTE_VALUE: 'host-owned', ...(nativeProvider === 'grok' ? { GROK_HOME: grokHome } : {}) }, injectAgentMuxGuide: false } })
  }
  const desktopAgents = mode === 'headless'
    ? createHostMoteChatAgents({ resources: createMoteChatResources({ topics, catalog: async () => spatialCatalog(graph), configuration: target => readMoteResourceConfiguration(configurationPath, target) }), clients })
    : (await import('../../../../apps/desktop/src/main/mote-chat-agents.js')).createMoteChatAgents({ config: () => config, catalog: async () => spatialCatalog(graph), topics, clients })
  const wire = signedRoomAdapter(nativeProvider === 'grok' ? 'feishu' : 'signed-room'), application = { domain: nativeProvider === 'grok' ? 'open.feishu.cn' : 'signed.example', appId: nativeProvider === 'grok' ? feishuConfig.application.appId : 'original-mote-app' }
  const creator = { application, idType: 'email', userId: 'creator@example.test' }, guest = { ...creator, userId: 'guest@example.test' }
  const verify = wire.adapter.ingress!.verify
  const adapter: ConnectionAdapter = { ...wire.adapter, ...(feishu ? { publication: new FeishuAdapter({ http: feishu.http }).publication } : {}),
    ingress: { ...wire.adapter.ingress!, verify: async (...args) => {
      const verified = await verify(...args), native = JSON.parse(args[1]) as DirectMessage
      if (!['direct', 'group'].includes(native.nativeKind) || verified.kind === 'action') throw new Error('Missing signed native conversation kind')
      return { ...verified, conversationKind: native.nativeKind }
    } },
    profile: { get: async () => ({ connectionId: 'original-bot', connectionRevision: 1, application, language: null, state: 'observed', profile: null,
      metadata: null, creator: { idType: creator.idType, userId: creator.userId }, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }) } }
  let services: Awaited<ReturnType<typeof createConnectionServices>>, server: core.AgentMuxControlServer, sdk: Awaited<ReturnType<typeof core.connectAgentMuxRpc>>
  const prepare = vi.fn<MoteChatAgentPort['prepare']>(async input => {
    wire.trace.push('prepare')
    const retained = (await services.ingress!.list({ connectionId: 'original-bot' })).ingresses
    expect(retained.some(record => record.kind !== 'action' && record.conversationKind === 'direct' && record.state === 'received')).toBe(true)
    return desktopAgents.prepare(input)
  })
  const agents = { ...desktopAgents, prepare }
  async function open() {
    services = await createConnectionServices({ directory: join(original.root, 'connectors'), adapters: [adapter],
      bindings: { spatial, checkpoint }, moteChat: { agents, assertTarget: desktopAgents.assertTarget, assertReady: desktopAgents.assertReady },
      publication: createPublicationConversationPort(clients), ingress: { core: host => host === 'local' ? original.client : undefined } })
    server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'public.sock'), connections: services.connections, moteChat: services.moteChat!, spatialState: spatial, coreClients: clients })
    await server.start()
    sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  }
  async function close() { await sdk?.dispose(); await server?.stop(); services?.close() }
  await open(); cleanup.push(close)
  const cli = async (command: 'configure' | 'history' | 'diagnose', input: unknown, credentials?: core.AgentMuxRpcCredentials) => {
    const overrides = credentials ? { AGENTMUX_AGENT_SESSION_ID: credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credentials.capability } : {}
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'space', 'mote', 'chat', command, '--input', '-'], objectCliEnvironment(original.root, overrides), JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0)
    return JSON.parse(result.stdout).result
  }
  const credential = await services!.secrets.store({ operationId: 'store-original-key', secret: 'fixture-signing-key' })
  await sdk!.call('connection.configure', { operationId: 'configure-original-bot', expectedRevision: null,
    connection: { connectionId: 'original-bot', adapterId: adapter.adapterId, application, label: 'Original bot', enabled: true, credentialRef: credential.credentialRef } })
  await cli('configure', { operationId: 'enable-original-chat', target, expectedRevision: null, expectedConnectionRevision: 1,
    values: { enabled: true, connection: { connectionId: 'original-bot', application }, conversationIdleMs, strangerMessageLimit } })
  await vi.waitFor(() => expect(wire.endpoint).toBeDefined())
  publicationRefresh.mockClear()
  const submit = client.submitAgentMessage.bind(client)
  const submissionErrors: Array<{ code?: string; message: string }> = []
  const submission = vi.spyOn(client, 'submitAgentMessage').mockImplementation(async (...args) => { wire.trace.push('core-submit');
    try { return await submit(...args) } catch (error) { submissionErrors.push({ code: (error as core.AgentMuxError).code, message: String(error) }); throw error } })
  const message = (id: string, actor = creator): DirectMessage => ({ deliveryKey: `event/${id}`, recordKey: `message/${id}`, roomKey: `private/${actor.userId}`, person: actor.userId,
    text: `Original external question ${id}`, addressing: 'broadcast', nativeKind: 'direct' })
  const records = async () => (await services.ingress!.list({ connectionId: 'original-bot', limit: 100 })).ingresses as ConnectionIngressMessage[]
  async function claimed(id: string) {
    let record: ConnectionIngressMessage | undefined
    await vi.waitFor(async () => { record = (await records()).find(r => r.externalMessageId === `message/${id}`); expect(record?.state).toBe('claimed') }, { timeout: 4_000 })
    return record!
  }
  async function reply(agentSessionId: string, id: string, text: string) {
    const session = await original.client.readAgentSession(agentSessionId), source = session!.nativeHandle!
    if (source.kind !== 'provider') throw new Error('Original native source is missing')
    if (!source.transcriptPath && nativeProvider === 'grok') source.transcriptPath = join(grokHome, 'sessions', encodeCwdDirname(session!.workspacePath), source.sessionId, 'updates.jsonl')
    if (!source.transcriptPath) throw new Error('Original native path is missing')
    await appendFile(source.transcriptPath, nativeProvider === 'grok' ? [grokChunk(source.sessionId, text, id), grokDone(source.sessionId, id)].map(row => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify({ sessionId: source.sessionId, uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n')
  }
  return { ...original, feishu, agents, config, configurationPath, graph, workspace, get services() { return services }, get sdk() { return sdk }, topic, target, creator, guest, wire, message, records, claimed, reply, start, prepare, submission,
    cli, publicationRefresh, credentials(index: number) { const env = start.mock.calls[index]![0].env!; return { agentSessionId: env.AGENTMUX_AGENT_SESSION_ID!, capability: env.AGENTMUX_AGENT_CAPABILITY! } },
    submissionErrors, async restart() { await close(); await open(); await vi.waitFor(() => expect(wire.endpoint).toBeDefined()) } }
}
