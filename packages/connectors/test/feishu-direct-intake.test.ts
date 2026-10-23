import { afterEach, expect, it, vi } from 'vitest'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig, feishuPayload, feishuSdkTransport, startFeishuTransport } from './fixtures/feishu.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
it('the pinned SDK retains native private messages before acknowledging and keeps bot echoes outside human intake', async () => {
  const f = await ingressFixture(true, feishuConfig); cleanup.push(() => f.close())
  const sdk = feishuSdkTransport(), adapter = new FeishuAdapter({ http: sdk.http })
  const ingress = new DurableIngressHost({ ...f.options, authenticators: [adapter] })
  const receiver = await startFeishuTransport(adapter.transport, feishuConfig, ingress, () => f.connections.channelStorage(feishuConfig)); cleanup.push(() => receiver.close())
  await vi.waitFor(() => expect(receiver.observation().transport.state).toBe('ready'))
  const message = feishuPayload({ chat_type: 'p2p', mentions: [], content: JSON.stringify({ text: 'Private message, unchanged.' }) })
  await sdk.receive(message)
  expect(sdk.ack()).toEqual([{ code: 200 }])
  expect((await ingress.list({ connectionId: feishuConfig.connectionId })).ingresses).toMatchObject([
    { state: 'received', conversationKind: 'direct', body: 'Private message, unchanged.', actor: { idType: 'open_id', userId: 'original-external-user' } }
  ])
  const echo = structuredClone(message); echo.header.event_id = 'bot-echo'; echo.event.message.message_id = 'bot-message'; echo.event.sender.sender_type = 'app'
  await sdk.receive(echo)
  expect((await ingress.list({ connectionId: feishuConfig.connectionId })).ingresses).toHaveLength(1)
})
