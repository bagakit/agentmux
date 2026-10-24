import { REST, type RESTOptions } from '@discordjs/rest'
import type { ConnectionConfig } from '@agentmux/core/connections'
import { discordConfig, discordFailure, discordId } from './protocol.js'

export type DiscordHttpOptions = Pick<RESTOptions, 'makeRequest'>
/** The mature SDK owns rate limits; possibly applied requests are never automatically retried. */
export class DiscordClients {
  private readonly clients = new Map<string, { credential: string; rest: REST; consumers: Set<string> }>()
  private readonly identities = new WeakMap<REST, Promise<{ botId: string; name?: string; avatar?: string | null }>>()
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
    const rest = new REST({ version: '10', retries: 0, ...this.http }).setToken(credential)
    if (retain) {
      const consumers = current?.consumers ?? new Set<string>()
      if (current) this.release(current.rest)
      consumers.add(config.connectionId)
      this.clients.set(key, { credential, rest, consumers })
    } else this.release(rest)
    return rest
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
