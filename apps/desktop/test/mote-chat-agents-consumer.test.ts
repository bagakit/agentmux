import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxError, AgentMuxFileAgentSessionStore, AgentProviderRegistry, type AgentMuxAgentCreateInput, type AgentMuxAgentSession } from '@agentmux/core'
import { spatialCatalog } from '@agentmux/core/spatial-state'
import { ConnectionHost, MoteChatHost } from '@agentmux/connectors'
import { createMoteChatAgents } from '../src/main/mote-chat-agents.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts.js'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

const close: Array<() => void | Promise<void>> = []
afterEach(async () => {
  try { for (const cleanup of close.splice(0).reverse()) await cleanup() }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs() }
})
async function fixture(savedExecutor = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-chat-agents-')))
  close.push(() => rm(root, { recursive: true, force: true }))
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Mote homes', hostId: 'local', path: join(root, 'scratch'), kind: 'folder' }
  await mkdir(workspace.path)
  const topics = new ScratchTopics(), topic = await topics.ensureMote(workspace, 'view:direct-chat')
  await writeFile(join(topic.physicalDirectoryPath!, 'MOTE.md'), savedExecutor ? '---\nversion: 1\ndefaults:\n  executorId: chosen\n---\n' : '---\nversion: 1\n---\n')
  await writeFile(join(topic.physicalDirectoryPath!, 'SOUL.md'), '# Saved Mote personality\nPreserve original personality.\n')
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
  const target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const graph = {
    spaces: [{ spaceId, kind: 'mote' as const, name: 'Same name', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, projectId: null, topicId: topic.id }],
    zones: [{ zoneId, workspaceId: workspace.id, kind: 'home' as const, hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null }],
    bindings: [{ spaceId, zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {}
  }
  const config = { hosts: [{ id: 'local', kind: 'local', label: 'This host' }], workspaces: [workspace],
    executors: { chosen: { label: 'Saved new-chat Executor', providerId: 'claude', command: 'claude', args: ['--chosen'], env: { MOTE_VALUE: 'saved-value' }, injectAgentMuxGuide: false },
      first: { label: 'Unchosen first Executor', providerId: 'codex', command: 'codex', injectAgentMuxGuide: false } },
    profile: { displayName: 'Original owner', about: 'Shared saved context', avatar: '', shareWithAgents: true }
  } as unknown as AppConfig

  // The public Core creation, durable Session/operation owner and launch composition execute.
  // Only the native process/Hook/probe boundary is controlled; no live user Runtime or CLI is touched.
  for (const name of Object.keys(process.env).filter(name => name.startsWith('AGENTMUX_'))) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), client = new AgentMuxClient({ store })
  close.push(() => client.dispose())
  const inner = client as unknown as {
    connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: Record<string, unknown>; hookServer: Record<string, unknown>
    ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown; promptSubmission: { submitInputPlan: unknown }
  }
  await inner.registry.load('local'); inner.connected = true
  const run = () => ({ nativeService: null, runId: 'native-chat-run', lifecycleOperationId: null, program: 'claude', args: [], workspacePath: topic.physicalDirectoryPath!,
    pid: 424242, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 })
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'private-adapter', protocolVersion: 18, buildIdentity: 'fixture' })
  inner.kernel.status = async () => run()
  const start = vi.fn(async (_input: { args: string[] }) => run()), stop = vi.fn()
  inner.kernel.start = start; inner.kernel.stop = stop
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  vi.spyOn(client, 'probeAgent').mockImplementation(async id => ({ providerId: id, executable: id, installed: true, capabilities: new AgentProviderRegistry().get(id).catalog.capabilities }))
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  inner.promptSubmission.submitInputPlan = vi.fn(async () => {})

  const clients = [{ hostId: 'local', client }]
  const options = { config: () => config, catalog: async () => spatialCatalog(graph), topics, clients: () => clients }
  const agents = createMoteChatAgents(options)
  const application = { domain: 'chat.example', appId: 'original-app' }, actor = { application, idType: 'open_id', userId: 'original-creator' }
  const connections = new ConnectionHost({ databasePath: join(root, 'connections.sqlite'), secrets: { resolve: async () => 'private-credential' }, adapters: [{
    adapterId: 'sample', test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'ready' }, delivery: { state: 'ready' } }),
    profile: { get: async () => ({ connectionId: 'original-bot', connectionRevision: 1, application, language: null, state: 'observed', profile: null,
      metadata: null, creator: { idType: actor.idType, userId: actor.userId }, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }) }
  }] })
  close.push(() => connections.close())
  await connections.configure({ operationId: 'save-bot', expectedRevision: null, connection: { connectionId: 'original-bot', adapterId: 'sample', application, label: 'Same name', enabled: true, credentialRef: 'original-credential' } })
  const host = new MoteChatHost({ connections, agents, assertTarget: agents.assertTarget })
  await host.configure({ operationId: 'configure-chat', target, expectedRevision: null, expectedConnectionRevision: 1,
    values: { enabled: true, connection: { connectionId: 'original-bot', application }, conversationIdleMs: 30 * 60_000, strangerMessageLimit: 0 } },
  { actor: { kind: 'user', id: 'original-device-user' } })
  const incoming = { conversationKind: 'direct' as const, ingressId: 'original-ingress', connectionId: 'original-bot', application,
    externalMessageId: 'original-message', externalConversationId: 'original-private-chat', actor }
  return { root, workspace, topic, target, graph, config, store, client, start, stop, clients, options, agents, host, connections, incoming }
}

