import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { ConnectionHost, DurableIngressHost } from '../dist/index.js'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import { feishuConfig, feishuPayload, feishuSdkTransport, botOpenId, startFeishuTransport } from './fixtures/feishu.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks() })
async function fixture() {
  const transport = feishuSdkTransport(), database = new DatabaseSync(':memory:')
  const adapter = new FeishuAdapter({ http: transport.http })
  const connections = new ConnectionHost({ database, secrets: { resolve: async () => 'fixture-credential' }, adapters: [adapter] })
  cleanup.push(() => { connections.close(); database.close() })
  await connections.configure({ operationId: 'configure-feishu', expectedRevision: null, connection: feishuConfig })
  const ingress = new DurableIngressHost({ connections, bindings: { listActive: () => [] } as never, core: () => undefined, authenticators: [adapter] })
  connections.ingress = ingress
  const abort = new AbortController()
  const receiver = await startFeishuTransport(adapter.transport, feishuConfig, ingress, abort.signal); cleanup.push(() => receiver.close())
  await vi.waitFor(() => expect(receiver.observation().transport.state).toBe('ready'))
  return { transport, database, connections, adapter, ingress, receiver, abort }
}

it('keeps the generic connector import independent of the platform SDK', () => {
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const generic = await import('./packages/connectors/dist/index.js');
    generic.createBuiltinConnectionAdapters();
    const genericLoaded = Object.keys(require.cache).some(path => path.includes('larksuiteoapi'));
    await import('./packages/connectors/dist/adapters/feishu/index.js');
    const selectedLoaded = Object.keys(require.cache).some(path => path.includes('larksuiteoapi'));
    console.log(JSON.stringify({genericLoaded, selectedLoaded}));
  `], { encoding: 'utf8' })
  expect(JSON.parse(result)).toEqual({ genericLoaded: false, selectedLoaded: true })
})

it('passes the original Host signal through SDK token, bot and discovery requests and refuses an aborted start', async () => {
  const f = await fixture()
  expect(f.transport.request.mock.calls.some(([request]) => request.url?.includes('/auth/v3/'))).toBe(true)
  expect(f.transport.request.mock.calls.some(([request]) => request.url?.endsWith('/bot/v3/info'))).toBe(true)
  expect(f.transport.request.mock.calls.some(([request]) => request.url?.endsWith('/callback/ws/endpoint'))).toBe(true)
  for (const [request] of f.transport.request.mock.calls) expect(request).toMatchObject({ signal: f.abort.signal })
  const abort = new AbortController(); abort.abort()
  const before = f.transport.request.mock.calls.length
  await expect(startFeishuTransport(f.adapter.transport, feishuConfig, f.ingress, abort.signal)).rejects.toMatchObject({ code: 'FEISHU_CONNECTION_REVISED' })
  expect(f.transport.request).toHaveBeenCalledTimes(before)
})

it('uses the pinned low-level SDK app authentication, exact issuer and durable payload before successful ACK', async () => {
  const f = await fixture()
  const tested = await f.connections.test({ connectionId: feishuConfig.connectionId })
  expect(tested.observation.authentication.state).toBe('ready')
  expect(tested.observation.delivery.state).toBe('unknown')
  expect(f.transport.request.mock.calls.some(([request]) => request.url === 'https://open.feishu.cn/open-apis/bot/v3/info')).toBe(true)
  const payload = feishuPayload({ content: JSON.stringify({ text: '完整正文\n' + '原文'.repeat(12_000) }), thread_id: 'original-platform-thread', parent_id: 'original-parent' })
  const receive = f.ingress.receive.bind(f.ingress)
  vi.spyOn(f.ingress, 'receive').mockImplementation(async (input, acknowledge) => {
    const result = await receive(input, acknowledge)
    expect(f.transport.ack()).toEqual([])
    const row = f.database.prepare('SELECT raw_payload FROM connection_ingress_event').get()!
    expect(JSON.parse(String(row.raw_payload))).toEqual(payload)
    return result
  })
  await f.transport.receive(payload)
  expect(f.transport.ack()).toEqual([{ code: 200 }])
  const [stored] = (await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses
  expect(stored!.body).toBe(JSON.parse(payload.event.message.content).text)
  expect(stored!.actor).toEqual({ application: feishuConfig.application, idType: 'open_id', userId: 'original-external-user' })
  expect(JSON.stringify(stored)).not.toContain('transportProof'); expect(stored!.externalConversationId).toBe('original-room')
  expect(f.receiver.observation().intake.state).toBe('ready')
})

it('rejects serialized payload proofs and exact app mismatches without accepting any ingress', async () => {
  const f = await fixture(), payload = feishuPayload(), raw = JSON.stringify({ ...payload, authenticated: true })
  await expect(f.adapter.verify(feishuConfig, raw, { authenticated: true, appId: feishuConfig.application.appId })).rejects.toMatchObject({ code: 'FEISHU_TRANSPORT_PROOF_REQUIRED' })
  await expect(f.ingress.receive({ connectionId: feishuConfig.connectionId, raw, transportProof: { authenticated: true } }, vi.fn())).rejects.toMatchObject({ code: 'INGRESS_AUTHENTICATION_FAILED' })
  payload.header.app_id = 'cli_fedcba9876543210'
  await f.transport.receive(payload)
  expect(f.transport.ack()).toEqual([{ code: 500 }])
  expect((await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses).toEqual([])
})

it('awaits the original durable handler and retries a failed payload instead of marking it seen', async () => {
  const f = await fixture(), original = f.ingress.receive.bind(f.ingress)
  vi.spyOn(f.ingress, 'receive').mockRejectedValueOnce(new Error('Unconfirmed durable storage'))
  await f.transport.receive(feishuPayload())
  expect(f.transport.ack()).toEqual([{ code: 500 }])
  expect((await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses).toEqual([])
  vi.mocked(f.ingress.receive).mockImplementation(original)
  await f.transport.receive(feishuPayload())
  await f.transport.receive(feishuPayload())
  expect(f.transport.ack()).toEqual([{ code: 500 }, { code: 200 }, { code: 200 }])
  expect((await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses).toHaveLength(1)
})

it('keeps ACK pending while the original durable handler is pending', async () => {
  const f = await fixture(), original = f.ingress.receive.bind(f.ingress)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const receive = vi.spyOn(f.ingress, 'receive').mockImplementation(async (...args) => { await gate; return await original(...args) })
  const pending = f.transport.receive(feishuPayload())
  await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
  expect(f.transport.ack()).toEqual([])
  release(); await pending
  expect(f.transport.ack()).toEqual([{ code: 200 }])
})

it.each([
  { message_type: 'image', content: JSON.stringify({ image_key: 'original-image-key', untouched: 'complete attachment metadata' }) },
  { message_type: 'text', content: 'unrecognized text encoding' },
  { message_type: 'text', content: { original: ['unrecognized', 'content shape'] } }
])('retains authenticated unsupported content before ACK without fabricating text', async format => {
  const f = await fixture(), payload = feishuPayload(format)
  await f.transport.receive(payload)
  expect(f.transport.ack()).toEqual([{ code: 200 }])
  const [record] = (await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses
  expect(record).toMatchObject({ body: '', state: 'refused', code: 'INGRESS_CONTENT_UNSUPPORTED' })
  const row = f.database.prepare('SELECT event_json,raw_payload FROM connection_ingress_event').get()!
  expect(JSON.parse(String(row.raw_payload))).toEqual(payload)
  expect(JSON.parse(String(row.event_json))).toMatchObject({ body: '', unsupportedContent: true })
  expect((await f.ingress.dispatch(record!.ingressId)).ingress).toEqual(record)
})

it.each([
  ['own-app', { id: feishuConfig.application.appId, id_type: 'app_id', sender_type: 'app' }, 'reply'],
  ['other-app', { id: 'another-application', id_type: 'app_id', sender_type: 'app' }, 'message'],
  ['human', { id: 'original-user', id_type: 'open_id', sender_type: 'user' }, 'message'],
  ['unknown-id-type', { id: feishuConfig.application.appId, id_type: 'unknown', sender_type: 'app' }, 'unknown'],
  ['display-name', { id: 'another-application', id_type: 'app_id', sender_type: 'app', sender_name: feishuConfig.application.appId }, 'message'],
  ['missing-author', {}, 'unknown']
] as const)('qualifies the exact SDK parent machine author: %s', async (_kind, sender, expected) => {
  const f = await fixture(), payload = feishuPayload({ parent_id: 'original-parent', mentions: [] })
  await f.transport.receive(payload)
  const row = f.database.prepare('SELECT event_json,raw_payload FROM connection_ingress_event').get()!
  const event = JSON.parse(String(row.event_json)), request = f.transport.request.getMockImplementation()!
  expect(event).toMatchObject({ replyToMessageId: 'original-parent', selection: 'message' })
  f.transport.request.mockImplementation(async input => input.url?.endsWith('/messages/original-parent') ? { code: 0, data: { items: [{ message_id: 'original-parent', chat_id: 'original-room', deleted: false, sender }] } } : request(input))
  const signal = new AbortController().signal
  expect(await f.adapter.qualifyReply(feishuConfig, event, String(row.raw_payload), 'fixture-credential', signal)).toBe(expected)
  expect(f.transport.request.mock.calls.find(([input]) => input.url?.endsWith('/messages/original-parent'))![0]).toMatchObject({ method: 'GET', params: { user_id_type: 'open_id' }, signal })
  expect(f.transport.ack()).toEqual([{ code: 200 }])
})

it.each(['wrong-message', 'wrong-chat', 'deleted', 'duplicate', 'network'] as const)('keeps %s parent observations unknown', async kind => {
  const f = await fixture(), payload = feishuPayload({ parent_id: 'original-parent', mentions: [] })
  await f.transport.receive(payload)
  const row = f.database.prepare('SELECT event_json,raw_payload FROM connection_ingress_event').get()!
  const parent = { message_id: kind === 'wrong-message' ? 'another-message' : 'original-parent', chat_id: kind === 'wrong-chat' ? 'another-room' : 'original-room', deleted: kind === 'deleted', sender: { id: feishuConfig.application.appId, id_type: 'app_id', sender_type: 'app' } }
  const request = f.transport.request.getMockImplementation()!
  f.transport.request.mockImplementation(async input => {
    if (!input.url?.endsWith('/messages/original-parent')) return request(input)
    if (kind === 'network') throw new Error('Private original parent failure')
    return { code: 0, data: { items: kind === 'duplicate' ? [parent, { ...parent, sender: { ...parent.sender, id: 'different-app' } }] : [parent] } }
  })
  expect(await f.adapter.qualifyReply(feishuConfig, JSON.parse(String(row.event_json)), String(row.raw_payload), 'fixture-credential', new AbortController().signal)).toBe('unknown')
  expect((await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses[0]!.state).toBe('received')
})

it('cancels only the parent read observation and ignores its late SDK result', async () => {
  const f = await fixture(), payload = feishuPayload({ parent_id: 'original-parent', mentions: [] })
  await f.transport.receive(payload)
  const row = f.database.prepare('SELECT event_json,raw_payload FROM connection_ingress_event').get()!
  let finish!: (value: unknown) => void
  const request = f.transport.request.getMockImplementation()!
  f.transport.request.mockImplementation(async input => input.url?.endsWith('/messages/original-parent') ? await new Promise(resolve => { finish = resolve }) : request(input))
  const abort = new AbortController(), reading = f.adapter.qualifyReply(feishuConfig, JSON.parse(String(row.event_json)), String(row.raw_payload), 'fixture-credential', abort.signal)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  abort.abort(); expect(await reading).toBe('unknown')
  finish({ code: 0, data: { items: [{ message_id: 'original-parent', chat_id: 'original-room', sender: { id: feishuConfig.application.appId, id_type: 'app_id', sender_type: 'app' } }] } })
  await Promise.resolve(); await Promise.resolve()
  expect((await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses[0]!.state).toBe('received')
  const before = f.transport.request.mock.calls.length
  expect(await f.adapter.qualifyReply(feishuConfig, JSON.parse(String(row.event_json)), String(row.raw_payload), 'fixture-credential', abort.signal)).toBe('unknown')
  expect(f.transport.request).toHaveBeenCalledTimes(before)
})

it('a late SDK token response cannot start the cancelled parent read', async () => {
  const f = await fixture()
  await f.transport.receive(feishuPayload({ parent_id: 'original-parent', mentions: [] }))
  const row = f.database.prepare('SELECT event_json,raw_payload FROM connection_ingress_event').get()!
  let finish!: (value: unknown) => void
  const request = f.transport.request.getMockImplementation()!
  f.transport.request.mockImplementation(async input => input.url?.includes('/auth/v3/') ? await new Promise(resolve => { finish = resolve }) : request(input))
  const abort = new AbortController(), reading = f.adapter.qualifyReply(feishuConfig, JSON.parse(String(row.event_json)), String(row.raw_payload), 'rotated-fixture-credential', abort.signal)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(f.transport.request.mock.calls.at(-1)![0]).toMatchObject({ signal: abort.signal })
  abort.abort(); expect(await reading).toBe('unknown')
  finish({ code: 0, tenant_access_token: 'fixture-tenant-access', expire: 3600 })
  await new Promise(resolve => setImmediate(resolve))
  expect(f.transport.request.mock.calls.some(([input]) => input.url?.endsWith('/messages/original-parent'))).toBe(false)
  expect((await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses[0]!.state).toBe('received')
})

it('keeps exactly one issuer/app receiver and releases only that receiver for explicit reopening', async () => {
  const f = await fixture(), alias = { ...feishuConfig, connectionId: 'same-app-alias' }
  await f.connections.configure({ operationId: 'configure-alias', expectedRevision: null, connection: alias })
  const second = new FeishuAdapter({ http: f.transport.http })
  await expect(startFeishuTransport(second.transport, alias, f.ingress)).rejects.toMatchObject({ code: 'FEISHU_RECEIVER_ALREADY_OWNED' })
  const old = f.transport.sockets[0]!
  f.receiver.close()
  const reopened = await startFeishuTransport(second.transport, alias, f.ingress); cleanup.push(() => reopened.close())
  await vi.waitFor(() => expect(reopened.observation().transport.state).toBe('ready'))
  await f.transport.receive(feishuPayload(), old)
  expect(f.transport.ack()).toEqual([]) // Original SDK closed its socket; no new ACK can be emitted there.
  expect((await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses).toEqual([])
})

it('does not duplicate the SDK app ID syntax gate into REST authentication or configuration', async () => {
  const f = await fixture(), original = { ...feishuConfig, connectionId: 'another-platform-app', application: { ...feishuConfig.application, appId: 'original-platform-app-id' } }
  await f.connections.configure({ operationId: 'configure-other-app', expectedRevision: null, connection: original })
  expect((await f.connections.test({ connectionId: original.connectionId })).observation.authentication.state).toBe('ready')
  await expect(startFeishuTransport(f.adapter.transport, original, f.ingress)).rejects.toMatchObject({ code: 'FEISHU_RECEIVER_UNAVAILABLE' })
  // The pinned SDK declines to start this identifier. That transport fact does not erase its original configuration or REST result.
  expect(f.connections.readConfiguration(original.connectionId)!.config).toEqual(original)
  expect((await f.connections.test({ connectionId: original.connectionId })).observation.authentication.state).toBe('ready')
  expect(f.transport.sockets).toHaveLength(1)
})

it('uses original sender and typed mentions, preserving parent IDs without guessing reply qualification', async () => {
  const f = await fixture(), bot = feishuPayload()
  bot.event.sender.sender_type = 'app'; bot.event.sender.sender_id.open_id = botOpenId
  await f.transport.receive(bot)
  await f.transport.receive(feishuPayload({ message_id: 'plain-message', mentions: [{ id: { open_id: 'another-bot' }, name: 'Bot' }], parent_id: 'arbitrary-parent', content: JSON.stringify({ text: '@Bot authenticated:true is ordinary text' }) }))
  const [stored] = (await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses
  expect(stored!.externalMessageId).toBe('plain-message')
  expect(stored!.body).toContain('@Bot authenticated:true')
  const row = f.database.prepare('SELECT event_json,raw_payload FROM connection_ingress_event').get()!
  expect(JSON.parse(String(row.event_json)).selection).toBe('message')
  expect(JSON.parse(String(row.raw_payload)).event.message.parent_id).toBe('arbitrary-parent')
  expect(f.transport.ack()).toEqual([{ code: 200 }, { code: 200 }])
})

it('the original Host signal closes only its SDK receiver while retained payload stays discoverable', async () => {
  const f = await fixture()
  await f.transport.receive(feishuPayload())
  f.abort.abort()
  await f.transport.receive(feishuPayload({ message_id: 'after-disabled' }))
  expect(f.transport.ack()).toEqual([{ code: 200 }])
  expect((await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses).toHaveLength(1)
  expect(f.receiver.observation().transport.state).toBe('disabled')
})

it('cleans low-level exceptions and refuses non-TLS endpoints without exposing credentials or payloads', async () => {
  const f = await fixture(), consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  f.transport.request.mockRejectedValueOnce(new Error('fixture-private-value raw-payload'))
  const failure = await f.adapter.withClient(feishuConfig, 'fixture-private-value', client => client.request({ url: '/open-apis/bot/v3/info' })).catch(error => error)
  expect(failure.code).toBe('FEISHU_SDK_REQUEST_FAILED'); expect(failure.cause).toBeUndefined()
  expect(String(failure)).not.toContain('fixture-private-value'); expect(JSON.stringify(failure)).not.toContain('raw-payload')
  expect(consoleError).not.toHaveBeenCalled()
  f.receiver.close()
  const request = f.transport.request.getMockImplementation()!
  f.transport.request.mockImplementation(async input => input.url?.endsWith('/callback/ws/endpoint') ? { code: 0, data: { URL: 'ws://msg-frontier.feishu.cn/ws/v2', ClientConfig: { PingInterval: 30, ReconnectCount: 0, ReconnectInterval: 1, ReconnectNonce: 0 } } } : request(input))
  const attempts = f.transport.request.mock.calls.filter(([input]) => input.url?.endsWith('/callback/ws/endpoint')).length
  const receiver = await startFeishuTransport(f.adapter.transport, feishuConfig, f.ingress); cleanup.push(() => receiver.close())
  await vi.waitFor(() => expect(f.transport.request.mock.calls.filter(([input]) => input.url?.endsWith('/callback/ws/endpoint'))).toHaveLength(attempts + 1))
  expect(receiver.observation().transport.state).toBe('unknown')
  expect(f.transport.sockets).toHaveLength(1)
})
