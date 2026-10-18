import { fixtureEpoch as _privacyFixtureEpoch } from "../../../../test/fixture-values.mjs"
import { createServer } from 'node:http'
import { feishuSdkTransport } from './feishu.js'
import type { DiscordHttpOptions } from '../../src/adapters/discord/client.js'

export const feishuHistoryMessage = (id: string, time: number, fields: Record<string, unknown> = {}) => ({ message_id: id, chat_id: 'original-room', msg_type: 'text', create_time: String(time), update_time: String(time),
  sender: { id: 'original-native-person', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text: 'Native ' + id }) }, ...fields })

/** Only SDK HTTP/WebSocket I/O is controlled; the pinned SDK owns credentials and query encoding. */
export function feishuHistoryTransport(messages: ReturnType<typeof feishuHistoryMessage>[], threadMessages: Record<string, ReturnType<typeof feishuHistoryMessage>[]> = {}) {
  const transport = feishuSdkTransport(), fallback = transport.request.getMockImplementation()!
  const requests: Array<{ url?: string; params?: Record<string, unknown> }> = []
  let override: ((input: { url?: string; params?: Record<string, unknown> }) => unknown) | undefined
  transport.request.mockImplementation(async raw => {
    const input = raw as { url?: string; params?: Record<string, unknown> }; requests.push(structuredClone(input))
    const custom = override?.(input); if (custom !== undefined) return await custom as never
    const path = new URL(input.url!, 'https://open.feishu.cn').pathname
    if (path === '/open-apis/im/v1/messages') {
      const query = input.params!, rows = query.container_id_type === 'thread' ? threadMessages[String(query.container_id)] ?? [] : messages
      const start = Number(query.page_token ?? 0), size = Number(query.page_size), page = rows.slice(start, start + size)
      return { code: 0, data: { items: page, has_more: start + size < rows.length, ...(start + size < rows.length ? { page_token: String(start + size) } : {}) } } as never
    }
    if (path.startsWith('/open-apis/im/v1/messages/')) {
      const id = decodeURIComponent(path.split('/').at(-1)!), message = [...messages, ...Object.values(threadMessages).flat()].find(item => item.message_id === id)
      return (message ? { code: 0, data: { items: [message] } } : { code: 230110 }) as never
    }
    return await fallback(raw)
  })
  return { ...transport, requests, override: (value: typeof override) => { override = value } }
}

export const discordHistoryMessage = (id: string, fields: Record<string, unknown> = {}) => ({ id, channel_id: '300', type: 0, timestamp: new Date(_privacyFixtureEpoch(20454, 0)).toISOString(), edited_timestamp: null,
  content: 'Native ' + id, author: { id: '400', username: 'Original person' }, attachments: [], embeds: [], ...fields })

/** Real pinned REST SDK and HTTP serialization, with deterministic native pages. */
export async function discordHistoryTransport(messages: ReturnType<typeof discordHistoryMessage>[]) {
  const requests: Array<{ path: string; query: Record<string, string> }> = []
  let flags = 524288, override: ((path: string, query: URLSearchParams) => unknown) | undefined
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://native'), path = url.pathname.replace(/^\/api\/v10/u, '')
    requests.push({ path, query: Object.fromEntries(url.searchParams) })
    let result = override?.(path, url.searchParams), status = 200
    if (result === undefined) {
      if (path === '/oauth2/applications/@me') result = { id: '100', flags, bot: { id: '200' } }
      else if (path === '/channels/300/messages') result = messages.filter(item => BigInt(item.id) < BigInt(url.searchParams.get('before')!)).slice(0, Number(url.searchParams.get('limit')))
      else if (path.startsWith('/channels/300/messages/')) {
        result = messages.find(item => item.id === path.split('/').at(-1))
        if (!result) { status = 404; result = { code: 10008, message: 'Unknown Message' } }
      } else { status = 404; result = { code: 10003, message: 'Unknown Channel' } }
    }
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const http: DiscordHttpOptions = { makeRequest: async (url, init) => {
    const original = new URL(url); if (original.origin !== 'https://discord.com') throw Error('Unexpected native origin')
    return await fetch(origin + original.pathname + original.search, init as RequestInit)
  } }
  return { http, requests, flags: (value: number) => { flags = value }, override: (value: typeof override) => { override = value },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
