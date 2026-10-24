import { appendFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import * as connectors from '@agentmux/connectors'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { feishuConfig, feishuSdkTransport, feishuPayload } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuMediaPlatform } from '../../../packages/connectors/test/fixtures/feishu-media-platform.js'
import { imagePng } from '../../desktop/test/fixtures/mote-identity-image.js'
import { startAgentMuxHost } from '../src/host.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { saveObjectAvatarFile } from '../src/object-avatar-files.js'
import { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } from '../src/mote-model.js'
import { prepareDiscordPublication } from '../../../packages/connectors/src/adapters/discord/render.js'
import { FeishuPublicationAdapter } from '../../../packages/connectors/src/adapters/feishu/publication.js'
import { FeishuAdapter } from '../../../packages/connectors/src/adapters/feishu/index.js'
import { publicationSpeaker } from '../../../packages/connectors/src/publication-speaker.js'
import { createWorkspaceLayout } from '@agentmux/core/spatial-layout'
import { rasterizeStaticAvatar, savedMoteAvatarDrawing } from '../src/static-avatar.js'
import * as staticArtwork from '../src/static-avatar.js'
import { createHash } from 'node:crypto'
import { agentAvatarSvg } from '@agentmux/client-ui/agent-avatar-svg'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })
const native = (sessionId: string, uuid: string, text: string) => JSON.stringify({ type: 'assistant', sessionId, uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'

async function fixture(ordinaryName?: string, extraSessions: string[] = []) {
  const original = await rpcOwnerFixture(['ordinary-agent'], core, root => ({ providerId: 'claude', executorId: 'claude',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'ordinary-native', transcriptPath: join(root, 'ordinary.jsonl') } }))
  for (const id of extraSessions) {
    const previous = (await original.store.readMetadata('ordinary-agent'))!, { nativeHandle: _handle, ...retained } = previous
    await original.store.compareAndSwap(null, { ...retained, agentSessionId: id, run: { runId: 'run-' + id }, executorId: id + '-executor' })
  }
  cleanup.push(original.close); const sdk = feishuSdkTransport()
  const remote = await feishuMediaPlatform(); cleanup.push(remote.close)
  const request = vi.mocked(defaultHttpInstance.request).getMockImplementation()!
  vi.mocked(defaultHttpInstance.request).mockImplementation(async input => input.url?.includes('/application/v6/applications/')
    ? { code: 0, data: { app: { app_id: feishuConfig.application.appId, creator_id: 'original-external-user' } } } as never : request(input))
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(await realpath(original.root), 'homes') }
  await mkdir(workspace.path)
  const topics = new ScratchTopics(), topic = await topics.ensureMote(workspace, 'view:role-original'), png = imagePng()
  await writeFile(join(topic.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults:\n  executorId: saved-chat\n---\n')
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId), ref = await saveObjectAvatarFile(topic.physicalDirectoryPath!, png)
  const target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const spatial = new core.AgentMuxSpatialStateStore(join(original.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId, kind: 'mote', name: topic.title, hostId: 'local', directoryPath: topic.physicalDirectoryPath!, projectId: null, topicId: topic.id }],
    zones: [{ zoneId, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null }], bindings: [{ spaceId, zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  await spatial.retainDisplayLabels([{ target: { kind: 'agent-session', id: 'ordinary-agent' }, value: ordinaryName ?? topic.title }])
  const configurationPath = join(original.root, 'mote-config.json'), directory = join(original.root, 'connections'), socket = join(original.root, 'host.sock'), desktop = join(original.root, 'absent-desktop.sock')
  const config = { workspaces: [workspace], executors: { 'saved-chat': { label: 'Original chat', providerId: 'claude', command: process.execPath, args: [], env: {}, injectAgentMuxGuide: false } },
    appearance: { spaceObjectIcons: { [spaceId]: ref }, spaceObjectIconRevisions: { [spaceId]: 'original-avatar' } } }
  const save = () => writeFile(configurationPath, JSON.stringify(config))
  await save(); await writeFile(join(original.root, 'ordinary.jsonl'), native('ordinary-native', 'before-sharing', 'Earlier private text'))
  await mkdir(directory, { mode: 0o700 }); await original.client.dispose()
  const factory = connectors.createConnectionServices, opened: connectors.ConnectionServices[] = []
  vi.spyOn(connectors, 'createConnectionServices').mockImplementation(async options => { const services = await factory(options); opened.push(services); return services })
  const runs = new Map<string, ReturnType<typeof original.run>>(), sources = new Map<number, { id: string; path: string }>()
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function (this: core.AgentMuxClient) {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const key of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[key] = original.inner.kernel[key]
    })
    try { host = await startAgentMuxHost({ store: original.store, socketPath: socket, desktopSocketPath: desktop, connections: { directory, spatial, moteConfigurationPath: configurationPath }, mobileBuildDirectory: join(original.root, 'absent-mobile') }) }
    finally { connect.mockRestore() }
    const inner = host.client as unknown as typeof original.inner & { hookServer: Record<string, unknown>; ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown; providers: { get(id: string): core.AgentProvider } }
    inner.kernel.start = vi.fn(async () => {
      const number = runs.size + 1, runId = 'mote-run-' + number, pid = 400_000 + number, id = 'mote-native-' + number, path = join(original.root, id + '.jsonl')
      // A newly created private Session has no pre-existing assistant reply.
      await writeFile(path, '')
      const run = { ...original.run(runId), program: 'claude', pid, workspacePath: topic.physicalDirectoryPath! }
      runs.set(runId, run); sources.set(pid, { id, path }); return run
    })
    const status = original.inner.kernel.status as (id: string) => unknown
    inner.kernel.status = async (id: string) => runs.get(id) ?? status(id)
    inner.hookServer.isRunning = () => true
    inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
    inner.ensureManagedHooks = async () => {}; inner.ensureTerminalHandshakeOrDegrade = async (session: core.AgentMuxAgentSession) => session
    vi.spyOn(host.client, 'probeAgent').mockImplementation(async id => ({ providerId: id, executable: id, installed: true, capabilities: new core.AgentProviderRegistry().get(id).catalog.capabilities }))
    const provider = inner.providers.get('claude') as unknown as { discoverNativeSession(context: { processId: number }): Promise<unknown> }
    vi.spyOn(provider, 'discoverNativeSession').mockImplementation(async ({ processId }) => {
      const source = sources.get(processId)
      return source ? { handle: { kind: 'provider', providerId: 'claude', sessionId: source.id, transcriptPath: source.path }, assertCurrent: async () => {} } : null
    })
  }
  const stop = async () => { const previous = host; host = undefined; await previous?.dispose() }; cleanup.push(stop)
  await start()
  const rpc = async () => { const client = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } }); cleanup.push(() => client.dispose()); return client }
  const client = await rpc(), owner = (await client.call('runtime.owner.identity', {})).owner
  const credential = await client.call('connection.credential.store', { operationId: 'speaker-secret', secret: 'synthetic-speaker-secret' }, { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  await client.call('connection.configure', { operationId: 'speaker-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  await client.call('space.mote.chat.configure', { operationId: 'speaker-chat', target, expectedRevision: null, expectedConnectionRevision: 1,
    values: { enabled: true, connection: { connectionId: feishuConfig.connectionId, application: feishuConfig.application }, conversationIdleMs: 60_000, strangerMessageLimit: 0 } })
  const service = () => opened.at(-1)!
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
  await sdk.receive(feishuPayload({ chat_type: 'p2p', chat_id: 'original-private-room', mentions: [], content: JSON.stringify({ text: 'Original creator starts this Mote conversation.' }) }))
  let moteBinding!: import('@agentmux/core/connections').RoomBinding
  await vi.waitFor(async () => {
    const bindings = await client.call('connection.binding.ls', { connectionId: feishuConfig.connectionId })
    moteBinding = bindings.bindings.find(binding => binding.externalConversationId === 'original-private-room')!
    expect(moteBinding?.state).toBe('active')
  }, { timeout: 10_000 })
  try { await vi.waitFor(async () => {
    const page = await service().ingress!.list({ connectionId: feishuConfig.connectionId })
    const intake = page.ingresses.find(record => record.externalMessageId === 'platform-message' && record.externalConversationId === 'original-private-room')
    expect(intake?.input).toBeDefined()
    const originalReceipt = intake && await service().ingress!.inspect({ ingressId: intake.ingressId })
    expect(originalReceipt?.inputReceipt?.status).toBe('terminal-confirmed')
  }, { timeout: 4000 }) }
  catch (error) {
    if (process.env.STATIC_AVATAR_DIAG) await writeFile(process.env.STATIC_AVATAR_DIAG,
      JSON.stringify(await client.call('space.mote.chat.diagnose', { target }), null, 2) + '\n')
    throw error
  }
  expect(original.inner.kernel.input).toHaveBeenCalledTimes(2)
  const ordinary = await client.call('connection.bind', { operationId: 'speaker-ordinary-bind', bindingId: 'speaker-ordinary-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'ordinary-agent', externalConversationId: 'ordinary-room', expectedSource: { providerId: 'claude', nativeSessionId: 'ordinary-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  expect(ordinary.state).toBe('applied'); if (ordinary.state !== 'applied') throw Error('Original ordinary Binding required')
  const reply = async (binding: import('@agentmux/core/connections').RoomBinding, id: string, text: string) => {
    const session = await host!.client.readAgentSession(binding.agentSessionId), source = session!.nativeHandle!
    if (source.kind !== 'provider' || !source.transcriptPath) throw Error('Exact native source required')
    await appendFile(source.transcriptPath, native(source.sessionId, id, text)); service().publication!.refresh()
    await vi.waitFor(() => expect(operations(binding).some(operation => operation.payload.kind === 'speech' && operation.payload.text === text)).toBe(true))
    if (process.env.GROUP_SPEAKER_CARD_FACTS) await appendFile(process.env.GROUP_SPEAKER_CARD_FACTS, JSON.stringify({ input: id, operations: operations(binding).map(operation => ({
      operationId: operation.operationId, payload: operation.payload, speaker: operation.speaker, avatarUploads: operation.avatarUploads, avatarSource: operation.avatarSource, state: operation.state
    })) }) + '\n')
  }
  const operations = (binding = moteBinding) => service().publication!.store.list(binding).filter(operation => operation.payload.kind !== 'binding-lifecycle')
  return { original, remote, topic, topics, workspace, png, ref, config, save, target, spatial, client, rpc, credential, service, moteBinding, ordinary: ordinary.binding, operations, reply, start, stop, socket, desktop, current: () => host! }
}

it('default Host freezes exact Mote and ordinary speakers, reuses the original confirmed avatar and keeps prepared cards across reopen', async () => {
  const f = await fixture(), firstBody = '[message · Original conversation · agent]\nThis authored prefix is original text.'
  let releaseUpload!: () => void
  const upload = new Promise<void>(resolve => { releaseUpload = resolve }); f.remote.controls.beforeUpload = () => upload
  await f.reply(f.moteBinding, 'speaker-first', firstBody)
  await vi.waitFor(() => expect(f.operations().at(-1)?.state).toBe('confirmed'))
  expect(f.operations().at(-1)?.avatarUploads).toEqual([{ state: 'dispatching' }])
  const originalWire = f.operations().at(-1)!.prepared
  releaseUpload(); f.remote.controls.beforeUpload = undefined
  await vi.waitFor(() => expect(f.operations().at(-1)?.avatarUploads?.at(-1)?.state).toBe('confirmed'))
  const first = f.operations()[0]!
  expect(first.prepared).toEqual(originalWire)
  expect(first.speaker).toMatchObject({ kind: 'agent', name: f.topic.title, reference: { hostId: 'local', agentSessionId: f.moteBinding.agentSessionId }, mote: f.target,
    avatar: { target: { objectKey: f.target.spaceId }, observation: 'available' } })
  expect(f.remote.uploads).toEqual([f.png]); expect(first.payload).toMatchObject({ kind: 'speech', text: firstBody })
  expect(JSON.parse(JSON.parse(first.prepared!.request.body!).content).body.elements.find((element: { tag: string }) => element.tag === 'markdown').content).toBe(firstBody)
  await f.reply(f.moteBinding, 'speaker-second', 'Second original Mote reply')
  await vi.waitFor(() => expect(f.operations()).toHaveLength(2)); await vi.waitFor(() => expect(f.operations().every(operation => operation.state === 'confirmed')).toBe(true))
  const second = f.operations()[1]!
  expect(second.avatarUploads).toBeUndefined(); expect(second.avatarSource).toEqual({ operationId: first.operationId, attempt: 1, imageKey: 'original-image-key-1' })
  expect(second.speaker?.avatar?.image).toBeUndefined(); expect(f.service().publication!.store.inspect(first.operationId)?.speaker?.avatar?.image?.dataBase64).toBe(f.png.toString('base64'))
  const card = JSON.parse(JSON.parse(second.prepared!.request.body!).content)
  expect(card.header).toBeUndefined(); expect(card.body.elements[0]).toMatchObject({ text: { tag: 'plain_text', content: f.topic.title + ' · Agent' }, icon: { img_key: 'original-image-key-1' } })
  expect(card.config.summary.content).not.toContain('Agent progress')
  expect(card.config.summary.content).toContain('Second original Mote reply')
  if (process.env.PUBLICATION_SPEAKER_PREVIEW) {
    await mkdir(process.env.PUBLICATION_SPEAKER_PREVIEW, { recursive: true })
    await writeFile(join(process.env.PUBLICATION_SPEAKER_PREVIEW, 'original-card.json'), JSON.stringify(card, null, 2) + '\n')
    await writeFile(join(process.env.PUBLICATION_SPEAKER_PREVIEW, 'original-avatar.png'), f.png)
  }
  await f.reply(f.ordinary, 'speaker-ordinary', 'Ordinary exact Session with the same display name')
  await vi.waitFor(() => expect(f.operations(f.ordinary).at(-1)?.state).toBe('confirmed'))
  const ordinary = f.operations(f.ordinary).at(-1)!
  expect(ordinary.speaker).toMatchObject({ kind: 'agent', name: f.topic.title, reference: { agentSessionId: 'ordinary-agent' }, avatar: { observation: 'available', image: { width: 64, height: 64 } } })
  expect(ordinary.speaker?.mote).toBeUndefined(); expect(ordinary.speaker?.avatar?.target).toBeUndefined()
  await vi.waitFor(() => expect(f.remote.uploads).toHaveLength(2))
  const publicReceipt = await f.client.call('connection.delivery.inspect', { operationId: second.operationId })
  for (const hidden of [f.png.toString('base64'), 'original-image-key-1']) expect(JSON.stringify(publicReceipt)).not.toContain(hidden)
  for (const hidden of ['speaker', 'avatarSource', 'avatarUploads']) expect(Object.hasOwn(publicReceipt.delivery!, hidden)).toBe(false)
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.socket, 'connection', 'delivery', 'inspect', '--operation-id', second.operationId], objectCliEnvironment(f.original.root))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(publicReceipt)
  const before = f.operations(), count = f.remote.calls.filter(call => call.method === 'POST').length
  await f.client.dispose(); await f.stop(); await f.start()
  expect(f.operations()).toEqual(before)
  await f.reply(f.moteBinding, 'speaker-after-reopen', 'Next original reply after reopen')
  await vi.waitFor(() => expect(f.operations()).toHaveLength(3)); await vi.waitFor(() => expect(f.operations().at(-1)?.state).toBe('confirmed'))
  expect(f.remote.uploads).toHaveLength(2); expect(f.remote.calls.filter(call => call.method === 'POST')).toHaveLength(count + 1)
  expect(f.service().publication!.store.inspect(first.operationId)).toEqual(first)
  const renamed = await f.topics.renameTitle(f.workspace, f.topic.id, 'Exact changed Mote')
  const changedPng = imagePng(256, 256, [71, 103, 183]), changedRef = await saveObjectAvatarFile(renamed.physicalDirectoryPath!, changedPng)
  f.config.appearance.spaceObjectIcons[f.target.spaceId] = changedRef
  f.config.appearance.spaceObjectIconRevisions[f.target.spaceId] = 'changed-avatar'
  await f.save(); await f.reply(f.moteBinding, 'speaker-changed', 'Only the next operation observes the changed identity')
  await vi.waitFor(() => expect(f.operations()).toHaveLength(4))
  await vi.waitFor(() => expect(f.operations().at(-1)?.state).toBe('confirmed'))
  await vi.waitFor(() => expect(f.operations().at(-1)?.avatarUploads?.at(-1)?.state).toBe('confirmed'))
  const changedAvatar = await (await f.rpc()).call('space.mote.avatar.read', { target: { workspaceId: f.workspace.id, topicId: f.topic.id, objectKey: f.target.spaceId } })
  expect(f.operations().at(-1)?.speaker).toMatchObject({ name: renamed.title, avatar: { revision: changedAvatar.revision } })
  expect(changedAvatar.revision).not.toBe(first.speaker!.avatar!.revision)
  expect(f.remote.uploads).toHaveLength(3); expect(f.remote.uploads[0]).toEqual(f.png); expect(f.remote.uploads[2]).toEqual(changedPng)
  expect(f.service().publication!.store.inspect(first.operationId)).toEqual(first)
  // A distinct application namespace on the same Host must make its own original upload claim.
  const rpc = await f.rpc(), config = { ...feishuConfig, connectionId: 'speaker-other-application', application: { ...feishuConfig.application, domain: 'open.larksuite.com' }, credentialRef: f.credential.credentialRef }
  await rpc.call('connection.configure', { operationId: 'speaker-other-configure', expectedRevision: null, connection: config })
  const session = await f.current().client.readAgentSession(f.moteBinding.agentSessionId), source = session!.nativeHandle!
  if (source.kind !== 'provider') throw Error('Original native source required')
  const bound = await rpc.call('connection.bind', { operationId: 'speaker-other-bind', bindingId: 'speaker-other-binding', connectionId: config.connectionId, expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: f.moteBinding.agentSessionId, externalConversationId: 'other-application-room', expectedSource: { providerId: source.providerId, nativeSessionId: source.sessionId }, scope: { ...f.moteBinding.scope, publication: 'future-shared-conversation' } })
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Exact other application Binding required')
  await f.reply(bound.binding, 'speaker-other-application', 'The other application owns its avatar effect')
  await vi.waitFor(() => expect(f.operations(bound.binding).at(-1)?.state).toBe('confirmed'))
  await vi.waitFor(() => expect(f.operations(bound.binding).at(-1)?.avatarUploads?.at(-1)?.state).toBe('confirmed'))
  expect(f.operations(bound.binding).at(-1)?.avatarSource).toBeUndefined(); expect(f.remote.uploads).toHaveLength(4)
  expect(f.remote.uploads.slice(2)).toEqual([changedPng, changedPng])
  await expect(stat(f.desktop)).rejects.toMatchObject({ code: 'ENOENT' })
  // The two original creator input phases are distinct from these read/publication operations.
  expect(f.original.inner.kernel.input).toHaveBeenCalledTimes(2); expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 40_000)

it('default independent Host publishes the original built-in Mote portrait and keeps its exact upload and card across reopen', async () => {
  const f = await fixture('Same visible name')
  Object.assign(f.config.appearance.spaceObjectIcons, { [f.target.spaceId]: null }); await f.save()
  const expected = await rasterizeStaticAvatar(savedMoteAvatarDrawing(null, f.config.appearance)!, 256)
  const png = Buffer.from(expected.dataUrl.slice('data:image/png;base64,'.length), 'base64')
  await f.reply(f.moteBinding, 'static-mote-first', 'First complete original Mote reply')
  await vi.waitFor(() => expect(f.operations().at(-1)?.state).toBe('confirmed'))
  expect(f.operations().at(-1)?.speaker?.avatar).toMatchObject({ observation: 'available', image: { width: 256, height: 256 } })
  await vi.waitFor(() => expect(f.operations().at(-1)?.avatarUploads?.at(-1)?.state).toBe('confirmed'))
  const first = f.operations().at(-1)!, firstWire = structuredClone(first.prepared)
  expect(first.speaker).toMatchObject({ mote: f.target, avatar: { observation: 'available', image: { width: 256, height: 256 } } })
  expect(f.remote.uploads).toEqual([png]); expect(png).not.toEqual(f.png)
  await f.reply(f.moteBinding, 'static-mote-second', 'Second complete original Mote reply')
  await vi.waitFor(() => expect(f.operations().at(-1)?.state).toBe('confirmed'))
  const second = f.operations().at(-1)!, card = JSON.parse(JSON.parse(second.prepared!.request.body!).content)
  expect(second.avatarSource).toEqual({ operationId: first.operationId, attempt: 1, imageKey: 'original-image-key-1' })
  expect(card.body.elements[0]).toMatchObject({ text: { content: f.topic.title + ' · Agent' }, icon: { tag: 'custom_icon', img_key: 'original-image-key-1', size: '16px 16px' } })
  const retained = structuredClone(second)
  await f.stop(); await f.start()
  expect(f.service().publication!.store.inspect(first.operationId)?.prepared).toEqual(firstWire)
  expect(f.service().publication!.store.inspect(second.operationId)).toEqual(retained)
  expect(f.remote.uploads).toEqual([png]); await expect(stat(f.desktop)).rejects.toMatchObject({ code: 'ENOENT' })
  if (process.env.STATIC_AVATAR_PREVIEW) {
    await writeFile(join(process.env.STATIC_AVATAR_PREVIEW, 'native-card.json'), JSON.stringify(card, null, 2) + '\n')
    await writeFile(join(process.env.STATIC_AVATAR_PREVIEW, 'mote-avatar.png'), png)
  }
}, 40_000)

it('default Host carries the authenticated A2A sender own saved Executor portrait through the original outbox and native card', async () => {
  const f = await fixture('Equal visible name', ['peer-agent'])
  Object.assign(f.config.executors, {
    'peer-agent-executor': { label: 'Equal visible name', providerId: 'claude', avatar: { tint: '#67b9ef', badge: 'shield' } },
    claude: { label: 'Equal visible name', providerId: 'claude', avatar: { tint: '#ed7777', badge: 'bolt' } }
  }); await f.save()
  await f.spatial.retainDisplayLabels([{ target: { kind: 'agent-session', id: 'peer-agent' }, value: 'Equal visible name' }])
  const expectedSvg = agentAvatarSvg('claude', { tint: '#67b9ef', badge: 'shield' }, () => { throw Error('Original vector artwork selected an unexpected raster') })
  const expectedRevision = 'sha256:' + createHash('sha256').update(expectedSvg).digest('hex')
  const image = await rasterizeStaticAvatar(expectedSvg, 64), png = Buffer.from(image.dataUrl.split(',')[1]!, 'base64')
  const sender = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socket }, credentials: { agentSessionId: 'peer-agent', capability: f.original.capability } })
  cleanup.push(() => sender.dispose())
  vi.spyOn(f.current().client.providers.get('claude'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const send = async (id: string, text: string) => {
    await sender.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'ordinary-agent' }, operationId: 'send-' + id, messageId: id, text })
    await f.current().client.notifyMessages({ messageIds: [id], operationId: 'notify-' + id }); f.service().publication!.refresh()
    await vi.waitFor(() => expect(f.operations(f.ordinary).some(operation => operation.originalMessage?.messageId === id && operation.state === 'confirmed'),
      JSON.stringify(f.operations(f.ordinary).map(operation => ({ messageId: operation.originalMessage?.messageId, state: operation.state })))).toBe(true), { timeout: 4000 })
    return f.operations(f.ordinary).find(operation => operation.originalMessage?.messageId === id)!
  }
  const first = await send('peer-first', 'Original peer message, with its exact original author.')
  expect(first.speaker).toMatchObject({ kind: 'agent', name: 'Equal visible name', reference: { hostId: 'local', agentSessionId: 'peer-agent' },
    avatar: { observation: 'available', revision: expectedRevision, image: { width: 64, height: 64 } } })
  expect(first.speaker?.mote).toBeUndefined(); expect(first.speaker?.avatar?.target).toBeUndefined()
  await vi.waitFor(() => expect(f.service().publication!.store.inspect(first.operationId)?.avatarUploads?.at(-1)?.state).toBe('confirmed'))
  expect(f.remote.uploads).toEqual([png]); expect(png).not.toEqual(f.png)
  const second = await send('peer-second', 'Next complete peer message')
  expect(second.avatarSource).toEqual({ operationId: first.operationId, attempt: 1, imageKey: 'original-image-key-1' })
  const card = JSON.parse(JSON.parse(second.prepared!.request.body!).content)
  expect(card.body.elements[0]).toMatchObject({ text: { content: 'Equal visible name · Agent' }, icon: { tag: 'custom_icon', img_key: 'original-image-key-1' } })
  expect(card.body.elements[1].content).toBe('Next complete peer message')
  if (process.env.STATIC_AVATAR_PREVIEW) {
    await writeFile(join(process.env.STATIC_AVATAR_PREVIEW, 'peer-native-card.json'), JSON.stringify(card, null, 2) + '\n')
    await writeFile(join(process.env.STATIC_AVATAR_PREVIEW, 'peer-avatar.png'), png)
  }
}, 40_000)

