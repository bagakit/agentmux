import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { DefaultRestOptions } from '@discordjs/rest'
import type { RoomBinding } from '@agentmux/core/connections'
import * as core from '../../core/src/index.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { ChannelStorage } from '../src/channel-storage.js'
import { context } from './fixtures/room-binding.js'
import { botOpenId, feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { discordConfig, discordRoomId, discordTransport } from './fixtures/discord.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('one original session broadcasts public human and Agent speech to Feishu and Discord, relays each native origin once, and never echoes deliveries', async () => {
  const feishu = feishuSdkTransport(), feishuHttp = await feishuPublicationHttp(); cleanup.push(feishuHttp.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(feishuHttp.http.request)
  const discord = await discordTransport(); cleanup.push(discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: {
    kind: 'provider', providerId: 'claude', sessionId: 'original-native', transcriptPath: join(root, 'native.jsonl')
  } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl')
  const originalRun = f.client.agentSession('original-agent').run
  const native = (id: string, text: string) => JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: id,
    message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  await writeFile(transcript, native('before-sharing', 'Earlier unshared Agent reply'))
  vi.spyOn(f.client.providers.get('claude'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {}
  } })
  const services = await createConnectionServices({ directory: join(f.root, 'connections'), encryption: {
    isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(value),
    decryptStringAsync: async value => ({ result: value.toString(), shouldReEncrypt: false })
  }, bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) },
  ingress: { core: host => host === 'local' ? f.client : undefined }, publication: createPublicationConversationPort(f.coreClients) })
  cleanup.push(() => services.close())
  const bindings: RoomBinding[] = []
  for (const config of [feishuConfig, discordConfig]) {
    const credential = await services.secrets.store({ operationId: config.adapterId + '-credential', secret: 'fixture-' + config.adapterId + '-credential' })
    await services.connections.configure({ operationId: config.adapterId + '-configure', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
    const binding = await services.connections.bindings!.bind({ operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding',
      connectionId: config.connectionId, expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent',
      regionAnchor: { regionId: 'region' }, externalConversationId: config.adapterId === 'feishu' ? 'original-room' : discordRoomId,
      expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' },
      scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, context)
    expect(binding.state).toBe('applied'); if (binding.state !== 'applied') throw Error('Original audience was not bound')
    bindings.push(binding.binding)
    await services.connections.bindings!.grant({ operationId: config.adapterId + '-grant', bindingId: binding.binding.bindingId,
      expectedBindingRevision: 1, grantId: config.adapterId + '-input-grant', expectedRevision: null,
      actor: { application: config.application, idType: config.adapterId === 'feishu' ? 'open_id' : 'snowflake', userId: config.adapterId === 'feishu' ? 'original-external-user' : '400' },
      capabilities: ['input'], state: 'active' }, context)
  }
  await vi.waitFor(() => { expect(feishu.sockets).toHaveLength(1); expect(discord.sessions).toHaveLength(1) })
  const posts = () => ({ feishu: feishuHttp.messageCalls().filter(call => call.method === 'POST').map(call => call.body),
    discord: discord.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages').map(call => call.body) })
  const copies = (text: string) => Object.fromEntries(Object.entries(posts()).map(([audience, bodies]) => [audience, bodies.filter(body => body.includes(text)).length]))
  const settled = async () => vi.waitFor(() => {
    services.publication!.refresh()
    for (const binding of bindings) expect(services.publication!.store.list(binding).every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 10_000 })

  // This is the existing trusted Core public writer, not an unqualified ordinary Terminal transcript.
  const local = 'Exact local public human 中文🙂', answer = 'Original shared Agent answer'
  await f.client.submitAgentPrompt({ agentSessionId: 'original-agent', ...core.agentPromptCondition((await f.client.readAgentSession('original-agent'))!),
    operationId: 'join-local-human', prompt: local, authorHuman: true, allowUncertainTurn: true, agentMuxNote: 'PRIVATE generated context' })
  expect((f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data).toContain('PRIVATE generated context')
  await appendFile(transcript, native('shared-answer', answer)); services.publication!.refresh()
  await vi.waitFor(() => { expect(copies(local)).toEqual({ feishu: 1, discord: 1 }); expect(copies(answer)).toEqual({ feishu: 1, discord: 1 }) }, { timeout: 10_000 })

  const feishuBody = 'Native Feishu origin 中文🙂', discordBody = 'Native Discord origin 中文🙂'
  const originalFeishu = feishuPayload({ message_id: 'join-feishu-message', content: JSON.stringify({ text: feishuBody }) })
  originalFeishu.header.event_id = 'join-feishu-event'
  await feishu.receive(originalFeishu)
  await vi.waitFor(() => expect(copies(feishuBody).discord).toBe(1), { timeout: 10_000 })
  const originalDiscord = discord.message('710', discordBody)
  await vi.waitFor(() => expect(copies(discordBody).feishu).toBe(1), { timeout: 10_000 })
  await settled()
  expect(copies(feishuBody)).toEqual({ feishu: 0, discord: 1 })
  expect(copies(discordBody)).toEqual({ feishu: 1, discord: 0 })

  // Redelivery has a new transport event but the same original platform message identity.
  const duplicateFeishu = structuredClone(originalFeishu); duplicateFeishu.header.event_id = 'join-feishu-redelivery'
  await feishu.receive(duplicateFeishu)
  const redeliverySequence = discord.emit('MESSAGE_CREATE', originalDiscord)
  const discordStorage = new ChannelStorage(services.database!).namespace(discordConfig)
  // The Discord fixture emits native own-bot MESSAGE_CREATE for every actual REST effect.
  // Replay the actual Feishu publication bodies as app messages through its pinned SDK too.
  for (const message of feishuHttp.records.values()) {
    const echo = feishuPayload({ message_id: message.message_id, message_type: message.msg_type,
      content: (message.body as { content: string }).content })
    echo.header.event_id = 'join-own-' + message.message_id
    echo.event.sender = { sender_type: 'app', sender_id: { open_id: botOpenId, user_id: 'own-bot' } }
    await feishu.receive(echo)
  }
  // Await the adapter's actual custody checkpoint, including preceding own-bot events.
  await vi.waitFor(() => {
    const cursor = discordStorage.get('gateway-session:0')
    expect(cursor?.value.kind).toBe('json')
    expect((cursor!.value as { kind: 'json'; value: { sequence: number } }).value.sequence).toBeGreaterThanOrEqual(redeliverySequence)
  })
  await settled()
  await vi.waitFor(async () => {
    const received = await Promise.all([feishuConfig, discordConfig].map(config => services.ingress!.list({ connectionId: config.connectionId })))
    expect(received.map(result => result.ingresses.length)).toEqual([1, 1])
    for (const record of received.flatMap(result => result.ingresses)) expect(record.input).toMatchObject({ agentSessionId: 'original-agent', expectedRun: originalRun })
  })
  const timeline = (await f.client.sessionTimeline('original-agent')).items
  expect(timeline.filter(item => item.authorExternal).map(item => item.content).sort()).toEqual([discordBody, feishuBody].sort())
  expect(timeline.find(item => item.content === local)).toMatchObject({ authorHuman: true, publicContent: 'confirmed' })
  expect(copies(local)).toEqual({ feishu: 1, discord: 1 }); expect(copies(answer)).toEqual({ feishu: 1, discord: 1 })
  expect(copies(feishuBody)).toEqual({ feishu: 0, discord: 1 }); expect(copies(discordBody)).toEqual({ feishu: 1, discord: 0 })
  expect(JSON.stringify(posts())).not.toContain('PRIVATE generated context'); expect(JSON.stringify(posts())).not.toContain('Earlier unshared Agent reply')
  expect((await f.client.readAgentSessions()).map(session => session.agentSessionId)).toEqual(['original-agent'])
  expect(f.client.agentSession('original-agent').run).toEqual(originalRun)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(3)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 30_000)
