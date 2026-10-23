import { appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/src/index.js'
import type { AgentProvider } from '../../core/src/agent-provider.js'
import { consumeConversationWindowPage } from '../../core/src/conversation-changes.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../dist/index.js'
import { botOpenId, feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Rich-post consumer cleanup failed')
})
const post = { title: '  原标题🙂  ', content: [
  [{ tag: 'text', text: '  完整首段\n保留换行 ' }, { tag: 'a', text: '平台文档', href: 'https://open.feishu.cn/document?from=original' }],
  [], [{ tag: 'at', user_id: '@_user_1', user_name: '原Bot' }, { tag: 'text', text: '  最后一段  ' }]
] }
const body = '  原标题🙂  \n  完整首段\n保留换行 [平台文档](https://open.feishu.cn/document?from=original)\n\n@原Bot  最后一段  '
const payload = (id: string, content: unknown = post, mentions: unknown = [{ key: '@_user_1', id: { open_id: botOpenId }, name: '原Bot' }]) => {
  const event = feishuPayload({ message_id: id, message_type: 'post', content: JSON.stringify(content), mentions })
  event.header.event_id = 'event-' + id
  return event
}
async function fixture() {
  const h = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'claude', executorId: 'claude',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'post-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(h.close)
  const transcript = join(h.root, 'native.jsonl'), session = h.client.agentSession('original-agent')
  await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'post-native', uuid: 'before-sharing', message: { role: 'user', content: 'Original private history' } }) + '\n')
  // Only Provider terminal I/O is deterministic; all admission, journals and native reads remain original.
  const provider = (h.client as unknown as { providers: { get(id: string): AgentProvider } }).providers.get('claude')
  vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const spatial = new core.AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: h.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: h.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: session.agentSessionId, runId: null, execution: { hostId: 'local', cwd: h.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  const sdk = feishuSdkTransport()
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(options => {
    const { params, ...request } = options
    if (params !== undefined && (params === null || typeof params !== 'object')) throw new Error('Expected original SDK query parameters')
    return remote.http.request({ ...request, ...(params === undefined ? {} : { params }) })
  })
  const services = await createConnectionServices({ directory: join(h.root, 'post-host'),
    encryption: { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(value), decryptStringAsync: async value => ({ result: (value.toString()), shouldReEncrypt: false }) },
    bindings: { spatial, checkpoint: reference => h.client.conversationCheckpoint(reference) },
    publication: createPublicationConversationPort(h.coreClients), ingress: { core: hostId => hostId === 'local' ? h.client : undefined } })
  cleanup.push(() => services.close())
  const secret = await services.secrets.store({ operationId: 'post-credential', secret: 'private-post-fixture-credential' })
  await services.connections.configure({ operationId: 'post-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: secret.credentialRef } })
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
  const bound = await services.connections.bindings!.bind({ operationId: 'post-bind', bindingId: 'post-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: session.agentSessionId, regionAnchor: { regionId: 'original-region' },
    externalConversationId: 'original-room', expectedSource: { providerId: 'claude', nativeSessionId: 'post-native' },
    scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, { actor: { kind: 'user', id: 'original-user' } })
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw new Error('Original sharing Binding did not apply')
  const actor = { application: feishuConfig.application, idType: 'open_id' as const, userId: 'original-external-user' }
  await services.connections.bindings!.grant({ operationId: 'post-grant', bindingId: bound.binding.bindingId, expectedBindingRevision: bound.binding.revision,
    grantId: 'post-grant', expectedRevision: null, actor, capabilities: ['input'], state: 'active' }, { actor: { kind: 'user', id: 'original-user' } })
  const server = new core.AgentMuxControlServer({ socketPath: join(h.root, 'post.sock'), connections: services.connections, spatialState: spatial, coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const cli = async (args: string[]) => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', ...args], objectCliEnvironment(h.root))
    expect(output.code, output.stdout + output.stderr).toBe(0)
    return JSON.parse(output.stdout).result
  }
  const received = async (messageId: string) => {
    const list = await services.ingress!.list({ connectionId: feishuConfig.connectionId })
    const found = list.ingresses.find(value => value.kind !== 'action' && value.externalMessageId === messageId)
    if (!found || found.kind === 'action') throw new Error('Original durable message was not found')
    return found
  }
  return { ...h, transcript, session, services, sdk, remote, rpc, cli, received, binding: bound.binding }
}

it('default Host accepts complete native post text through SDK proof, durable ACK and Core, reuses the group origin and exposes the original reply through compiled CLI', async () => {
  const f = await fixture(), original = payload('rich-original', { ...post, content_v2: post.content })
  const appGrant = await f.services.connections.bindings!.grant({ operationId: 'grant-application-sender', bindingId: f.binding.bindingId,
    expectedBindingRevision: f.binding.revision, grantId: 'application-sender-input', expectedRevision: null,
    actor: { application: feishuConfig.application, idType: 'open_id', userId: botOpenId }, capabilities: ['input'], state: 'active' },
  { actor: { kind: 'user', id: 'original-user' } })
  expect(appGrant.state).toBe('applied')
  const echo = payload('application-echo', { ...post, content_v2: post.content })
  // An explicit grant and equal body do not turn the original typed application sender into a user.
  echo.event.sender.sender_type = 'app'
  echo.event.sender.sender_id.open_id = botOpenId
  await f.sdk.receive(echo)
  expect(f.sdk.ack()).toEqual([{ code: 200 }])
  const afterEcho = await f.cli(['ingress', 'ls', '--connection', feishuConfig.connectionId])
  const echoDelivery = await f.cli(['delivery', 'ls', '--connection', feishuConfig.connectionId, '--binding', f.binding.bindingId, '--binding-revision', String(f.binding.revision)])
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(afterEcho.ingresses).toEqual([])
  expect(echoDelivery.deliveries).toEqual([])
  expect(echoDelivery.coverage.origins).toEqual([])
  expect((await f.client.sessionTimeline(f.session.agentSessionId)).items.filter(item => item.inputRef?.kind === 'message')).toEqual([])
  expect(f.remote.messageCalls()).toEqual([])
  await f.sdk.receive(original)
  expect(f.sdk.ack()).toEqual([{ code: 200 }, { code: 200 }])
  const persisted = f.services.database!.prepare('SELECT raw_payload FROM connection_ingress_event WHERE event_id=?').get(original.header.event_id)!
  expect(JSON.parse(String(persisted.raw_payload))).toEqual(original)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const incoming = await f.received('rich-original'), input = incoming.input!
  expect(incoming).toMatchObject({ state: 'claimed', actor: { idType: 'open_id', userId: 'original-external-user' } })
  const queued = await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(input.operationId)
  expect(queued!.envelope.sender).toEqual(input.author)
  await vi.waitFor(async () => expect((await f.client.sessionTimeline(f.session.agentSessionId)).items.find(item => item.inputRef?.kind === 'message' && item.inputRef.messageId === input.messageId)?.publicContent).toBe('confirmed'))
  const read = consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: f.session.agentSessionId }))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw new Error('Original shared Reader window is incomplete')
  const unit = read.snapshot.units.find(unit => unit.records.some(record => record.original.kind === 'captured' && record.original.item.inputRef?.kind === 'message' && record.original.item.inputRef.messageId === input.messageId))!
  expect(unit.event.author).toEqual(input.author)
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.coverage(f.binding).origins).toHaveLength(1))
  expect(f.remote.messageCalls()).toEqual([])
  await f.sdk.receive(original)
  expect((await f.cli(['ingress', 'ls', '--connection', feishuConfig.connectionId])).ingresses).toHaveLength(1)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const another = payload('rich-equal-body')
  await f.sdk.receive(another)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  expect((await f.received('rich-equal-body')).input!.messageId).not.toBe(input.messageId)
  const sdk = await f.rpc.call('connection.ingress.inspect', { ingressId: incoming.ingressId })
  expect(await f.cli(['ingress', 'inspect', '--ingress', incoming.ingressId])).toEqual(sdk)
  expect(sdk.ingress).toMatchObject({ input: { author: input.author } })
  // Controlled Provider output carries what the original Core queue actually received.
  // The wire assertion below must detect a partial decoder after all real downstream owners.
  const replyPrefix = 'Original Agent reply echoes the accepted public body 中文🙂\n'
  await appendFile(f.transcript, JSON.stringify({ sessionId: 'post-native', uuid: 'original-post-reply', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: replyPrefix + queued!.envelope.body }] } }) + '\n')
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding).some(operation => operation.state === 'confirmed')).toBe(true))
  const operation = f.services.publication!.store.list(f.binding)[0]!, wire = f.remote.messageCalls().filter(call => call.method === 'POST')
  expect(wire).toHaveLength(1)
  expect(JSON.parse(JSON.parse(wire[0]!.body).content).zh_cn.content[0][0].text).toBe(replyPrefix + body)
  const delivery = await f.cli(['delivery', 'inspect', '--operation-id', operation.operationId])
  expect(delivery.delivery).toMatchObject({ state: 'confirmed', target: { externalConversationId: 'original-room' }, mapping: operation.mapping })
  expect((await f.cli(['delivery', 'ls', '--connection', feishuConfig.connectionId, '--binding', f.binding.bindingId, '--binding-revision', String(f.binding.revision)])).coverage.origins).toHaveLength(2)
  expect(incoming.body).toBe(body); expect(queued!.envelope.body).toBe(body)
  expect(sdk.ingress).toMatchObject({ body })
  expect(unit.records.some(record => record.original.kind === 'captured' && record.original.item.content?.endsWith(body))).toBe(true)
  expect(f.client.agentSession(f.session.agentSessionId).run).toEqual(f.session.run)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 25_000)