it('optional unknown avatar never holds body delivery or reuploads the same asset and other authors stay distinct', async () => {
  const f = await fixture(); f.remote.controls.missingUploadKey = true
  await f.reply(f.moteBinding, 'speaker-unknown-avatar', 'Original body survives an unconfirmed optional upload')
  await vi.waitFor(() => expect(f.operations().at(-1)?.state).toBe('confirmed'))
  await vi.waitFor(() => expect(f.operations().at(-1)?.avatarUploads).toEqual([{ state: 'unknown' }]))
  const first = f.operations()[0]!
  await f.reply(f.moteBinding, 'speaker-after-unknown', 'Independent original body after the same unknown avatar')
  await vi.waitFor(() => expect(f.operations()).toHaveLength(2)); await vi.waitFor(() => expect(f.operations().at(-1)?.state).toBe('confirmed'))
  expect(f.remote.uploads).toHaveLength(1); expect(f.operations()[1]!.avatarSource).toEqual({ operationId: first.operationId, attempt: 1 })
  expect(f.service().publication!.store.inspect(first.operationId)).toEqual(first)
  await f.client.dispose(); await f.stop(); await f.start()
  expect(f.service().publication!.store.inspect(first.operationId)).toEqual(first)
  await f.reply(f.moteBinding, 'speaker-unknown-after-reopen', 'Body continues after reopening the original unknown avatar')
  await vi.waitFor(() => expect(f.operations()).toHaveLength(3)); await vi.waitFor(() => expect(f.operations().at(-1)?.state).toBe('confirmed'))
  expect(f.remote.uploads).toHaveLength(1); expect(f.operations().at(-1)?.avatarSource).toEqual({ operationId: first.operationId, attempt: 1 })
  const now = Date.now(), humanBody = 'Original public App user content stays human'
  await f.original.store.applyTimelineMutation({ type: 'append', agentSessionId: 'ordinary-agent', item: { id: 'speaker-human', agentSessionId: 'ordinary-agent', kind: 'user_message',
    source: 'user', status: 'complete', title: 'Original App input', content: humanBody, authorHuman: true, publicContent: 'confirmed', createdAt: now, updatedAt: now } })
  f.service().publication!.refresh()
  await vi.waitFor(() => expect(f.operations(f.ordinary).at(-1)?.state).toBe('confirmed'))
  const human = f.operations(f.ordinary).at(-1)!
  expect(human.speaker).toEqual({ kind: 'human' }); expect(human.payload).toMatchObject({ kind: 'speech', text: humanBody })
  const humanCard = JSON.parse(JSON.parse(human.prepared!.request.body!).content)
  expect(humanCard.body.elements[0].text.content).toBe('User · via amux'); expect(JSON.stringify(humanCard)).toContain(humanBody)
  const page = await f.current().client.readAgentConversation({ hostId: 'local', agentSessionId: 'ordinary-agent' })
  const consumed = core.consumeConversationWindowPage(page)
  expect(consumed.kind).toBe('complete'); if (consumed.kind !== 'complete') throw Error('Exact original conversation frame required')
  const unit = consumed.snapshot.units.find(value => value.event.author.kind === 'human')!
  expect(unit).toBeTruthy()
  const reference = { hostId: 'local', agentSessionId: 'ordinary-agent' }
  expect(publicationSpeaker({ ...unit, event: { ...unit.event, author: { kind: 'unknown' } }, records: [] }, reference)).toEqual({ kind: 'unknown' })
  const assistant = structuredClone(unit.records[0]!)
  if (assistant.original.kind !== 'captured') throw Error('Original captured record required')
  const { authorHuman: _human, ...original } = assistant.original.item
  assistant.original.item = { ...original, authorAgentSessionId: 'ordinary-agent' }
  expect(publicationSpeaker({ ...unit, event: { ...unit.event, author: { kind: 'unknown' } }, records: [unit.records[0]!, assistant] }, reference)).toEqual({ kind: 'mixed' })
  const operation = f.operations()[1]!, payload = { kind: 'speech' as const, text: 'Authored **body** stays byte exact' }
  for (const kind of ['human', 'external', 'mixed', 'unknown'] as const) {
    const prepared = new FeishuPublicationAdapter(new FeishuAdapter()).prepare({ ...operation, speaker: { kind }, avatarSource: undefined, payload } as never)
    const card = JSON.parse(JSON.parse(prepared.request.body!).content)
    expect(card.body.elements[0].text.content).not.toContain('Agent'); expect(JSON.stringify(card)).toContain(payload.text)
  }
  const discord = prepareDiscordPublication({ ...operation, mapping: undefined, target: { ...operation.target, externalConversationId: '100000000000000001' }, speaker: { kind: 'agent', name: '**Name**\n<@100000000000000002>' }, payload } as never)
  expect(discord.request.body).toContain('\\\\*\\\\*Name'); expect(discord.request.body).toContain('Authored **body** stays byte exact')
  expect(JSON.parse(discord.request.body!).allowed_mentions).toEqual({ parse: [] })
}, 35_000)

