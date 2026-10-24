// @vitest-environment node
import { act } from 'react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
const browser = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const window = new Window({ url: 'http://user-card.test/' })
  for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Text', 'HTMLInputElement',
    'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLDivElement', 'HTMLImageElement', 'HTMLDetailsElement', 'Event', 'CustomEvent', 'MouseEvent',
    'KeyboardEvent', 'FocusEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver', 'DOMRect', 'Range', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia']) vi.stubGlobal(name, name === 'window' ? window : (window as unknown as Record<string, unknown>)[name])
  return window
})
import '../../mobile/test/device-locks'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '../../../packages/core/src/index.js'
import type { RoomBinding } from '@agentmux/core/connections'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { createWorkspaceLayout } from '../../../packages/core/src/spatial-layout.js'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { createConnectionExternalInputAuthority } from '../../host/src/external-input-authority.js'
import { ChannelStorage } from '../../../packages/connectors/src/channel-storage.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { createPublicationConversationPort } from '../../../packages/connectors/src/core-conversation-port.js'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { unwrapSessionInputWriteResult, unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import { MobileConversationSurface } from '../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'
import { paste, button, click } from '../../mobile/test/conversation-fixture'
import { botOpenId, feishuPayload, feishuSdkTransport, feishuConfig } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuPublicationHttp } from '../../../packages/connectors/test/fixtures/feishu-publication.js'
import { discordConfig, discordTransport } from '../../../packages/connectors/test/fixtures/discord.js'