it('lazily creates through the real Mote and Core owners without a Region or fabricated initial user message', async () => {
  const f = await fixture(), creation = vi.spyOn(f.client, 'createAgentWithDelivery')
  await f.agents.assertReady(f.target)
  expect(f.start).not.toHaveBeenCalled()
  const binding = await f.host.prepareIncoming(f.incoming)
  expect(binding).toMatchObject({ executionHostId: 'local', externalConversationId: f.incoming.externalConversationId })
  expect(binding).not.toHaveProperty('regionAnchor')
  expect(f.graph.regions).toEqual([])
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
  const input = creation.mock.calls[0]![0]
  expect(input).toMatchObject({ agentSessionId: binding!.agentSessionId, executorId: 'chosen', providerId: 'claude', workspacePath: f.topic.physicalDirectoryPath,
    env: { MOTE_VALUE: 'saved-value', AGENTMUX_WIKI_DIR: f.topic.physicalDirectoryPath } })
  expect(input).not.toHaveProperty('prompt'); expect(input).not.toHaveProperty('initialMessage')
  expect(input.agentMuxNote).toContain('Earlier Agents in this same private-chat lane (newest first):')
  expect(input.agentMuxNote).toContain('space mote chat history --input -')
  expect(input.agentMuxNote).toContain('Original owner')
  expect(input.optionalContext!.map(context => context.text).join('\n')).toContain('Preserve original personality.')
  expect(input.optionalContext!.map(context => context.text).join('\n')).not.toContain('space mote chat history --input -')
  expect(f.start.mock.calls[0]![0].args.join('\n')).toContain('space mote chat history --input -')
  const actual = await f.client.readAgentSession(binding!.agentSessionId)
  expect(actual?.creation).toMatchObject({ createOperationId: input.createOperationId, initialPrompt: 'not-requested', agentMuxContext: 'confirmed' })
  expect(await f.store.load()).toEqual([expect.objectContaining({ agentSessionId: binding!.agentSessionId })])
  await expect(f.host.prepareIncoming(f.incoming)).resolves.toMatchObject({ bindingId: binding!.bindingId })
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('requires this exact Mote saved Executor and never chooses the first Provider or creates during validation', async () => {
  const f = await fixture(false), identityFiles = await readdir(join(f.topic.physicalDirectoryPath!, '.agents'))
  await f.agents.assertTarget(f.target)
  await expect(f.agents.assertReady(f.target)).rejects.toMatchObject({ code: 'MOTE_CHAT_EXECUTOR_REQUIRED' })
  await expect(f.host.prepareIncoming(f.incoming)).rejects.toMatchObject({ code: 'MOTE_CHAT_EXECUTOR_REQUIRED' })
  expect(await readdir(join(f.topic.physicalDirectoryPath!, '.agents'))).toEqual(identityFiles)
  expect(f.start).not.toHaveBeenCalled()
  await writeFile(join(f.topic.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults:\n  executorId: removed\n---\n')
  await expect(f.agents.assertReady(f.target)).rejects.toMatchObject({ code: 'MOTE_CHAT_EXECUTOR_UNAVAILABLE' })
  await expect(f.agents.assertTarget({ ...f.target, spaceId: 'same-name-neighbour' })).rejects.toMatchObject({ code: 'MOTE_CHAT_TARGET_UNCONFIRMED' })
  expect(f.start).not.toHaveBeenCalled()
})

it('keeps the original created Agent usable without waiting for native history', async () => {
  const f = await fixture(), creation = vi.spyOn(f.client, 'createAgentWithDelivery'), inspection = vi.spyOn(f.client, 'inspectAgentCreation')
  const checkpoint = vi.spyOn(f.client, 'conversationCheckpoint').mockRejectedValue(new AgentMuxError('Original native source is not observed yet', 'CONVERSATION_SOURCE_UNAVAILABLE'))
  await expect(f.host.prepareIncoming(f.incoming)).resolves.toMatchObject({ sourceCheckpoints: [], publicationOrigin: { createOperationId: expect.any(String) } })
  expect(checkpoint).not.toHaveBeenCalled()
  expect(creation).toHaveBeenCalledTimes(1)
  const original = structuredClone(creation.mock.calls[0]![0])
  f.config.executors.chosen!.command = 'later-executor-command'
  await writeFile(join(f.topic.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults:\n  executorId: first\n---\n')
  const restarted = new MoteChatHost({ connections: f.connections,
    agents: createMoteChatAgents(f.options), assertTarget: f.agents.assertTarget })
  const result = await restarted.prepareIncoming(f.incoming)
  expect(result).toMatchObject({ agentSessionId: original.agentSessionId })
  expect(inspection).toHaveBeenCalledTimes(2)
  expect(inspection.mock.calls).toEqual([[original.agentSessionId], [original.agentSessionId]])
  expect(creation).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
})

it('reads typed native activity only and retains unknown instead of borrowing metadata freshness or another Host', async () => {
  const f = await fixture(), binding = await f.host.prepareIncoming(f.incoming), actual = (await f.client.readAgentSession(binding!.agentSessionId))!
  const reading = vi.spyOn(f.client, 'readAgentSession')
  reading.mockResolvedValueOnce({ ...actual, updatedAt: 999_999, semanticStatus: { state: 'running', source: 'run-process', observedAt: 999_999 } })
  await expect(f.agents.activity({ executionHostId: 'local', agentSessionId: actual.agentSessionId })).resolves.toEqual({ lastActivityAt: null })
  reading.mockResolvedValueOnce({ ...actual, updatedAt: 999_999, semanticStatus: { state: 'done', source: 'native-hook', observedAt: 101 } })
  await expect(f.agents.activity({ executionHostId: 'local', agentSessionId: actual.agentSessionId })).resolves.toEqual({ lastActivityAt: 101 })
  reading.mockResolvedValueOnce(null)
  await expect(f.agents.activity({ executionHostId: 'local', agentSessionId: actual.agentSessionId })).resolves.toEqual({ lastActivityAt: null })
  await expect(f.agents.activity({ executionHostId: 'other-host', agentSessionId: actual.agentSessionId })).rejects.toMatchObject({ code: 'MOTE_CHAT_HOST_UNAVAILABLE' })
  expect(f.stop).not.toHaveBeenCalled()
})

it('keeps unconfirmed required context and foreign creation receipts from becoming a ready chat', async () => {
  const f = await fixture(), creation = vi.spyOn(f.client, 'createAgentWithDelivery')
  await f.host.prepareIncoming(f.incoming)
  const input = structuredClone(creation.mock.calls[0]![0]), actual = (await f.client.readAgentSession(input.agentSessionId!))!
  const prepared = { executionHostId: 'local', input: input as AgentMuxAgentCreateInput }
  const inspection = vi.spyOn(f.client, 'inspectAgentCreation')
  inspection.mockResolvedValueOnce({ ...actual, creation: { ...actual.creation!, agentMuxContext: 'unknown' } })
  await expect(f.agents.inspect(prepared)).rejects.toMatchObject({ code: 'MOTE_CHAT_CONTEXT_UNCONFIRMED' })
  inspection.mockResolvedValueOnce({ ...actual, creation: { ...actual.creation!, createOperationId: 'another-create' } })
  await expect(f.agents.inspect(prepared)).rejects.toMatchObject({ code: 'MOTE_CHAT_CREATE_MISMATCH' })
  expect(creation).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
})
