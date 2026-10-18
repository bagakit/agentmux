import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { DiscordHttpOptions } from '../../src/adapters/discord/client.js'

export const discordConfig = { connectionId: 'discord-connection', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' }, label: 'Discord bot', enabled: true, credentialRef: 'discord-credential' }
export const discordBotId = '200', discordUserId = '400', discordRoomId = '300'
/** Real pinned REST and Gateway SDKs talk to these controlled HTTP/WebSocket leaves. */
export async function discordTransport() {
  const calls: Array<{ method: string; path: string; body: string; contentType: string }> = [], messages = new Map<string, Record<string, unknown>>()
  const sessions: Array<{ op: number; data: Record<string, unknown> }> = [], sockets = new Set<WebSocket>()
  let sequence = 0, nextMessage = 1000, dropNextResponse = false
  const emit = (event: string, data: unknown) => { const payload = JSON.stringify({ op: 0, t: event, s: ++sequence, d: data }); for (const socket of sockets) if (socket.readyState === 1) socket.send(payload); return sequence }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const url = new URL(request.url!, 'http://native'), path = url.pathname.replace(/^\/api\/v10/u, ''), body = Buffer.concat(chunks).toString('utf8')
    const call = { method: request.method!, path, body, contentType: String(request.headers['content-type'] ?? '') }; calls.push(call)
    let status = 200, result: unknown
    if (path === '/oauth2/applications/@me') result = { id: '100', name: 'Application', bot: { id: discordBotId, username: 'Original bot', avatar: null } }
    else if (path === '/gateway/bot') result = { url: gateway, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 60000, max_concurrency: 1 } }
    else if (path === '/users/' + discordUserId) result = { id: discordUserId, username: 'original-user', global_name: 'Original person', avatar: 'native_avatar' }
    else if (path === '/channels/' + discordRoomId) result = { id: discordRoomId, type: 0, guild_id: '500', name: 'Original channel' }
    else if (path === `/channels/${discordRoomId}/messages` && request.method === 'POST') {
      const parsed = JSON.parse(body), id = String(++nextMessage)
      result = { ...parsed, id, channel_id: discordRoomId, author: { id: discordBotId, bot: true }, attachments: [] }
      messages.set(id, result as Record<string, unknown>); emit('MESSAGE_CREATE', result)
      if (dropNextResponse) { dropNextResponse = false; request.socket.destroy(); return }
    } else if (path.startsWith(`/channels/${discordRoomId}/messages/`)) {
      const id = path.split('/').at(-1)!, original = messages.get(id)
      if (!original) { status = 404; result = { message: 'Unknown Message', code: 10008 } }
      else if (request.method === 'DELETE') { messages.delete(id); status = 204 }
      else if (request.method === 'PATCH') { result = { ...original, ...JSON.parse(body) }; messages.set(id, result as Record<string, unknown>) }
      else result = original
    } else { status = 404; result = { message: 'Unknown route', code: 0 } }
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(result === undefined ? undefined : JSON.stringify(result))
  })
  const websocket = new WebSocketServer({ server })
  let gateway = ''
  websocket.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }))
    socket.on('message', raw => {
      const payload = JSON.parse(raw.toString())
      if (payload.op === 1) socket.send(JSON.stringify({ op: 11, d: null }))
      else if (payload.op === 2 || payload.op === 6) {
        sessions.push({ op: payload.op, data: payload.d })
        if (payload.op === 6) emit('RESUMED', {})
        else emit('READY', { v: 10, user: { id: discordBotId, username: 'Original bot', bot: true }, guilds: [], session_id: 'original-gateway-session', resume_gateway_url: gateway, application: { id: '100', flags: 0 } })
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; gateway = origin.replace('http:', 'ws:')
  const http: DiscordHttpOptions = { makeRequest: async (url, init) => {
    const original = new URL(url)
    if (original.origin !== 'https://discord.com') throw Error('Unexpected native Discord API origin')
    return await fetch(origin + original.pathname + original.search, init as RequestInit)
  } }
  return { http, calls, sessions, messages, emit,
    message(id = '700', content = 'Original Discord input\nEvery line') { const message = { id, channel_id: discordRoomId, guild_id: '500', type: 0, content, author: { id: discordUserId, username: 'original-user', global_name: 'Original person', avatar: 'native_avatar' }, mentions: [{ id: discordBotId }], attachments: [], embeds: [] }; emit('MESSAGE_CREATE', message); return message },
    loseNextMessageResponse() { dropNextResponse = true },
    async close() { for (const socket of sockets) socket.terminate(); websocket.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
}
