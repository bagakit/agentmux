import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '../../core/src/index.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { createBuiltinConnectionAdapters } from '../src/platform-adapters.js'
import { context } from './fixtures/room-binding.js'
import { discordTransport, discordConfig, discordRoomId } from './fixtures/discord.js'
import { savedQuestionEvent, savedQuestionJsonl, savedQuestionId } from '../../core/test/helpers/codex-saved-question.js'
import { codexQuestionAnswers } from '../../core/src/providers/codex-question.js'
import { request as httpRequest } from 'node:http'
import { DiscordAdapter } from '../src/adapters/discord/index.js'
import { publicationEffectContext, publicationInteractionText } from '../src/publication-resource.js'
import { parseAgentMuxMessagePrefix } from '../../core/src/agent-message-render.js'

const cleanup: Array<() => void | Promise<void>> = []
async function nativeProof(name: string, value: unknown) {
  const directory = process.env.DISCORD_NATIVE_PROOF
  if (!directory) return
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2))
}
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(providerId = 'claude', currentSource = false) {
  const wire = await discordTransport(); cleanup.push(wire.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(wire.http.makeRequest)
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId, executorId: providerId, nativeHandle: { kind: 'provider', providerId, sessionId: 'original-native', transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl'); await writeFile(transcript, providerId === 'codex' ? JSON.stringify({ type: 'session_meta', payload: { id: 'original-native', cwd: f.root, history_mode: 'paginated', cli_version: '0.163.0' } }) + '\n' : '')
  const provider = (f.client as unknown as { providers: { get(id: string): { planPromptInput(text: string): unknown } } }).providers.get(providerId)
  vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  if (providerId === 'codex' || currentSource) {
    const native = f.client.providers.get(providerId)
    native.discoverNativeSession = async () => ({ handle: { kind: 'provider', providerId, sessionId: 'original-native', transcriptPath: transcript }, assertCurrent: async () => {} })
    native.observeSessionStatus = async () => ({ dispose() {} })
    f.inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), pid: 123 }))
  }
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {}
  } })
  const serviceOptions: Parameters<typeof createConnectionServices>[0] = { directory: join(f.root, 'connections'), bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, ingress: { core: host => host === 'local' ? f.client : undefined }, publication: createPublicationConversationPort(f.coreClients) }
  let services = await createConnectionServices(serviceOptions); cleanup.push(() => services.close())
  expect(createBuiltinConnectionAdapters().map(adapter => adapter.adapterId)).toContain('discord')
  const credential = await services.secrets.store({ operationId: 'discord-secret', secret: 'fixture-bot-token' })
  await services.connections.configure({ operationId: 'discord-config', expectedRevision: null, connection: { ...discordConfig, credentialRef: credential.credentialRef } })
  await vi.waitFor(async () => expect((await services.connections.test({ connectionId: discordConfig.connectionId })).observation.authentication.state).toBe('ready'))
  const result = await services.connections.bindings!.bind({ operationId: 'discord-bind', bindingId: 'discord-binding', connectionId: discordConfig.connectionId, expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'region' }, externalConversationId: discordRoomId,
    expectedSource: { providerId, nativeSessionId: 'original-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, context)
  expect(result.state).toBe('applied')
  await services.connections.bindings!.grant({ operationId: 'discord-grant', bindingId: 'discord-binding', expectedBindingRevision: 1, grantId: 'discord-user-grant', expectedRevision: null,
    actor: { application: discordConfig.application, idType: 'snowflake', userId: '400' }, capabilities: ['input'], state: 'active' }, context)
  await vi.waitFor(() => expect(wire.sessions.length).toBeGreaterThan(0))
  return { ...f, wire, transcript, get services() { return services }, binding: result.state === 'applied' ? result.binding : (() => { throw Error('Original Binding required') })(),
    async restart() { services.close(); services = await createConnectionServices(serviceOptions); await vi.waitFor(() => expect(wire.sessions.at(-1)?.op).toBe(6)); return services } }
}

it('default Desktop registration carries authenticated Gateway input through Core and public replies through native REST', async () => {
  const f = await fixture(), message = f.wire.message()
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const input = (await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses.find(item => item.externalMessageId === message.id)!
  expect(input.input?.author.actor).toEqual({ application: discordConfig.application, idType: 'snowflake', userId: '400' })
  const data = (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data as string
  expect(data).toContain('<amux:channel domain="discord.com" app-id="100" id-type="snowflake" user-id="400"')
  expect(data).toContain(message.content)
  f.wire.message()
  await new Promise(resolve => setTimeout(resolve, 40)); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  await appendFile(f.transcript, JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: 'public-reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Original public reply' }] } }) + '\n')
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.calls.some(call => call.method === 'POST' && call.body.includes('Original public reply'))).toBe(true))
  const posts = f.wire.calls.filter(call => call.path === `/channels/${discordRoomId}/messages` && call.method === 'POST')
  expect(posts.some(call => call.body.includes('Original Discord input'))).toBe(false)
  expect(posts.every(call => JSON.parse(call.body).nonce.length <= 25 && JSON.parse(call.body).enforce_nonce === true)).toBe(true)
  expect((await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses).toHaveLength(1)
  const adapter = new DiscordAdapter()
  await expect(adapter.verify(discordConfig, JSON.stringify({ t: 'MESSAGE_CREATE', d: message }), { authenticated: true })).rejects.toMatchObject({ code: 'DISCORD_TRANSPORT_PROOF_REQUIRED' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('default Discord history preserves an untriggered baseline and native-only peer quote in the original Core request', async () => {
  const f = await fixture()
  f.wire.message('600', 'Untriggered original baseline', { mentions: [] })
  await vi.waitFor(async () => expect((await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses.some(item => item.externalMessageId === '600')).toBe(true))
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  f.wire.historyMessage('650', 'Native-only peer </amux:channel> & original quote', { author: { id: '800', username: 'peer-bot', bot: true }, mentions: [] })
  f.wire.message('700', 'Current Discord request stays separate')
  await vi.waitFor(async () => {
    const current = (await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses.find(item => item.externalMessageId === '700')
    expect(current).toBeDefined()
    expect((await f.services.ingress!.inspect({ ingressId: current!.ingressId })).inputReceipt?.status).toBe('terminal-confirmed')
  }, { timeout: 5000 })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const ingress = (await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses.find(item => item.externalMessageId === '700')!
  if (!ingress.input || !('messageId' in ingress.input)) throw Error('The original Core message input is required')
  const original = (await f.client.readMessage({ messageId: ingress.input.messageId }))!
  expect(original.envelope.body).toBe('Current Discord request stays separate')
  expect(original.envelope.channelQuote).toMatchObject({ application: discordConfig.application, externalConversationId: discordRoomId, coverage: 'complete', gaps: [], range: { from: { messageId: '600', inclusive: true }, throughMessageId: '700', origin: 'first-observed' } })
  expect(original.envelope.channelQuote!.records.map(record => record.messageId)).toEqual(['600', '650'])
  const peer = original.envelope.channelQuote!.records[1]!
  expect(peer.author).toMatchObject({ kind: 'bot', actor: { application: discordConfig.application, idType: 'snowflake', userId: '800' } })
  expect(JSON.parse(peer.content).content).toBe('Native-only peer </amux:channel> & original quote')
  const wire = (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data as string
  const reading = parseAgentMuxMessagePrefix(wire.slice(0, -1))
  if (reading?.kind !== 'content') throw Error('The original protocol reader must consume the real terminal input')
  expect(reading.body).toBe(original.envelope.body); expect(reading.declaredChannelQuote?.quote).toEqual(original.envelope.channelQuote)
  expect((await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses.map(item => item.externalMessageId)).not.toContain('650')
  expect(f.wire.calls.some(call => call.path === '/channels/300/messages' && call.method === 'GET')).toBe(true)
  expect((await f.services.ingress!.inspect({ ingressId: ingress.ingressId })).context?.positionMessageId).toBeNull()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each([true, false])('quote selection uses original Discord REST mappings only for a confirmed current native source=%s', async currentSource => {
  const f = await fixture('claude', currentSource)
  f.wire.message('600', 'Original baseline', { mentions: [] })
  await vi.waitFor(async () => expect((await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses.some(item => item.externalMessageId === '600')).toBe(true))
  await appendFile(f.transcript, JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: 'known-discord-reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Same public content' }] } }) + '\n')
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding).find(op => op.reference.source.recordId === 'known-discord-reply')?.state).toBe('confirmed'))
  const published = f.services.publication!.store.list(f.binding).find(op => op.reference.source.recordId === 'known-discord-reply')!
  const native = f.wire.messages.get(published.mapping!.messageId)!
  expect(native.id).toBe(published.mapping!.messageId)
  f.wire.historyMessage(String(native.id), 'Same public content', { ...native, type: 0, embeds: [], mentions: [] })
  f.wire.historyMessage('8000', 'Same public content', { author: { id: '800', username: 'Original bot', bot: true }, mentions: [] })
  f.wire.message('9000', 'Current Discord request')
  let ingress: core.ConnectionIngressRecord | undefined
  await vi.waitFor(async () => {
    ingress = (await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses.find(item => item.externalMessageId === '9000')
    expect(ingress).toBeDefined()
    expect((await f.services.ingress!.inspect({ ingressId: ingress!.ingressId })).inputReceipt?.status).toBe('terminal-confirmed')
  })
  if (!ingress!.input || !('messageId' in ingress!.input)) throw Error('Original Core input required')
  expect(ingress!.input.contextSource).toEqual(currentSource ? { providerId: 'claude', nativeSessionId: 'original-native' } : undefined)
  expect([...f.services.publication!.store.knownContextMessages({ application: discordConfig.application, externalConversationId: discordRoomId, hostId: 'local', agentSessionId: 'original-agent', source: { providerId: 'claude', nativeSessionId: 'original-native' } }, [String(native.id)])], JSON.stringify(published)).toEqual([String(native.id)])
  const original = (await f.client.readMessage({ messageId: ingress!.input.messageId }))!
  expect(original.envelope.channelQuote!.records.map(record => record.messageId)).toEqual(currentSource ? ['600', '8000'] : ['600', String(native.id), '8000'])
  expect(original.envelope.channelQuote!.coverage).toBe('complete')
  const sent = (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data as string
  const reading = parseAgentMuxMessagePrefix(sent.slice(0, -1))
  if (reading?.kind !== 'content') throw Error('Actual native input protocol reader required')
  expect(reading.declaredChannelQuote!.quote).toEqual(original.envelope.channelQuote)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII=', 'base64')
it('original resource bytes survive an unknown native multipart effect, metadata clear and Host reopen without replay', async () => {
  const f = await fixture()
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding).every(op => op.state === 'confirmed')).toBe(true))
  f.wire.message('701')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const subject = { kind: 'actor' as const, actor: { application: discordConfig.application, idType: 'snowflake', userId: '400' } }
  const cached = await f.services.connections.metadata!.get({ connectionId: discordConfig.connectionId, subject })
  expect(cached.entry.observation.profile?.name).toBe('Original person')
  f.wire.loseNextMessageResponse(false)
  await appendFile(f.transcript, JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: 'public-image', message: { role: 'assistant', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }
  ] } }) + '\n')
  f.services.publication!.refresh()
  const resource = () => f.services.publication!.store.list(f.binding).find(op => op.payload.kind === 'image')
  await vi.waitFor(() => expect(resource()?.state).toBe('unknown'))
  expect(f.wire.uploads).toEqual([png])
  const frozen = resource()!, prepared = frozen.prepared!
  expect(prepared.request.body).toBeUndefined()
  expect(prepared.request.multipart?.files).toEqual([expect.objectContaining({ resourceId: frozen.operationId, byteLength: png.length, contentType: 'image/png' })])
  expect(JSON.stringify(prepared)).not.toContain(png.toString('base64'))
  await f.services.connections.metadata!.clear({ connectionId: discordConfig.connectionId, expectedConnectionRevision: 1, subject, expectedCacheRevision: cached.entry.cacheRevision })
  await f.restart()
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.sessions.at(-1)?.op).toBe(6))
  expect(resource()?.prepared).toEqual(prepared)
  expect(resource()?.state).toBe('unknown')
  expect(f.wire.uploads).toEqual([png])
  const native = [...f.wire.messages.values()].find(msg => msg.nonce === JSON.parse(prepared.request.multipart!.payloadJson).nonce)!
  f.wire.emit('MESSAGE_CREATE', native)
  await vi.waitFor(async () => { f.services.publication!.refresh(); expect(resource()?.state).toBe('confirmed') })
  expect(resource()?.mapping?.messageId).toBe(native.id)
  expect(f.wire.uploads).toEqual([png])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('native channel rename and exact actor refresh share the public metadata cache without changing authors or grants', async () => {
  const f = await fixture()
  f.wire.message('702')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  f.wire.rename('Renamed original channel')
  const subject = { kind: 'conversation' as const, externalConversationId: discordRoomId }
  await vi.waitFor(async () => expect((await f.services.connections.metadata!.get({ connectionId: discordConfig.connectionId, subject })).entry.observation.profile?.name).toBe('Renamed original channel'))
  const actor = { application: discordConfig.application, idType: 'snowflake', userId: '400' }
  const refreshed = await f.services.connections.metadata!.refresh({ connectionId: discordConfig.connectionId, expectedConnectionRevision: 1, subject: { kind: 'actor', actor } })
  expect(refreshed.entry.observation.profile?.avatarUrl).toBe('https://cdn.discordapp.com/avatars/400/native_avatar.png?size=128')
  const list = await f.services.connections.metadata!.list({ connectionId: discordConfig.connectionId, kind: 'actor', limit: 1 })
  expect(list.entries[0]!.subject).toEqual({ kind: 'actor', actor })
  const original = (await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses[0]!
  expect(original.actor).toEqual(actor)
  expect((await f.services.connections.bindings!.inspect({ bindingId: f.binding.bindingId })).grants[0]!.capabilities).toEqual(['input'])
})

it('typed native file bytes reach the original Outbox and Discord multipart without a temporary upload message', async () => {
  const f = await fixture('codex'), bytes = Buffer.from([0, 255, ...Buffer.from('Original document')])
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding).some(op => op.payload.kind === 'binding-lifecycle' && op.state === 'confirmed')).toBe(true))
  await appendFile(f.transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'original-native', turn_id: 'original-file-turn', item: {
    type: 'McpToolCall', id: 'original-file', server: 'native-server', tool: 'read_document', arguments: { hidden: 'Private tool metadata' }, status: 'completed',
    result: { content: [{ type: 'resource', resource: { uri: 'opaque:original/file.bin', mimeType: 'application/octet-stream', name: 'original.bin', blob: bytes.toString('base64') } }] }
  } } }) + '\n')
  const page = await f.client.sessionHistoryPage('original-agent')
  expect(page.items.some(item => item.contentParts.some(part => part.kind === 'resource' && part.resourceType === 'file')), JSON.stringify(page)).toBe(true)
  f.services.publication!.refresh()
  await vi.waitFor(async () => expect(f.wire.uploads, JSON.stringify(f.services.publication!.store.coverage(f.binding))).toEqual([bytes]), { timeout: 10_000 })
  const operation = () => f.services.publication!.store.list(f.binding).find(op => op.payload.kind === 'file')
  await vi.waitFor(() => expect(operation()?.state).toBe('confirmed'))
  const body = JSON.parse(operation()!.prepared!.request.multipart!.payloadJson)
  await nativeProof('native-file', body)
  expect(body.components).toEqual([{ type: 13, file: { url: 'attachment://original.bin' } }])
  expect(f.wire.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages' && call.contentType.startsWith('multipart/'))).toHaveLength(1)
  expect(JSON.stringify(f.wire.calls)).not.toContain('Private tool metadata')
  expect(operation()?.uploads).toBeUndefined()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

async function grant(f: Awaited<ReturnType<typeof fixture>>, capabilities: Array<'input' | 'answer' | 'permission'>) {
  await f.services.connections.bindings!.grant({ operationId: 'discord-action-grant', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'discord-user-grant', expectedRevision: 1,
    actor: { application: discordConfig.application, idType: 'snowflake', userId: '400' }, capabilities, state: 'active' }, context)
}
it.each([false, true])('native question button and modal submit exact original answers through the original grant and Core responder once (long original: %s)', async longOriginal => {
  const f = await fixture('codex'); await grant(f, ['input', 'answer'])
  const original = (await f.store.readMetadata('original-agent'))!
  const actor = { protocolId: 'codex-app-server-v2-0.163', actorId: 'question-actor', lifecycleOperationId: 'question-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
  await f.store.compareAndSwap(original, { ...original, nativeActor: actor }); await f.inner.registry.load('local')
  let replyError: unknown
  const reply = f.client.replySessionQuestion.bind(f.client)
  vi.spyOn(f.client, 'replySessionQuestion').mockImplementation(async (...args) => { try { return await reply(...args) } catch (error) { replyError = error; throw error } })
  const send = vi.fn<import('../../core/src/agent-provider.js').AgentProviderPreparedNativeInput['send']>(async () => ({ outcome: 'admitted' as const, turnId: 'original-answer-turn' }))
  f.client.providers.get('codex').prepareNativeInput = async (_context, source) => ({ plan: { kind: 'native-rpc', protocolId: actor.protocolId, sourceId: JSON.stringify([source.providerId, source.nativeSessionId]), actorId: actor.actorId, threadId: source.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: async () => {}, send, dispose() {} })
  const event = savedQuestionEvent(); event.payload.thread_id = 'original-native'
  if (longOriginal) event.payload.item.questions[0]!.title = 'Original long question\n' + '完整原文🙂'.repeat(900) + '\nOriginal question end'
  event.payload.item.questions.push({ title: 'What follows the original work?', options: ['Proceed', 'Wait'] })
  if (longOriginal) { await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding).every(op => op.state === 'confirmed')).toBe(true)); f.wire.loseNextMessageResponse(false) }
  await appendFile(f.transcript, savedQuestionJsonl([event])); f.services.publication!.refresh()
  const operation = () => f.services.publication!.store.list(f.binding).find(op => op.payload.kind === 'question')
  if (longOriginal) {
    await vi.waitFor(() => expect(operation()?.state).toBe('unknown'))
    const original = operation()!, frozen = original.prepared!, uploads = [...f.wire.uploads]
    expect(uploads).toEqual([Buffer.from(publicationInteractionText(original), 'utf8')])
    expect(uploads[0]!.toString()).not.toContain(actor.token)
    expect(uploads[0]!.toString()).not.toContain(original.payload.kind === 'question' ? original.payload.actionRef : 'unexpected-action')
    expect(frozen.request.multipart!.files[0]).toMatchObject({ source: 'public-interaction-text', resourceId: original.operationId, byteLength: uploads[0]!.length })
    await f.restart(); f.services.publication!.refresh()
    expect(operation()?.state).toBe('unknown'); expect(operation()?.prepared).toEqual(frozen); expect(f.wire.uploads).toEqual(uploads)
    const native = [...f.wire.messages.values()].find(message => message.nonce === JSON.parse(frozen.request.multipart!.payloadJson).nonce)!
    f.wire.emit('MESSAGE_CREATE', native)
    await vi.waitFor(() => { f.services.publication!.refresh(); expect(operation()?.state).toBe('confirmed') })
    const adapter = new DiscordAdapter({ http: f.wire.http }), postCount = () => f.wire.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages').length
    const before = postCount(), context = publicationEffectContext(original), signal = new AbortController().signal
    for (const changed of [{ resourceId: 'another-original-operation' }, { sha256: '0'.repeat(64) }, { byteLength: uploads[0]!.length + 1 }]) {
      const forged = structuredClone(frozen); Object.assign(forged.request.multipart!.files[0]!, changed)
      expect(await adapter.publication.dispatch(forged, original.target, 'fixture-bot-token', signal, undefined, context)).toEqual({ state: 'not-applied', reason: 'unsupported-format' })
    }
    const forged = structuredClone(frozen); Object.assign(forged.request.multipart!.files[0]!, { source: 'untrusted-source' })
    await expect(adapter.publication.dispatch(forged, original.target, 'fixture-bot-token', signal, undefined, context)).rejects.toMatchObject({ code: 'PUBLICATION_PREPARATION_UNCONFIRMED' })
    expect(postCount()).toBe(before)
  }
  await vi.waitFor(() => expect(operation()?.state).toBe('confirmed'), { timeout: 10_000 })
  const question = operation()!, body = JSON.parse(question.prepared!.request.body ?? question.prepared!.request.multipart!.payloadJson)
  if (longOriginal) {
    expect(body.components[0].components[0].content).toContain('complete original question')
    expect(body.components[0].components[1]).toEqual({ type: 13, file: { url: 'attachment://Original request.txt' } })
  }
  const button = body.components[0].components.flatMap((part: { components?: unknown[] }) => part.components ?? [])[0]
  expect(button.custom_id).toBe('q:' + (question.payload.kind === 'question' ? question.payload.actionRef : 'missing'))
  expect(f.services.ingress!.questionForm({ connectionId: discordConfig.connectionId, application: discordConfig.application, actor: { application: discordConfig.application, idType: 'snowflake', userId: '400' }, externalConversationId: discordRoomId, sourceMessageId: question.mapping!.messageId, actionRef: question.payload.kind === 'question' ? question.payload.actionRef! : '' })).not.toBeNull()
  f.wire.interaction('900', 3, { custom_id: button.custom_id, component_type: 2 }, question.mapping!.messageId, '401')
  await vi.waitFor(() => expect(f.wire.calls.some(call => call.path === '/interactions/900/fixture-interaction-token/callback' && JSON.parse(call.body).type === 4)).toBe(true))
  expect(send).not.toHaveBeenCalled()
  f.wire.interaction('901', 3, { custom_id: button.custom_id, component_type: 2 }, question.mapping!.messageId)
  await vi.waitFor(() => expect(f.wire.calls.some(call => call.path === '/interactions/901/fixture-interaction-token/callback' && JSON.parse(call.body).type === 9), JSON.stringify(f.wire.calls.filter(call=>call.path.startsWith('/interactions/')))).toBe(true))
  const modal = JSON.parse(f.wire.calls.find(call => call.path === '/interactions/901/fixture-interaction-token/callback')!.body).data
  await nativeProof(longOriginal ? 'native-long-question' : 'native-question', { message: body, modal })
  expect(modal.components.map((component: { component: { type: number } }) => component.component.type)).toEqual([3, 4, 3, 4])
  expect(modal.components[0].component.max_values).toBe(1)
  expect(modal.components[0].description).toBe('Select one option, or leave it blank and enter a custom answer.')
  expect(modal.components[0].description.length).toBeLessThanOrEqual(100)
  f.wire.interaction('902', 5, { custom_id: modal.custom_id, components: [
    { type: 18, component: { type: 3, custom_id: 'o0', values: ['0', '1'] } }, { type: 18, component: { type: 4, custom_id: 't0', value: '' } },
    { type: 18, component: { type: 3, custom_id: 'o1', values: [] } }, { type: 18, component: { type: 4, custom_id: 't1', value: 'Keep the original follow-up' } }
  ] })
  await vi.waitFor(() => expect(f.wire.calls.some(call => call.path === '/interactions/902/fixture-interaction-token/callback' && JSON.parse(call.body).type === 4)).toBe(true))
  expect(send).not.toHaveBeenCalled()
  f.wire.interaction('904', 5, { custom_id: modal.custom_id, components: [
    { type: 18, component: { type: 3, custom_id: 'o0', values: ['0'] } }, { type: 18, component: { type: 4, custom_id: 't0', value: 'Conflicting custom answer' } },
    { type: 18, component: { type: 3, custom_id: 'o1', values: [] } }, { type: 18, component: { type: 4, custom_id: 't1', value: 'Keep the original follow-up' } }
  ] })
  await vi.waitFor(() => expect(f.wire.calls.some(call => call.path === '/interactions/904/fixture-interaction-token/callback')).toBe(true))
  const invalid = JSON.parse(f.wire.calls.find(call => call.path === '/interactions/904/fixture-interaction-token/callback')!.body)
  expect(invalid).toMatchObject({ type: 4, data: { flags: 64 } })
  expect(invalid.data.content).toContain('No answer was submitted.')
  expect(invalid.data.content).toContain('leaving the other blank')
  expect(invalid.data.content).not.toContain('original action is unavailable')
  expect(send).not.toHaveBeenCalled()
  expect((await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses).toHaveLength(0)
  f.wire.interaction('905', 3, { custom_id: button.custom_id, component_type: 2 }, question.mapping!.messageId)
  await vi.waitFor(() => expect(f.wire.calls.some(call => call.path === '/interactions/905/fixture-interaction-token/callback' && JSON.parse(call.body).type === 9)).toBe(true))
  expect(JSON.parse(f.wire.calls.find(call => call.path === '/interactions/905/fixture-interaction-token/callback')!.body).data.custom_id).toBe(modal.custom_id)
  const submitted = f.wire.interaction('903', 5, { custom_id: modal.custom_id, components: [
    { type: 18, component: { type: 3, custom_id: 'o0', values: ['1'] } }, { type: 18, component: { type: 4, custom_id: 't0', value: '' } },
    { type: 18, component: { type: 3, custom_id: 'o1', values: [] } }, { type: 18, component: { type: 4, custom_id: 't1', value: 'Keep the original follow-up' } }
  ] })
  await vi.waitFor(async () => expect(send, JSON.stringify({replyError,records:await f.services.ingress!.list({connectionId:discordConfig.connectionId}),callbacks:f.wire.calls.filter(call=>call.path.startsWith('/interactions/'))})).toHaveBeenCalledOnce(), { timeout: 10_000 })
  expect(codexQuestionAnswers([{ type: 'text', text: send.mock.calls[0]![0] }])).toEqual([
    { questionId: savedQuestionId, prompt: event.payload.item.questions[0]!.title, answer: 'Review the direction' },
    { questionId: JSON.stringify(['request_user_input_async', event.payload.item.id, 1]), prompt: 'What follows the original work?', answer: 'Keep the original follow-up' }
  ])
  const record = (await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses[0]!
  expect(record).toMatchObject({ kind: 'action', state: 'claimed', input: { responseKind: 'question', author: { actor: { userId: '400' }, grantRevision: 2 } } })
  expect((await f.services.ingress!.inspect({ ingressId: record.ingressId })).questionReceipt).toMatchObject({ outcome: 'submitted', operationId: record.input!.operationId })
  expect(JSON.parse(f.wire.calls.find(call => call.path === '/interactions/903/fixture-interaction-token/callback')!.body)).toEqual({ type: 6 })
  if (longOriginal) {
    await vi.waitFor(() => {
      f.services.publication!.refresh()
      expect(f.services.publication!.store.list(f.binding).findLast(op => op.payload.kind === 'question')?.payload).toMatchObject({ status: 'response-sent' })
      expect(f.services.publication!.store.list(f.binding).findLast(op => op.payload.kind === 'question')?.state).toBe('confirmed')
    })
    const latest = f.services.publication!.store.list(f.binding).findLast(op => op.payload.kind === 'question')!
    expect(JSON.parse(latest.prepared!.request.multipart!.payloadJson).components[0].components[0].content).toContain('Answer submitted to the original Agent')
    const capacity = structuredClone(event); capacity.payload.item.id = 'original-capacity-call'; capacity.payload.turn_id = 'original-capacity-turn'
    capacity.payload.item.questions.push({ title: 'Third original question exceeds native modal capacity', options: ['Keep it'] })
    await appendFile(f.transcript, savedQuestionJsonl([capacity])); f.services.publication!.refresh()
    const capacityOperation = () => f.services.publication!.store.list(f.binding).findLast(op => op.payload.kind === 'question' && op.payload.questions.length === 3)
    await vi.waitFor(() => expect(capacityOperation()?.state).toBe('confirmed'))
    const capacityBody = JSON.parse(capacityOperation()!.prepared!.request.multipart!.payloadJson)
    expect(capacityBody.components[0].components[0].content).toContain('This question exceeds Discord modal capacity.')
    expect(capacityBody.components[0].components[0].content).toContain('amux://agent/original-agent')
    expect(JSON.stringify(capacityBody.components)).not.toContain('"custom_id":"q:')
    await nativeProof('native-long-capacity', capacityBody)
  }
  f.wire.emit('INTERACTION_CREATE', submitted)
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(send).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each([{ lostCallback: false, longOriginal: false }, { lostCallback: true, longOriginal: false }, { lostCallback: false, longOriginal: true }])('native permission buttons resolve only the original authorized Hook request without answering on behalf of a local human (lost callback: $lostCallback, long original: $longOriginal)', async ({ lostCallback, longOriginal }) => {
  const f = await fixture('codex'); await grant(f, ['input', 'permission'])
  const server = Reflect.get(f.client, 'hookServer') as { start(): Promise<void>; createBinding(id: string, provider: string, bindingId?: string, token?: string): { bindingId: string; bindRun(id: string): Promise<void>; endpoint: { url: string; token: string } } }
  const original = (await f.store.readMetadata('original-agent'))!
  await server.start(); const hook = server.createBinding('original-agent', 'codex'); await hook.bindRun('run-original-agent')
  await f.store.compareAndSwap(original, { ...original, hookBindingId: hook.bindingId, hookToken: hook.endpoint.token }); await f.inner.registry.load('local')
  f.inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), pid: 123 }))
  const command = longOriginal ? 'Original long command\n' + 'original context '.repeat(300) + '🙂\nOriginal command end' : 'Original command'
  let request: ReturnType<typeof httpRequest>
  const answered = new Promise<unknown>((resolve, reject) => {
    request = httpRequest(hook.endpoint.url, { method: 'POST', headers: { authorization: 'Bearer ' + hook.endpoint.token } }, response => {
      let body = ''; response.on('data', value => { body += value }); response.once('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
      response.once('aborted', () => reject(Error('The controlled Hook response was closed'))); response.once('error', reject)
    }); request.once('error', reject); request.end(JSON.stringify({ receiptId: 'original-discord-permission', eventName: 'PermissionRequest', decision: true,
      payload: { hook_event_name: 'PermissionRequest', session_id: 'original-native', turn_id: 'original-turn', tool_name: 'Bash', tool_input: { command } } }))
  }); void answered.catch(() => {}); cleanup.push(async () => { request.destroy(); await Promise.allSettled([answered]) })
  let early: unknown; void answered.then(value => { early = value }, () => {})
  await vi.waitFor(() => expect(f.client.agentSession('original-agent').pendingInteraction?.request.id, JSON.stringify(early)).toBe('original-discord-permission'))
  f.services.publication!.refresh()
  const operation = () => f.services.publication!.store.list(f.binding).find(op => op.payload.kind === 'permission' && op.state === 'confirmed')
  await vi.waitFor(() => expect(operation()).toBeDefined())
  const permission = operation()!, body = JSON.parse(permission.prepared!.request.body ?? permission.prepared!.request.multipart!.payloadJson)
  if (longOriginal) {
    expect(f.wire.uploads).toEqual([Buffer.from(publicationInteractionText(permission), 'utf8')])
    expect(f.wire.uploads[0]!.toString()).toContain('Original command end')
    expect(f.wire.uploads[0]!.toString()).not.toContain(hook.endpoint.token)
    expect(body.components[0].components[0].content).toContain('complete original shared permission request')
  }
  await nativeProof(longOriginal ? 'native-long-permission' : 'native-permission', body)
  const button = body.components[0].components.flatMap((part: { components?: unknown[] }) => part.components ?? [])[0]
  expect(button.custom_id).toMatch(/^p:/)
  if (lostCallback) f.wire.loseNextCallbackResponse()
  f.wire.interaction('910', 3, { custom_id: button.custom_id, component_type: 2 }, permission.mapping!.messageId)
  await vi.waitFor(async () => expect((await f.services.ingress!.list({connectionId:discordConfig.connectionId})).ingresses[0]?.state).toBe('claimed'))
  expect(await answered).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
  expect(JSON.parse(f.wire.calls.find(call => call.path === '/interactions/910/fixture-interaction-token/callback')!.body)).toEqual({ type: 6 })
  expect((await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses[0]).toMatchObject({ kind: 'action', state: 'claimed', input: { author: { actor: { userId: '400' }, grantRevision: 2 } } })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  if (lostCallback) {
    f.wire.message('701', 'Original input after an unconfirmed callback')
    await vi.waitFor(async () => expect((await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses.find(record => record.kind !== 'action' && record.externalMessageId === '701')?.state).toBe('claimed'))
    expect(f.wire.sessions).toHaveLength(1)
    expect((await f.services.connections.inspect({ connectionId: discordConfig.connectionId })).connection?.observation.intake).toEqual({ state: 'unknown', reason: 'check-failed' })
  }
})

it('a native custody failure closes only that SDK resource and the original receiver owner resumes from the durable ACK cursor', async () => {
  const f = await fixture(), ingress = f.services.ingress!, receive = ingress.receive.bind(ingress)
  const failure = vi.spyOn(ingress, 'receive').mockRejectedValueOnce(Error('Controlled original custody storage unavailable')).mockImplementation(receive)
  f.wire.message('703', 'Original message whose first custody failed')
  await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce())
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(f.wire.sessions.at(-1)?.op).toBe(6), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect((await ingress.list({ connectionId: discordConfig.connectionId })).ingresses).toHaveLength(1)
  expect((f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data).toContain('Original message whose first custody failed')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('native channel discovery, exact reads and invitation receipts reuse the original public room owner', async () => {
  const f = await fixture(), scope = { connectionId: discordConfig.connectionId, expectedConnectionRevision: 1 }
  const first = await f.services.connections.rooms!.list!({ ...scope, limit: 1 })
  expect(first.observation).toEqual({ state: 'ready' }); expect(first.rooms).toEqual([{ externalConversationId: '300', name: 'Original channel', state: 'active' }])
  const second = await f.services.connections.rooms!.list!({ ...scope, limit: 1, cursor: first.next! })
  expect(second.rooms).toEqual([{ externalConversationId: '301', name: 'Another channel', state: 'active' }])
  expect((await f.services.connections.rooms!.list!({ ...scope, cursor: second.next! })).next).toBeNull()
  const searched = await f.services.connections.rooms!.search!({ ...scope, query: 'Another' })
  expect(searched.rooms.map(room => room.externalConversationId)).toEqual(['301'])
  expect((await f.services.connections.rooms!.get!({ ...scope, externalConversationId: '300' })).room).toMatchObject({ externalConversationId: '300', mode: 'group' })
  expect((await f.services.connections.rooms!.members!({ ...scope, externalConversationId: '300' })).observation).toEqual({ state: 'unknown', reason: 'response-unconfirmed' })
  expect(f.wire.calls.some(call => call.path.includes('/members'))).toBe(false)
  const invitation = { ...scope, externalConversationId: '300', operationId: 'original-discord-invite' }
  expect(await f.services.connections.rooms!.createLink!(invitation, context)).toMatchObject({ state: 'confirmed', link: { url: 'https://discord.gg/original-invite' } })
  expect(await f.services.connections.rooms!.createLink!(invitation, context)).toMatchObject({ state: 'confirmed' })
  expect(f.wire.calls.filter(call => call.path === '/channels/300/invites' && call.method === 'POST')).toHaveLength(1)
  expect((await f.services.connections.bindings!.inspect({ bindingId: f.binding.bindingId })).grants[0]!.capabilities).toEqual(['input'])
})

it('the pinned SDK resumes a physical Gateway disconnect while observations retain the actual gap and Core deduplicates replay', async () => {
  const f = await fixture(); f.wire.message('700')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  f.wire.disconnect()
  await vi.waitFor(() => expect(f.wire.pausedConnections).toBe(1))
  expect((await f.services.connections.inspect({ connectionId: discordConfig.connectionId })).connection?.observation.transport).toEqual({ state: 'unknown', reason: 'check-failed' })
  f.wire.resumeGateway()
  await vi.waitFor(() => expect(f.wire.sessions.at(-1)?.op).toBe(6))
  f.wire.message('701', 'Original input after native SDK resume')
  await vi.waitFor(async () => expect((await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses.find(record => record.kind !== 'action' && record.externalMessageId === '701')?.state).toBe('claimed'))
  f.wire.message('700'); await new Promise(resolve => setTimeout(resolve, 40))
  expect((await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses).toHaveLength(2)
  expect((await f.services.connections.inspect({ connectionId: discordConfig.connectionId })).connection?.observation.transport.state).toBe('ready')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an explicit connection check rereads native application identity and cannot certify a revoked or changed bot from an earlier cache', async () => {
  const f = await fixture(), before = f.wire.calls.filter(call => call.path === '/oauth2/applications/@me').length
  f.wire.changeApplication('999')
  expect((await f.services.connections.test({ connectionId: discordConfig.connectionId })).observation.authentication.state).toBe('unavailable')
  expect(f.wire.calls.filter(call => call.path === '/oauth2/applications/@me').length).toBeGreaterThan(before)
  await f.client.writeAgent({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, source: 'user', data: 'Original healthy local input' })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an edited native reply preserves its original message mapping and inspects a lost PATCH receipt despite platform-assigned component IDs', async () => {
  const f = await fixture()
  const row = (text: string) => JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: 'original-edit', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  await appendFile(f.transcript, row('Original reply before edit')); f.services.publication!.refresh()
  const speech = () => f.services.publication!.store.list(f.binding).filter(op => op.payload.kind === 'speech')
  await vi.waitFor(() => expect(speech()[0]?.state).toBe('confirmed'))
  const mapping = speech()[0]!.mapping!
  f.wire.loseNextMessageResponse()
  await appendFile(f.transcript, row('Original reply after native edit')); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.calls.filter(call => call.method === 'PATCH')).toHaveLength(1))
  await vi.waitFor(() => { f.services.publication!.refresh(); expect(speech().at(-1)?.state).toBe('confirmed') })
  expect(speech().at(-1)?.mapping).toEqual(mapping)
  expect(f.wire.calls.filter(call => call.method === 'PATCH')).toHaveLength(1)
  expect(f.wire.calls.some(call => call.method === 'GET' && call.path === '/channels/300/messages/' + mapping.messageId)).toBe(true)
  expect(JSON.stringify(f.wire.messages.get(mapping.messageId))).toContain('Original reply after native edit')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each([false, true])('mixed Markdown typed question retains its original actions and answer receipt (missing image: %s)', async missingImage => {
  const f = await fixture('codex'); await grant(f, ['input', 'answer'])
  const image = join(f.root, 'question-diagram.png'), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII=', 'base64')
  if (!missingImage) await writeFile(image, png)
  const original = (await f.store.readMetadata('original-agent'))!, actor = { protocolId: 'codex-app-server-v2-0.163', actorId: 'mixed-question-actor', lifecycleOperationId: 'mixed-question-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
  await f.store.compareAndSwap(original, { ...original, nativeActor: actor }); await f.inner.registry.load('local')
  const send = vi.fn<import('../../core/src/agent-provider.js').AgentProviderPreparedNativeInput['send']>(async () => {
    if (missingImage) throw Error('Controlled original native answer receipt loss')
    return { outcome: 'admitted', turnId: 'mixed-answer-turn' }
  })
  f.client.providers.get('codex').prepareNativeInput = async (_context, source) => ({ plan: { kind: 'native-rpc', protocolId: actor.protocolId, sourceId: JSON.stringify([source.providerId, source.nativeSessionId]), actorId: actor.actorId, threadId: source.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: async () => {}, send, dispose() {} })
  const event = savedQuestionEvent(); event.payload.thread_id = 'original-native'
  event.payload.item.content[0]!.text = `Before the original question\n\n![Original diagram](${image})\n\nAfter the original diagram`
  await appendFile(f.transcript, savedQuestionJsonl([event])); f.services.publication!.refresh()
  const question = () => f.services.publication!.store.list(f.binding).findLast(operation => operation.payload.kind === 'question')
  await vi.waitFor(() => expect(question()?.state, 'The original typed question stays actionable beside Markdown media').toBe('confirmed'), { timeout: 10_000 })
  const published = question()!
  expect(published.payload).toMatchObject({ kind: 'question', status: 'pending', questions: [{ id: savedQuestionId }] })
  if (published.payload.kind !== 'question') throw Error('The original typed question is required')
  expect(published.payload.text).not.toContain(image)
  expect(published.payload.text).toContain('Before the original question')
  expect(published.payload.text).toContain('After the original diagram')
  if (missingImage) expect(published.payload.text).toContain('Image unavailable')
  else { expect(published.fragment.ordinal).toBeGreaterThan(0); expect(f.wire.uploads).toEqual([png]) }
  const actionRef = published.payload.actionRef!, body = JSON.parse(published.prepared!.request.body!), button = body.components[0].components.flatMap((part: { components?: unknown[] }) => part.components ?? [])[0]
  expect(button.custom_id).toBe('q:' + actionRef)
  const form = { connectionId: discordConfig.connectionId, application: discordConfig.application, actor: { application: discordConfig.application, idType: 'snowflake', userId: '400' }, externalConversationId: discordRoomId, sourceMessageId: published.mapping!.messageId, actionRef }
  expect(f.services.ingress!.questionForm(form)).toMatchObject({ status: 'pending', questions: [{ id: savedQuestionId }] })
  expect(f.services.ingress!.questionForm({ ...form, actor: { ...form.actor, userId: '401' } })).toBeNull()
  f.wire.interaction('9100', 3, { custom_id: button.custom_id, component_type: 2 }, published.mapping!.messageId)
  await vi.waitFor(() => expect(f.wire.calls.some(call => call.path === '/interactions/9100/fixture-interaction-token/callback' && JSON.parse(call.body).type === 9)).toBe(true))
  const modal = JSON.parse(f.wire.calls.find(call => call.path === '/interactions/9100/fixture-interaction-token/callback')!.body).data
  const submitted = f.wire.interaction('9101', 5, { custom_id: modal.custom_id, components: [
    { type: 18, component: { type: 3, custom_id: 'o0', values: ['0'] } }, { type: 18, component: { type: 4, custom_id: 't0', value: '' } }
  ] })
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 10_000 })
  expect(codexQuestionAnswers([{ type: 'text', text: send.mock.calls[0]![0] }])).toEqual([{ questionId: savedQuestionId, prompt: event.payload.item.questions[0]!.title, answer: 'Keep the original work' }])
  const record = (await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses[0]!
  expect(record).toMatchObject({ kind: 'action', state: 'claimed', input: { responseKind: 'question', author: { actionRef, actor: { userId: '400' } } } })
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: record.ingressId })).questionReceipt).toMatchObject({ operationId: record.input!.operationId, outcome: missingImage ? 'unknown' : 'submitted' }))
  const receipt = structuredClone((await f.services.ingress!.inspect({ ingressId: record.ingressId })).questionReceipt), uploads = f.wire.uploads.length
  await f.restart(); f.services.publication!.refresh()
  f.wire.emit('INTERACTION_CREATE', submitted)
  await vi.waitFor(() => expect(question()?.payload).toMatchObject({ status: missingImage ? 'unconfirmed' : 'response-sent' }))
  expect((await f.services.ingress!.inspect({ ingressId: record.ingressId })).questionReceipt).toEqual(receipt)
  expect(send).toHaveBeenCalledOnce(); expect(f.wire.uploads).toHaveLength(uploads)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.client.agentSession('original-agent').run).toEqual(original.run)
}, 30_000)
