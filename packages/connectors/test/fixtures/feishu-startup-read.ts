import { createServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { defaultHttpInstance, type HttpInstance } from '@larksuiteoapi/node-sdk'
import { feishuSocketTransport } from './feishu-socket.js'
import { botOpenId } from './feishu.js'

type Resource = 'token' | 'bot'
type Policy = { hold?: boolean; delayMs?: number; ignoreAbort?: boolean }
type Read = {
  id: number
  resource: Resource
  method: string
  signal?: AbortSignal
  startedAt: number
  abortedAt?: number
  completedAt?: number
  serverReceived: boolean
  serverClosed: boolean
}

/** Controls only the original startup HTTP resources. SDK Client/token cache,
 * dispatch, real TLS/WebSocket start and Host lifecycle remain product code. */
export async function feishuStartupReadTransport() {
  const wire = await feishuSocketTransport()
  const policy: Record<Resource, Policy> = { token: {}, bot: {} }
  const reads: Read[] = [], pending = new Map<number, ServerResponse>()
  const sockets = new Set<Socket>(), timers = new Set<ReturnType<typeof setTimeout>>()
  const body = (resource: Resource) => resource === 'token'
    ? { code: 0, tenant_access_token: 'fixture-tenant-access', expire: 3600 }
    : { code: 0, bot: { open_id: botOpenId } }
  const answer = (read: Read) => {
    const response = pending.get(read.id)
    if (!response || response.destroyed) return
    pending.delete(read.id)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body(read.resource)))
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost'), id = Number(url.searchParams.get('read'))
    const read = reads.find(read => read.id === id)
    if (!read || url.pathname !== '/' + read.resource) {
      response.writeHead(404); response.end(); return
    }
    read.serverReceived = true; pending.set(id, response)
    response.on('error', () => {}) // A controlled late rejection belongs to the HTTP reader.
    response.once('close', () => { read.serverClosed = true; pending.delete(id) })
    // Consume the official SDK's original token POST body without retaining
    // credentials or complete headers in the fixture evidence.
    request.resume()
    const selected = policy[read.resource]
    if (selected.hold) return
    if (selected.delayMs) {
      const timer = setTimeout(() => { timers.delete(timer); answer(read) }, selected.delayMs)
      timers.add(timer)
    } else answer(read)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Original startup HTTP fixture is unavailable')
  const base = 'http://127.0.0.1:' + address.port
  const request = async (input: Parameters<HttpInstance['request']>[0]) => {
    const resource: Resource | undefined = input.url?.endsWith('/auth/v3/tenant_access_token/internal') ? 'token'
      : input.url?.endsWith('/bot/v3/info') ? 'bot' : undefined
    if (!resource) return await wire.http.request(input)
    const signal = (input as { signal?: AbortSignal }).signal
    const read: Read = { id: reads.length + 1, resource, method: input.method ?? 'GET', signal,
      startedAt: performance.now(), serverReceived: false, serverClosed: false }
    reads.push(read)
    const aborted = () => { read.abortedAt ??= performance.now() }
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
    try {
      // This is the pinned SDK's real Axios instance and response interceptor.
      // The ignored-abort counterexample only removes the leaf signal; the
      // adapter still receives and owns its accurate original signal.
      return await defaultHttpInstance.request({ ...input, url: base + '/' + resource + '?read=' + read.id, proxy: false,
        signal: policy[resource].ignoreAbort ? undefined : signal })
    } finally { read.completedAt = performance.now(); signal?.removeEventListener('abort', aborted) }
  }
  return { ...wire, policy, reads,
    http: { request, post: (url: string, data: unknown) => request({ url, data, method: 'POST' }) } as unknown as HttpInstance,
    release(resource: Resource) { for (const read of reads) if (read.resource === resource) answer(read) },
    reject(resource: Resource) { for (const read of reads) if (read.resource === resource) pending.get(read.id)?.destroy(new Error('Controlled late startup HTTP failure')) },
    async close() {
      for (const timer of timers) clearTimeout(timer)
      for (const response of pending.values()) response.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await wire.close()
    }
  }
}
