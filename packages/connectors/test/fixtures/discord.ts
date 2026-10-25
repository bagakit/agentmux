import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { DiscordHttpOptions } from '../../src/adapters/discord/client.js'
export { DefaultRestOptions } from '@discordjs/rest'

export const discordConfig = { connectionId: 'discord-connection', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' }, label: 'Discord bot', enabled: true, credentialRef: 'discord-credential' }
export const discordBotId = '200', discordUserId = '400', discordRoomId = '300'
/** Real pinned REST and Gateway SDKs talk to these controlled HTTP/WebSocket leaves. */
export async function discordTransport(nativeFetch: typeof fetch = fetch) {
  const calls: Array<{ method: string; path: string; body: string; contentType: string }> = [], messages = new Map<string, Record<string, unknown>>()
  const sessions: Array<{ op: number; data: Record<string, unknown> }> = [], sockets = new Set<WebSocket>()
  const paused = new Set<WebSocket>(); let pauseHello = false
  const uploads: Buffer[] = []
  const history = new Map<string, Record<string, unknown>>()
  const historyMessage = (id: string, content: string, observation: Record<string, unknown> = {}) => {
    const message = { id, channel_id: discordRoomId, guild_id: '500', type: 0, content, timestamp: new Date(Number(id)).toISOString(), author: { id: discordUserId, username: 'original-user', global_name: 'Original person', avatar: 'native_avatar' }, mentions: [{ id: discordBotId }], attachments: [], embeds: [], ...observation }
    history.set(id, message); return message
  }
  let channelName = 'Original channel', applicationId = '100'
  const nativeComponents = (value: unknown): unknown => { let id = 0; const assign = (item: unknown): unknown => Array.isArray(item) ? item.map(assign) : item && typeof item === 'object' ? { ...(typeof (item as { type?: unknown }).type === 'number' ? { id: ++id } : {}), ...Object.fromEntries(Object.entries(item).map(([key, child]) => [key, assign(child)])) } : item; return assign(value) }
  const boundedComponents = (value: unknown): boolean => {
    let count = 0, characters = 0
    const read = (item: unknown): void => {
      if (Array.isArray(item)) { item.forEach(read); return }
      if (!item || typeof item !== 'object') return
      const component = item as { type?: number; content?: string; components?: unknown }
      if (typeof component.type === 'number') count++
      if (component.type === 10 && typeof component.content === 'string') characters += component.content.length
      read(component.components)
    }
    read(value); return count <= 40 && characters <= 4000
  }
  let sequence = 0, nextMessage = 1000, dropNextResponse = false, suppressNextEcho = false, dropCallback = false
  const dispatches: Array<{ sequence: number; raw: string }> = []
  const emit = (event: string, data: unknown) => { const payload = JSON.stringify({ op: 0, t: event, s: ++sequence, d: data }); dispatches.push({ sequence, raw: payload }); for (const socket of sockets) if (socket.readyState === 1) socket.send(payload); return sequence }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const url = new URL(request.url!, 'http://native'), path = url.pathname.replace(/^\/api\/v10/u, ''), bytes = Buffer.concat(chunks)
    let body = bytes.toString('utf8')
    const boundary = /boundary=([^;]+)/u.exec(String(request.headers['content-type']))?.[1]
    if (boundary) {
      const field = bytes.indexOf('name=\"payload_json\"'), start = bytes.indexOf('\r\n\r\n', field) + 4, end = bytes.indexOf('\r\n--' + boundary, start)
      body = bytes.subarray(start, end).toString('utf8')
      const file = bytes.indexOf('name=\"files[0]\"'), fileStart = bytes.indexOf('\r\n\r\n', file) + 4, fileEnd = bytes.indexOf('\r\n--' + boundary, fileStart)
      if (field < 0 || file < 0 || fileStart < 4 || fileEnd < fileStart) throw Error('Native SDK multipart fields required')
      uploads.push(bytes.subarray(fileStart, fileEnd))
    }
    const call = { method: request.method!, path, body, contentType: String(request.headers['content-type'] ?? '') }; calls.push(call)
    if (/^\/channels\/300\/messages(?:\/[^/]+)?$/u.test(path) && ['POST', 'PATCH'].includes(request.method!) && !boundedComponents(JSON.parse(body).components)) {
      response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 50035, message: 'Invalid components: total display capacity exceeded' })); return
    }
    let status = 200, result: unknown
    if (path === '/oauth2/applications/@me') result = { id: applicationId, name: 'Application', flags: 524288, bot: { id: discordBotId, username: 'Original bot', avatar: null } }
    else if (path.startsWith('/interactions/') && path.endsWith('/callback')) { if (dropCallback) { dropCallback = false; request.socket.destroy(); return } status = 204 }
    else if (path === '/gateway/bot') result = { url: gateway, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 60000, max_concurrency: 1 } }
    else if (path === '/users/@me/guilds') result = url.searchParams.has('after') ? [] : [{ id: '500', name: 'Original guild' }]
    else if (path === '/guilds/500/channels') result = [{ id: '300', type: 0, name: channelName }, { id: '301', type: 0, name: 'Another channel' }]
    else if (path === '/channels/300/invites' && request.method === 'POST') result = { code: 'original-invite', created_at: new Date().toISOString(), max_age: 604800 }
    else if (path === '/users/' + discordUserId) result = { id: discordUserId, username: 'original-user', global_name: 'Original person', avatar: 'native_avatar' }
    else if (path === '/channels/' + discordRoomId) result = { id: discordRoomId, type: 0, guild_id: '500', name: channelName }
    else if (path === `/channels/${discordRoomId}/messages` && request.method === 'GET') result = [...history.values()].filter(message => !url.searchParams.has('before') || BigInt(String(message.id)) < BigInt(url.searchParams.get('before')!)).sort((a, b) => BigInt(String(a.id)) > BigInt(String(b.id)) ? -1 : 1).slice(0, Number(url.searchParams.get('limit') ?? 50))
    else if (path === `/channels/${discordRoomId}/messages` && request.method === 'POST') {
      const parsed = JSON.parse(body), id = String(++nextMessage)
      result = { ...parsed, components: nativeComponents(parsed.components), id, channel_id: discordRoomId, author: { id: discordBotId, bot: true }, attachments: [] }
      messages.set(id, result as Record<string, unknown>); if (!suppressNextEcho) emit('MESSAGE_CREATE', result); suppressNextEcho = false
      if (dropNextResponse) { dropNextResponse = false; request.socket.destroy(); return }
    } else if (path.startsWith(`/channels/${discordRoomId}/messages/`)) {
      const id = path.split('/').at(-1)!, original = messages.get(id) ?? (request.method === 'GET' ? history.get(id) : undefined)
      if (!original) { status = 404; result = { message: 'Unknown Message', code: 10008 } }
      else if (request.method === 'DELETE') { messages.delete(id); status = 204 }
      else if (request.method === 'PATCH') { const parsed = JSON.parse(body); result = { ...original, ...parsed, components: nativeComponents(parsed.components) }; messages.set(id, result as Record<string, unknown>); if (dropNextResponse) { dropNextResponse = false; request.socket.destroy(); return } }
      else result = original
    } else { status = 404; result = { message: 'Unknown route', code: 0 } }
    response.writeHead(status, status === 204 ? {} : { 'content-type': 'application/json' }); response.end(result === undefined ? undefined : JSON.stringify(result))
  })
  const websocket = new WebSocketServer({ server })
  let gateway = ''
  websocket.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => { sockets.delete(socket); paused.delete(socket) })
    if (pauseHello) paused.add(socket)
    else socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }))
    socket.on('message', raw => {
      const payload = JSON.parse(raw.toString())
      if (payload.op === 1) socket.send(JSON.stringify({ op: 11, d: null }))
      else if (payload.op === 2 || payload.op === 6) {
        sessions.push({ op: payload.op, data: payload.d })
        if (payload.op === 6) { for (const event of dispatches) if (event.sequence > payload.d.seq) socket.send(event.raw); emit('RESUMED', {}) }
        else emit('READY', { v: 10, user: { id: discordBotId, username: 'Original bot', bot: true }, guilds: [], session_id: 'original-gateway-session', resume_gateway_url: gateway, application: { id: '100', flags: 0 } })
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; gateway = origin.replace('http:', 'ws:')
  const http: DiscordHttpOptions = { makeRequest: async (url, init) => {
    const original = new URL(url)
    if (original.origin !== 'https://discord.com') throw Error('Unexpected native Discord API origin')
    return await nativeFetch(origin + original.pathname + original.search, init as RequestInit)
  } }
  return { origin, http, calls, sessions, messages, emit, uploads,
    get pausedConnections() { return paused.size },
    disconnect() { pauseHello = true; for (const socket of sockets) if (socket.readyState === 1) socket.close(4000) },
    resumeGateway() { pauseHello = false; for (const socket of paused) if (socket.readyState === 1) socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } })); paused.clear() },
    changeApplication(id: string) { applicationId = id },
    interaction(id: string, type: 3 | 5, data: Record<string, unknown>, messageId?: string, userId = discordUserId) {
      const value = { id, application_id: discordConfig.application.appId, type, version: 1, token: 'fixture-interaction-token', channel_id: discordRoomId, guild_id: '500', member: { user: { id: userId, username: 'Original person' } }, data, ...(messageId ? { message: messages.get(messageId) } : {}) }
      emit('INTERACTION_CREATE', value); return value
    },
    rename(name: string) { channelName = name; emit('CHANNEL_UPDATE', { id: discordRoomId, guild_id: '500', type: 0, name }) },
    historyMessage,
    message(id = '700', content = 'Original Discord input\nEvery line', observation: Record<string, unknown> = {}) { const message = historyMessage(id, content, observation); emit('MESSAGE_CREATE', message); return message },
    loseNextMessageResponse(witness = true) { dropNextResponse = true; suppressNextEcho = !witness },
    loseNextCallbackResponse() { dropCallback = true },
    async close() { for (const socket of sockets) socket.terminate(); websocket.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
}
