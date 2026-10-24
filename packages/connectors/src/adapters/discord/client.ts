import { REST, DefaultRestOptions, type RESTOptions, type RequestMethod, type ResponseLike } from '@discordjs/rest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Readable } from 'node:stream'
import type { ConnectionApiRequest, ConnectionApiResponseBody, ConnectionConfig } from '@agentmux/core/connections'
import { readConnectionApiResponse } from '../../connection-api-response.js'
import { discordConfig, discordFailure, discordId } from './protocol.js'

export type DiscordHttpOptions = Pick<RESTOptions, 'makeRequest'>
/** The mature SDK owns rate limits; possibly applied requests are never automatically retried. */
export class DiscordClients {
  private readonly clients = new Map<string, { credential: string; rest: REST; consumers: Set<string> }>()
  private readonly identities = new WeakMap<REST, Promise<{ botId: string; name?: string; avatar?: string | null }>>()
  private readonly apiRequests = new AsyncLocalStorage<{ protect(value: string): void; response?: { status: number; body: ConnectionApiResponseBody } }>()
  private closed = false
  private clientRetention = (_connectionId: string) => true
  constructor(private readonly http?: Partial<DiscordHttpOptions>) {}
  setClientRetention(read: (connectionId: string) => boolean): void { this.clientRetention = read }
  private release(rest: REST): void {
    rest.clearHashSweeper(); rest.clearHandlerSweeper()
    this.identities.delete(rest)
  }
  releaseConnection(connectionId: string): void {
    for (const [key, entry] of this.clients) {
      if (entry.consumers.delete(connectionId) && entry.consumers.size === 0) {
        this.release(entry.rest); this.clients.delete(key)
      }
    }
  }
  close(): void {
    this.closed = true
    this.clientRetention = () => false
    for (const entry of this.clients.values()) this.release(entry.rest)
    this.clients.clear()
  }
  rest(config: ConnectionConfig, credential: string): REST {
    discordConfig(config)
    const key = JSON.stringify(config.application), current = this.clients.get(key)
    let retain = false
    try { retain = !this.closed && (current?.consumers.has(config.connectionId) || this.clientRetention(config.connectionId)) } catch { /* Do not retain a new consumer without its original observation. */ }
    if (current?.credential === credential) {
      if (retain) current.consumers.add(config.connectionId)
      return current.rest
    }
    const makeRequest = this.http?.makeRequest ?? DefaultRestOptions.makeRequest
    const rest = new REST({ version: '10', retries: 0, makeRequest: async (url, init) => {
      const api = this.apiRequests.getStore()
      if (!api) return await makeRequest(url, init)
      delete api.response
      const target = new URL(url)
      if (target.origin !== 'https://discord.com' || !target.pathname.startsWith('/api/v10/')) return discordFailure('CONNECTION_API_ENDPOINT_UNAVAILABLE')
      const authorization = new Headers(init.headers as HeadersInit).get('authorization')
      if (authorization) {
        api.protect(authorization)
        const token = /^Bot\s+(.+)$/u.exec(authorization)?.[1]
        if (token) api.protect(token)
      }
      const response = await makeRequest(url, { ...init, redirect: 'manual' })
      const body = await readConnectionApiResponse({ body: response.body as AsyncIterable<Uint8Array> | null,
        contentType: response.headers.get('content-type'), contentLength: response.headers.get('content-length'),
        cancel() { if (response.body instanceof Readable) response.body.destroy(); else return response.body?.cancel() } })
      api.response = { status: response.status, body }
      // Preserve native rate-limit/error handling after one bounded read, without exposing raw SDK exceptions.
      const headers = new Headers([...response.headers.entries()]); headers.delete('content-length'); headers.set('content-type', 'application/json')
      // Node's native Response implements this public SDK shape; its separate undici stream declarations differ.
      return new Response([204, 205, 304].includes(response.status) || body.format === 'empty' ? null : body.format === 'json' ? JSON.stringify(body.value) : '{}',
        { status: response.status, statusText: response.statusText, headers }) as unknown as ResponseLike
    } }).setToken(credential)
    if (retain) {
      const consumers = current?.consumers ?? new Set<string>()
      if (current) this.release(current.rest)
      consumers.add(config.connectionId)
      this.clients.set(key, { credential, rest, consumers })
    } else this.release(rest)
    return rest
  }
  async requestApi(config: ConnectionConfig, credential: string, request: ConnectionApiRequest, protect: (value: string) => void): Promise<{ status: number; body: ConnectionApiResponseBody }> {
    const rest = this.rest(config, credential), scope: { protect(value: string): void; response?: { status: number; body: ConnectionApiResponseBody } } = { protect }
    return await this.apiRequests.run(scope, async () => {
      try {
        await rest.queueRequest({ fullRoute: request.path as `/${string}`, method: request.method as RequestMethod,
          // Authentication stays private. An API 401 cannot clear the shared Client's original token.
          auth: false, headers: { Authorization: `${rest.options.authPrefix} ${credential}` },
          ...(request.query ? { query: new URLSearchParams(Object.entries(request.query).map(([key, value]) => [key, String(value)])) } : {}),
          ...(request.body === undefined ? {} : request.files?.length ? { body: { payload_json: JSON.stringify(request.body) }, appendToFormData: true }
            : { body: request.body === null ? 'null' : request.body, ...(request.body === null ? { passThroughBody: true } : {}) }),
          ...(request.files?.length ? { files: request.files.map(file => ({ key: file.field, name: file.name, contentType: file.contentType, data: Buffer.from(file.base64, 'base64') })) } : {}) })
      } catch { if (!scope.response) return discordFailure('CONNECTION_API_REQUEST_UNCONFIRMED') }
      return scope.response ?? discordFailure('CONNECTION_API_REQUEST_UNCONFIRMED')
    })
  }
  async identity(config: ConnectionConfig, credential: string, signal?: AbortSignal, refresh = false): Promise<{ botId: string; name?: string; avatar?: string | null }> {
    const rest = this.rest(config, credential), existing = this.identities.get(rest)
    if (existing && !refresh) return await existing
    const reading = (async () => {
      const app = await rest.get('/oauth2/applications/@me', { signal }) as { id?: string; bot?: { id?: string; username?: string; avatar?: string | null } }
      if (app.id !== config.application.appId || !app.bot) return discordFailure('DISCORD_APPLICATION_MISMATCH')
      return { botId: discordId(app.bot.id), ...(app.bot.username ? { name: app.bot.username } : {}), ...(app.bot.avatar === undefined ? {} : { avatar: app.bot.avatar }) }
    })()
    this.identities.set(rest, reading)
    try { return await reading } catch (error) { this.identities.delete(rest); throw error }
  }
}
