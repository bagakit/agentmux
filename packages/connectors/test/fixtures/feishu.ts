import { vi } from 'vitest'
import { WSClient, type HttpInstance } from '@larksuiteoapi/node-sdk'
import type { ConnectionConfig } from '@agentmux/core/connections'

export const feishuConfig: ConnectionConfig = { connectionId: 'feishu-connection', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_0123456789abcdef' }, label: 'Team bot', enabled: true, credentialRef: 'host-credential' }
export const botOpenId = 'original-bot-open-id'
export function feishuPayload(overrides: Record<string, unknown> = {}) {
  return { schema: '2.0', header: { app_id: feishuConfig.application.appId, event_id: 'platform-event', event_type: 'im.message.receive_v1', tenant_key: 'original-tenant', extension: { retained: 'complete header' } },
    event: { sender: { sender_type: 'user', sender_id: { open_id: 'original-external-user', user_id: 'different-id-namespace' } },
      message: { message_id: 'platform-message', chat_id: 'original-room', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'Original group text\nEvery line remains.' }), create_time: '1', mentions: [{ key: '@_user_1', id: { open_id: botOpenId }, name: 'Bot' }], ...overrides },
      extension: { retained: ['complete', 'event'] } }, extra: { opaque: 'retained original extension' } }
}
type InternalWs = { wsConfig: { setWSInstance(socket: unknown): void }; handleEventData(frame: unknown): Promise<void>; sendMessage(frame: unknown): void }
/** Controls transport I/O only. Endpoint discovery, dispatcher, handler-await and ACK construction remain the pinned SDK. */
export function feishuSdkTransport() {
  const sockets: WSClient[] = [], frames: Array<{ owner: WSClient; frame: { payload?: Uint8Array } }> = []
  const originalSend = (WSClient.prototype as unknown as InternalWs).sendMessage
  vi.spyOn(WSClient.prototype as unknown as InternalWs, 'sendMessage').mockImplementation(function(this: WSClient, frame: unknown) {
    if (this.getConnectionStatus().state === 'connected') frames.push({ owner: this, frame: structuredClone(frame) as { payload?: Uint8Array } })
    return originalSend.call(this, frame)
  })
  vi.spyOn(WSClient.prototype as unknown as { connect(): Promise<boolean> }, 'connect').mockImplementation(async function(this: WSClient) {
    sockets.push(this)
    const socket = { readyState: 1, on: vi.fn(), removeAllListeners: vi.fn(), terminate: vi.fn(), close: vi.fn(), send: vi.fn() }
    ;(this as unknown as InternalWs).wsConfig.setWSInstance(socket)
    return true
  })
  const request = vi.fn(async (input: { url?: string }) => {
    if (input.url?.endsWith('/callback/ws/endpoint')) return { code: 0, data: { URL: 'wss://msg-frontier.feishu.cn/ws/v2?device_id=original&service_id=1', ClientConfig: { PingInterval: 30, ReconnectCount: 0, ReconnectInterval: 1, ReconnectNonce: 0 } } }
    if (input.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: botOpenId } }
    if (input.url?.includes('/auth/v3/')) return { code: 0, tenant_access_token: 'fixture-tenant-access', app_access_token: 'fixture-app-access', expire: 3600 }
    throw new Error('Unexpected protocol request')
  })
  const http = { request, post: (url: string, data: unknown) => request({ url, data } as { url: string }) } as unknown as HttpInstance
  const ack = () => frames.filter(entry => entry.frame.payload).map(entry => JSON.parse(new TextDecoder().decode(entry.frame.payload)))
  async function receive(payload: unknown, owner = sockets.at(-1)!) {
    const data = new TextEncoder().encode(JSON.stringify(payload))
    await (owner as unknown as InternalWs).handleEventData({ SeqID: 1, LogID: 1, service: 1, method: 1,
      headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'wire-message' }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }], payload: data })
  }
  return { http, request, sockets, frames, ack, receive }
}
