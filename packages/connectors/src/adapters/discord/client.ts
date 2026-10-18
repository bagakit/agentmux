import { REST, type RESTOptions } from '@discordjs/rest'
import type { ConnectionConfig } from '@agentmux/core/connections'
import { discordConfig, discordFailure, discordId } from './protocol.js'

export type DiscordHttpOptions = Pick<RESTOptions, 'makeRequest'>
/** The mature SDK owns rate limits; possibly applied requests are never automatically retried. */
export class DiscordClients {
  private readonly clients = new Map<string, { credential: string; rest: REST }>()
  private readonly identities = new Map<REST, Promise<{ botId: string; name?: string; avatar?: string | null }>>()
  constructor(private readonly http?: Partial<DiscordHttpOptions>) {}
  rest(config: ConnectionConfig, credential: string): REST {
    discordConfig(config)
    const key = JSON.stringify(config.application), current = this.clients.get(key)
    if (current?.credential === credential) return current.rest
    const rest = new REST({ version: '10', retries: 0, ...this.http }).setToken(credential)
    this.clients.set(key, { credential, rest }); return rest
  }
  async identity(config: ConnectionConfig, credential: string, signal?: AbortSignal): Promise<{ botId: string; name?: string; avatar?: string | null }> {
    const rest = this.rest(config, credential), existing = this.identities.get(rest)
    if (existing) return await existing
    const reading = (async () => {
      const app = await rest.get('/oauth2/applications/@me', { signal }) as { id?: string; bot?: { id?: string; username?: string; avatar?: string | null } }
      if (app.id !== config.application.appId || !app.bot) return discordFailure('DISCORD_APPLICATION_MISMATCH')
      return { botId: discordId(app.bot.id), ...(app.bot.username ? { name: app.bot.username } : {}), ...(app.bot.avatar === undefined ? {} : { avatar: app.bot.avatar }) }
    })()
    this.identities.set(rest, reading)
    try { return await reading } catch (error) { this.identities.delete(rest); throw error }
  }
}