it('each explicit single locale and the existing text shape keep complete body and the original typed author', async () => {
  const f = await fixture()
  for (const [index, locale] of ['zh_cn', 'en_us', 'ja_jp'].entries()) {
    await f.sdk.receive(payload('single-' + locale, { [locale]: post }))
    await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(index + 1))
    expect(await f.received('single-' + locale)).toMatchObject({ body, state: 'claimed', actor: { idType: 'open_id', userId: 'original-external-user' } })
  }
  const text = feishuPayload({ message_id: 'existing-text', content: JSON.stringify({ text: '  Original text\n\nEvery byte remains.  ' }) })
  text.header.event_id = 'event-existing-text'
  await f.sdk.receive(text)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(4))
  expect(await f.received('existing-text')).toMatchObject({ body: '  Original text\n\nEvery byte remains.  ', state: 'claimed' })
  expect(f.sdk.ack()).toEqual([{ code: 200 }, { code: 200 }, { code: 200 }, { code: 200 }])
}, 25_000)

it('unsupported and ambiguous post content is durably acknowledged whole; untrusted mention names, keys and namespaces cannot authorize input', async () => {
  const f = await fixture()
  const at = { title: '', content: [[{ tag: 'at', user_id: '@_user_1', user_name: '原Bot' }]] }
  const unsupported = [
    payload('unknown-node', { ...post, content: [...post.content, [{ tag: 'future-text', text: 'Must not silently disappear' }]] }),
    payload('media-node', { ...post, content: [...post.content, [{ tag: 'img', image_key: 'original-image' }]] }),
    payload('ambiguous-locales', { zh_cn: post, en_us: { ...post, title: 'Different original title' } }),
    payload('unknown-locale', { future_locale: post }),
    payload('unknown-field', { ...post, future_body: 'Must not silently disappear' }),
    payload('different-content-version', { ...post, content_v2: [[{ tag: 'md', text: '**Unprojected original body**' }]] }),
    payload('unequal-text-projections', { ...post, content_v2: [...post.content, [{ tag: 'text', text: 'Additional original body' }]] }),
    payload('malformed-text', { ...post, content: [[{ tag: 'text', text: ['not', 'a string'] }]] }),
    payload('duplicate-mention-key', at, [{ key: '@_user_1', id: { open_id: botOpenId } }, { key: '@_user_1', id: { open_id: 'other-open-id' } }])
  ]
  const outside = [
    payload('mention-without-node', { title: '原Bot', content: [[{ tag: 'text', text: '<at user_id="' + botOpenId + '">原Bot</at>' }]] }),
    payload('wrong-key', at, [{ key: '@_user_2', id: { open_id: botOpenId }, name: '原Bot' }]),
    payload('outbound-id-in-node', { content: [[{ tag: 'at', user_id: botOpenId, user_name: '原Bot' }]] }),
    payload('wrong-id-namespace', at, [{ key: '@_user_1', id: { open_id: 'other-open-id', user_id: botOpenId }, name: '原Bot' }]),
    payload('display-name-only', at, [{ key: '@_user_1', id: { open_id: 'other-open-id' }, name: '原Bot' }]),
    payload('no-key', at, [{ id: { open_id: botOpenId }, name: '原Bot' }])
  ]
  for (const original of [...unsupported, ...outside]) {
    await f.sdk.receive(original)
    const code = unsupported.includes(original) ? 'INGRESS_CONTENT_UNSUPPORTED' : 'INGRESS_INPUT_OUTSIDE_SCOPE'
    await vi.waitFor(async () => expect(await f.received(original.event.message.message_id)).toMatchObject({ state: 'refused', code }))
    const persisted = f.services.database!.prepare('SELECT raw_payload FROM connection_ingress_event WHERE event_id=?').get(original.header.event_id)!
    expect(JSON.parse(String(persisted.raw_payload))).toEqual(original)
    expect((await f.received(original.event.message.message_id)).input).toBeUndefined()
    expect(f.inner.kernel.input).not.toHaveBeenCalled()
  }
  expect(f.sdk.ack()).toHaveLength(unsupported.length + outside.length)
  expect(f.sdk.ack().every(ack => ack.code === 200)).toBe(true)
  const first = await f.received('unknown-node')
  expect((await f.cli(['ingress', 'inspect', '--ingress', first.ingressId])).ingress).toMatchObject({ state: 'refused', code: 'INGRESS_CONTENT_UNSUPPORTED', body: '' })
  expect(f.remote.messageCalls()).toEqual([])
  await f.sdk.receive(payload('healthy-after-refusals'))
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(await f.received('healthy-after-refusals')).toMatchObject({ state: 'claimed', body })
  expect(f.client.agentSession(f.session.agentSessionId).run).toEqual(f.session.run)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 25_000)
