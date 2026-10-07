import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { ConnectionHost, DurableIngressHost } from '../dist/index.js'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import { feishuConfig, feishuPayload, feishuSdkTransport, botOpenId } from './fixtures/feishu.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks() })
async function fixture() {
  const transport = feishuSdkTransport(), database = new DatabaseSync(':memory:')
  let connections: ConnectionHost
  const adapter = new FeishuAdapter({ connections: { readConfiguration: id => connections.readConfiguration(id) }, http: transport.http })
  connections = new ConnectionHost({ database, secrets: { resolve: async () => 'fixture-credential' }, adapters: [adapter] })
  cleanup.push(() => { connections.close(); database.close() })
  await connections.configure({ operationId: 'configure-feishu', expectedRevision: null, connection: feishuConfig })
  const ingress = new DurableIngressHost({ connections, bindings: { listActive: () => [] } as never, core: () => undefined, authenticators: [adapter] })
  connections.ingress = ingress
  const receiver = await adapter.openReceiver(feishuConfig, 'fixture-credential', ingress); cleanup.push(() => receiver.close())
  await vi.waitFor(() => expect(receiver.observation().transport.state).toBe('ready'))
  return { transport, database, connections, adapter, ingress, receiver }
}

it('keeps the generic connector import independent of the platform SDK', () => {
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    await import('./packages/connectors/dist/index.js');
    const genericLoaded = Object.keys(require.cache).some(path => path.includes('larksuiteoapi'));
    await import('./packages/connectors/dist/adapters/feishu/index.js');
    const selectedLoaded = Object.keys(require.cache).some(path => path.includes('larksuiteoapi'));
    console.log(JSON.stringify({genericLoaded, selectedLoaded}));
  `], { encoding: 'utf8' })
  expect(JSON.parse(result)).toEqual({ genericLoaded: false, selectedLoaded: true })
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

it('keeps exactly one issuer/app receiver and releases only that receiver for explicit reopening', async () => {
  const f = await fixture(), alias = { ...feishuConfig, connectionId: 'same-app-alias' }
  await f.connections.configure({ operationId: 'configure-alias', expectedRevision: null, connection: alias })
  const second = new FeishuAdapter({ connections: f.connections, http: f.transport.http })
  await expect(second.openReceiver(alias, 'fixture-credential', f.ingress)).rejects.toMatchObject({ code: 'FEISHU_RECEIVER_ALREADY_OWNED' })
  const old = f.transport.sockets[0]!
  f.receiver.close()
  const reopened = await second.openReceiver(alias, 'fixture-credential', f.ingress); cleanup.push(() => reopened.close())
  await vi.waitFor(() => expect(reopened.observation().transport.state).toBe('ready'))
  await f.transport.receive(feishuPayload(), old)
  expect(f.transport.ack()).toEqual([]) // Original SDK closed its socket; no new ACK can be emitted there.
  expect((await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses).toEqual([])
})

it('does not duplicate the SDK app ID syntax gate into REST authentication or configuration', async () => {
  const f = await fixture(), original = { ...feishuConfig, connectionId: 'another-platform-app', application: { ...feishuConfig.application, appId: 'original-platform-app-id' } }
  await f.connections.configure({ operationId: 'configure-other-app', expectedRevision: null, connection: original })
  expect((await f.connections.test({ connectionId: original.connectionId })).observation.authentication.state).toBe('ready')
  await expect(f.adapter.openReceiver(original, 'fixture-credential', f.ingress)).rejects.toMatchObject({ code: 'FEISHU_RECEIVER_UNAVAILABLE' })
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

it('configuration changes reject only the old callback while the original payload remains discoverable', async () => {
  const f = await fixture()
  await f.transport.receive(feishuPayload())
  await f.connections.configure({ operationId: 'disable-feishu', expectedRevision: 1, connection: { ...feishuConfig, enabled: false } })
  await f.transport.receive(feishuPayload({ message_id: 'after-disabled' }))
  expect(f.transport.ack()).toEqual([{ code: 200 }, { code: 500 }])
  expect((await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses).toHaveLength(1)
  expect(f.receiver.observation().transport.state).toBe('unknown')
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
  const receiver = await f.adapter.openReceiver(feishuConfig, 'fixture-credential', f.ingress); cleanup.push(() => receiver.close())
  await vi.waitFor(() => expect(f.transport.request.mock.calls.filter(([input]) => input.url?.endsWith('/callback/ws/endpoint'))).toHaveLength(attempts + 1))
  expect(receiver.observation().transport.state).toBe('unknown')
  expect(f.transport.sockets).toHaveLength(1)
})