const dom = composerDOM(), cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
afterAll(async () => {
  // Tiptap schedules editor.destroy one millisecond after React unmount. Keep
  // its original document alive through that disposal tick instead of hiding it.
  await new Promise(resolve => setTimeout(resolve, 2))
  await browser.close(); vi.unstubAllGlobals()
})
const report = process.env.AGENTMUX_SHARED_FACTS
const nativeSource = { providerId: 'codex', nativeSessionId: 'shared-native' }
const nativeRow = (id: string, text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', id, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } }) + '\n'

it('the actual App submit owner and both native channels share one conversation once, preserving queued inputs, record-only authors and an independent unknown destination', async () => {
  localStorage.clear()
  const feishu = feishuSdkTransport(), remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(remote.http.request)
  const discord = await discordTransport(); cleanup.push(discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  let services: Awaited<ReturnType<typeof createConnectionServices>>
  const authority = createConnectionExternalInputAuthority({ executionHostId: 'local', ingress: async () => services.connections.ingress! })
  class Owner extends core.AgentMuxClient { constructor(input: core.AgentMuxClientOptions) { super({ ...input, externalConversationAuthority: authority }) } }
  const f = await rpcOwnerFixture(['original-agent'], { ...core, AgentMuxClient: Owner }, root => ({ providerId: 'codex', executorId: 'codex', nativeHandle: {
    kind: 'provider', providerId: 'codex', sessionId: nativeSource.nativeSessionId, transcriptPath: join(root, 'native.jsonl')
  } })); cleanup.push(f.close)
  // Only the Runtime byte leaf is unavailable. Core must retain an original waiting input.
  f.inner.connected = false; f.inner.kernel.isConnected = () => false; vi.spyOn(f.client, 'connect').mockResolvedValue()
  const transcript = join(f.root, 'native.jsonl'), originalRun = f.client.agentSession('original-agent').run
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: nativeSource.nativeSessionId, cwd: f.root, history_mode: 'paginated' } }) + '\n' + nativeRow('before-sharing', 'Earlier private history'))
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'workspace', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { workspace: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })
  const directory = join(f.root, 'connections')
  const open = async () => services = await createConnectionServices({ directory, bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) },
    ingress: { core: host => host === 'local' ? f.client : undefined }, publication: createPublicationConversationPort(f.coreClients) })
  await open(); cleanup.push(() => services.close())
  const bindings: RoomBinding[] = []
  for (const config of [feishuConfig, discordConfig]) {
    const secret = await services.secrets.store({ operationId: config.adapterId + '-secret', secret: 'controlled-' + config.adapterId })
    await services.connections.configure({ operationId: config.adapterId + '-configure', expectedRevision: null, connection: { ...config, credentialRef: secret.credentialRef } })
    const saved = await services.connections.bindings!.bind({ operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding', connectionId: config.connectionId,
      expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' },
      externalConversationId: config.adapterId === 'feishu' ? 'original-room' : '300', expectedSource: nativeSource,
      scope: { input: 'mentions-and-replies', publication: config.adapterId === 'feishu' ? 'future-native-user-facing' : 'future-shared-conversation' } }, { actor: { kind: 'user', id: 'local-person' } })
    expect(saved.state).toBe('applied'); if (saved.state !== 'applied') throw Error('Original binding missing'); bindings.push(saved.binding)
  }
  await vi.waitFor(() => { expect(feishu.sockets.length).toBe(1); expect(discord.sessions.length).toBe(1) })
  const config = { ...structuredClone(composerConfig), workspaces: [{ ...composerConfig.workspaces[0]!, path: f.root }] }
  const { app: electronApp } = await import('electron')
  Object.assign(electronApp, { once: vi.fn() }) // Native owner shutdown hook; no native UI operation is used.
  const b = await owningBridge({ client: f.client, store: f.store, config }); cleanup.push(b.dispose)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (...args) => unwrapSessionInputWriteResult(await bridge.api!.sessions.submitPrompt(...args)))
  vi.spyOn(api.sessions, 'inspectInput').mockImplementation((...args) => bridge.api!.sessions.inspectInput(...args).then(unwrapSessionInputOperationResult))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(() => bridge.api!.ui.requestStorageFlush())
  const session = { ...composerSession('original-agent'), workspacePath: f.root, nativeHandle: f.client.agentSession('original-agent').nativeHandle,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: 'original-agent', run: originalRun } }
  useAppStore.setState({ config, sessions: [session], providerCatalog: f.client.providers.catalog(), agentComposerDrafts: {}, agentSteerQueues: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {}, loading: false })
  const posts = () => ({ feishu: remote.messageCalls().filter(call => call.method === 'POST').map(call => call.body), discord: discord.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages').map(call => call.body) })
  const contains = (body: string, text: string) => {
    const value = JSON.parse(body), card = typeof value.content === 'string' ? JSON.parse(value.content) : value
    const strings = (node: unknown): string[] => typeof node === 'string' ? [node] : Array.isArray(node) ? node.flatMap(strings) : node && typeof node === 'object' ? Object.values(node).flatMap(strings) : []
    return strings(card).some(value => value.includes(text))
  }
  const copies = (text: string) => Object.fromEntries(Object.entries(posts()).map(([key, bodies]) => [key, bodies.filter(body => contains(body, text)).length]))
  try {
  const submit = async (text: string) => {
    await dom.render(<AgentSessionComposer sessionId="original-agent" />); await paste(dom.container, text)
    const send = dom.container.querySelector<HTMLButtonElement>('.composer-send')!; expect(send.disabled).toBe(false)
    await act(async () => send.click())
    await vi.waitFor(async () => expect((await f.client.sessionTimeline('original-agent')).items.find(item => item.content === text)).toMatchObject({ authorHuman: true, publicContent: 'confirmed', inputSubmission: { status: 'waiting' } }), { timeout: 8000 })
  }
  const partialApp = 'App input before explicit whole conversation sharing'
  await submit(partialApp)
  await vi.waitFor(() => expect(copies(partialApp)).toEqual({ feishu: 0, discord: 1 }), { timeout: 8000 })
  const previous = bindings[0]!
  const expanded = await services.connections.bindings!.relink({ operationId: 'explicit-whole-sharing', bindingId: previous.bindingId, expectedRevision: previous.revision,
    connectionId: previous.connectionId, expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' }, externalConversationId: previous.externalConversationId,
    expectedSource: nativeSource, scope: { input: previous.scope.input, publication: 'future-shared-conversation' } }, { actor: { kind: 'user', id: 'local-person' } })
  expect(expanded.state).toBe('applied'); if (expanded.state !== 'applied') throw Error('Whole sharing was not saved'); bindings[0] = expanded.binding
  const app = 'App original user 中文🙂\nEvery line stays complete', answer = 'Original public Agent reply'
  await submit(app)
  await vi.waitFor(() => expect(copies(app), 'A queued explicit App input must reach both real SDK transports').toEqual({ feishu: 1, discord: 1 }), { timeout: 8000 }).catch(async error => { if (report) await writeFile(report + '.failure.json', JSON.stringify({ timeline: await f.client.sessionTimeline('original-agent'), read: await f.client.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent' }), bindings, states: bindings.map(binding => ({ observation: services.publication!.observation(binding.bindingId, binding.revision), operations: services.publication!.store.list(binding) })), posts: posts() }, null, 2)); throw error })
  await appendFile(transcript, nativeRow('shared-answer', answer)); services.publication!.refresh()
  await vi.waitFor(() => expect(copies(answer)).toEqual({ feishu: 1, discord: 1 }), { timeout: 8000 })
  const sameBody = 'Equal text from distinct original people 中文🙂'
  const lark = feishuPayload({ message_id: 'original-lark-message', content: JSON.stringify({ text: sameBody }) }); lark.header.event_id = 'original-lark-event'
  await feishu.receive(lark)
  await vi.waitFor(() => expect(copies(sameBody)).toEqual({ feishu: 0, discord: 1 }), { timeout: 8000 })
  const incomingDiscord = discord.message('710', sameBody)
  await vi.waitFor(() => expect(copies(sameBody)).toEqual({ feishu: 1, discord: 1 }), { timeout: 8000 })
  discord.message('711', sameBody, { author: { id: '401', username: 'another-person' } })
  await vi.waitFor(() => expect(copies(sameBody)).toEqual({ feishu: 2, discord: 1 }), { timeout: 8000 })
  const captured = (await f.client.sessionTimeline('original-agent')).items.filter(item => item.authorExternal)
  expect(captured).toHaveLength(3)
  expect(captured.map(item => item.authorExternal!.externalMessageId).sort()).toEqual(['710', '711', 'original-lark-message'])
  expect(new Set(captured.map(item => JSON.stringify(item.authorExternal!.actor))).size).toBe(3)
  expect(captured.every(item => item.content === sameBody && !item.inputRef && item.externalInput?.code === 'INGRESS_ACTOR_NOT_AUTHORIZED')).toBe(true)
  const hosted = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client)); cleanup.push(() => hosted.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'read.sock'), hostedRuntime: () => hosted, connections: services.connections, coreClients: f.coreClients, spatialState: spatial })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const reader = await connectHostedAgentMux({ rpc }); cleanup.push(() => reader.dispose())
  await dom.render(<MobileConversationSurface client={reader} agentSessionId="original-agent" connection={{ state: 'connected', message: 'Original Host' }} platform={createBrowserPlatform()} onShowTerminal={() => {}} />)
  await vi.waitFor(() => expect(dom.container.textContent?.split(sameBody).length).toBe(4), { timeout: 8000 })
  for (const line of app.split('\n')) expect(dom.container.textContent).toContain(line)
  const appDelivery = services.publication!.store.list(bindings[0]!).find(op => op.payload.kind === 'speech' && op.payload.text.includes(app))!
  const publicDelivery = await rpc.call('connection.delivery.inspect', { operationId: appDelivery.operationId })
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'inspect', '--operation-id', appDelivery.operationId], objectCliEnvironment(f.root))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(publicDelivery)
  expect(publicDelivery.delivery!.relay!.sources[0]!.author).toEqual({ kind: 'human' })
  // Replayed originals and actual application delivery echoes must not become new users.
  const again = structuredClone(lark); again.header.event_id = 'lark-redelivery'; await feishu.receive(again)
  const sequence = discord.emit('MESSAGE_CREATE', incomingDiscord)
  for (const message of remote.records.values()) {
    const echo = feishuPayload({ message_id: message.message_id, message_type: message.msg_type, content: (message.body as { content: string }).content })
    echo.header.event_id = 'own-' + message.message_id; echo.event.sender = { sender_type: 'app', sender_id: { open_id: botOpenId, user_id: 'own-bot' } }; await feishu.receive(echo)
  }
  const channel = new ChannelStorage(services.database!).namespace(discordConfig)
  await vi.waitFor(() => expect((channel.get('gateway-session:0')!.value as { kind: 'json'; value: { sequence: number } }).value.sequence).toBeGreaterThanOrEqual(sequence))
  expect((await f.client.sessionTimeline('original-agent')).items.filter(item => item.authorExternal)).toHaveLength(3)
  expect(copies(sameBody)).toEqual({ feishu: 2, discord: 1 })
  // A genuine SDK request reaches the native server but loses its response/witness.
  await dom.render(null); discord.loseNextMessageResponse(false)
  const unknownBody = 'Independent unknown destination keeps original operation'
  await submit(unknownBody)
  await vi.waitFor(() => { expect(copies(unknownBody)).toEqual({ feishu: 1, discord: 1 }); expect(services.publication!.store.list(bindings[1]!).find(op => op.payload.kind === 'speech' && op.payload.text.includes(unknownBody))?.state).toBe('unknown') }, { timeout: 8000 })
  const unknown = services.publication!.store.list(bindings[1]!).find(op => op.payload.kind === 'speech' && op.payload.text.includes(unknownBody))!
  await services.close(); await open()
  await vi.waitFor(() => expect(discord.sessions.length).toBeGreaterThan(1))
  expect(services.publication!.store.list(bindings[1]!).find(op => op.operationId === unknown.operationId)).toMatchObject({ state: 'unknown', prepared: unknown.prepared })
  expect(copies(unknownBody)).toEqual({ feishu: 1, discord: 1 })
  expect(copies(app)).toEqual({ feishu: 1, discord: 1 }); expect(copies(answer)).toEqual({ feishu: 1, discord: 1 }); expect(copies(partialApp)).toEqual({ feishu: 0, discord: 1 })
  expect(JSON.stringify(posts())).not.toContain('Earlier private history')
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  expect(f.client.agentSession('original-agent').run).toEqual(originalRun)
  } finally {
    if (report) await writeFile(report, JSON.stringify({ timeline: (await f.client.sessionTimeline('original-agent')).items, destinations: posts(),
      bindings, observations: bindings.map(binding => ({ bindingId: binding.bindingId, observation: services.publication!.observation(binding.bindingId, binding.revision), operations: services.publication!.store.list(binding) })),
      originalRunRetained: f.client.agentSession('original-agent').run.runId === originalRun.runId, agentByteEffects: (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length,
      namespace: 'controlled fixtures only; no live platform, native Agent turn or ordinary Terminal qualification' }, null, 2))
  }
}, 45_000)