it('group portraits follow exact spatial relationships while unaffiliated or conflicting Motes retain their own Agent artwork', async () => {
  const f = await fixture('Original group author'), text = 'Complete group message from its exact original Agent'
  const artworkErrors: string[] = [], draw = staticArtwork.savedAgentAvatarDrawing, raster = staticArtwork.rasterizeStaticAvatar
  vi.spyOn(staticArtwork, 'savedAgentAvatarDrawing').mockImplementation((...args) => { try { return draw(...args) } catch (error) { artworkErrors.push(String(error)); throw error } })
  vi.spyOn(staticArtwork, 'rasterizeStaticAvatar').mockImplementation(async (...args) => { try { return await raster(...args) } catch (error) { artworkErrors.push(String(error)); throw error } })
  await f.reply(f.ordinary, 'group-without-affiliation', text)
  await vi.waitFor(() => expect(f.operations(f.ordinary).at(-1)?.state).toBe('confirmed'))
  const unlinked = f.operations(f.ordinary).at(-1)!
  expect(unlinked.speaker).toMatchObject({ name: 'Original group author', reference: { agentSessionId: 'ordinary-agent' } })
  expect(unlinked.speaker?.avatar).toMatchObject({ observation: 'available', image: { width: 64, height: 64 } })
  expect(unlinked.speaker?.avatar?.target).toBeUndefined()
  await vi.waitFor(() => expect(f.operations(f.ordinary).at(-1)?.avatarUploads?.at(-1)?.state).toBe('confirmed'))
  expect(f.remote.uploads).toHaveLength(1)
  const original = await f.spatial.read(); if (!original) throw Error('Original fixture spatial graph required')
  original.graph.tabs = [{ tabId: 'speaker-group-tab', workspaceId: f.workspace.id, zoneId: f.target.zoneId, name: null, regionIds: ['speaker-group-region'] }]
  original.graph.regions = [{ tabId: 'speaker-group-tab', regionId: 'speaker-group-region', kind: 'agent', agentSessionId: 'ordinary-agent', runId: null,
    execution: { hostId: 'local', cwd: f.original.root } }]
  original.graph.layouts = { [f.workspace.id]: createWorkspaceLayout('speaker-group-layout', ['speaker-group-tab']) }
  original.graph.tabLayouts = { 'speaker-group-tab': { root: { type: 'leaf', regionId: 'speaker-group-region' }, activeRegionId: 'speaker-group-region' } }
  await f.spatial.commit({ expectedRevision: original.revision, graph: original.graph })
  await f.reply(f.ordinary, 'group-original-avatar', 'The current Mote portrait does not change the Session author or execution')
  await vi.waitFor(() => expect(f.operations(f.ordinary).at(-1)?.state).toBe('confirmed'))
  await vi.waitFor(() => expect(f.operations(f.ordinary).at(-1)?.avatarUploads?.at(-1)?.state).toBe('confirmed'))
  const first = f.operations(f.ordinary).at(-1)!
  expect(first.speaker).toMatchObject({ name: 'Original group author', mote: f.target, avatar: { target: { objectKey: f.target.spaceId }, observation: 'available' } })
  expect((await f.current().client.readAgentSession('ordinary-agent'))?.workspacePath).toBe(f.original.root)
  expect(f.remote.uploads).toHaveLength(2); expect(f.remote.uploads[1]).toEqual(f.png)
  const branch = await f.spatial.read(); if (!branch) throw Error('Original fixture graph required')
  branch.graph.zones.push({ zoneId: 'speaker-mote-branch', workspaceId: f.workspace.id, kind: 'worktree', hostId: 'local', directoryPath: join(f.original.root, 'branch'), branch: 'speaker-branch' })
  branch.graph.bindings.push({ spaceId: f.target.spaceId, zoneId: 'speaker-mote-branch' })
  branch.graph.tabs.find(tab => tab.tabId === 'speaker-group-tab')!.zoneId = 'speaker-mote-branch'
  await f.spatial.commit({ expectedRevision: branch.revision, graph: branch.graph })
  await f.reply(f.ordinary, 'group-reused-avatar', 'The next group card reuses the exact confirmed portrait')
  await vi.waitFor(() => expect(f.operations(f.ordinary).at(-1)?.payload).toMatchObject({ kind: 'speech', text: 'The next group card reuses the exact confirmed portrait' }))
  await vi.waitFor(() => expect(f.operations(f.ordinary).at(-1)?.state).toBe('confirmed'))
  const visible = f.operations(f.ordinary).at(-1)!, card = JSON.parse(JSON.parse(visible.prepared!.request.body!).content)
  expect(card.body.elements[0]).toMatchObject({ text: { content: 'Original group author · Agent' }, icon: { img_key: 'original-image-key-2' } })
  expect(visible.avatarSource).toMatchObject({ operationId: first.operationId, imageKey: 'original-image-key-2' })
  const retained = structuredClone(visible)
  const other = await f.topics.ensureMote(f.workspace, 'view:other-group-author'), otherSpace = directoryIdentity('local', other.identityDirectoryPath!), otherZone = homeZoneId(otherSpace)
  const conflict = await f.spatial.read(); if (!conflict) throw Error('Original fixture graph required')
  conflict.graph.spaces.push({ spaceId: otherSpace, kind: 'mote', name: other.title, hostId: 'local', directoryPath: other.physicalDirectoryPath!, projectId: null, topicId: other.id })
  conflict.graph.zones.push({ zoneId: otherZone, workspaceId: f.workspace.id, kind: 'home', hostId: 'local', directoryPath: other.physicalDirectoryPath!, branch: null })
  conflict.graph.bindings.push({ spaceId: otherSpace, zoneId: otherZone })
  conflict.graph.tabs.push({ tabId: 'conflicting-speaker-tab', zoneId: otherZone, workspaceId: f.workspace.id, name: null, regionIds: ['conflicting-speaker-region'] })
  conflict.graph.regions.push({ tabId: 'conflicting-speaker-tab', regionId: 'conflicting-speaker-region', kind: 'agent', agentSessionId: 'ordinary-agent', runId: null,
    execution: { hostId: 'local', cwd: f.original.root } })
  conflict.graph.layouts[f.workspace.id] = createWorkspaceLayout('speaker-group-layout', ['speaker-group-tab', 'conflicting-speaker-tab'])
  conflict.graph.tabLayouts['conflicting-speaker-tab'] = { root: { type: 'leaf', regionId: 'conflicting-speaker-region' }, activeRegionId: 'conflicting-speaker-region' }
  await f.spatial.commit({ expectedRevision: conflict.revision, graph: conflict.graph })
  await f.reply(f.ordinary, 'group-conflicting-avatar', 'Conflicting optional portraits do not hold the complete body')
  await vi.waitFor(() => expect(f.operations(f.ordinary).at(-1)?.payload).toMatchObject({ kind: 'speech', text: 'Conflicting optional portraits do not hold the complete body' }))
  await vi.waitFor(() => expect(f.operations(f.ordinary).at(-1)?.state).toBe('confirmed'))
  const ambiguous = f.operations(f.ordinary).at(-1)!, plain = JSON.parse(JSON.parse(ambiguous.prepared!.request.body!).content)
  expect(ambiguous.speaker?.avatar, artworkErrors.join('\n')).toMatchObject({ observation: 'available' }); expect(ambiguous.speaker?.mote).toBeUndefined()
  expect(ambiguous.speaker?.avatar?.target).toBeUndefined()
  expect(ambiguous.avatarSource).toMatchObject({ operationId: unlinked.operationId, imageKey: 'original-image-key-1' })
  expect(plain.body.elements[0]).toMatchObject({ text: { content: 'Original group author · Agent' }, icon: { tag: 'custom_icon', img_key: 'original-image-key-1' } })
  expect(f.remote.uploads).toHaveLength(2); expect(f.service().publication!.store.inspect(visible.operationId)).toEqual(retained)
  expect(f.original.inner.kernel.input).toHaveBeenCalledTimes(2); expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 40_000)
