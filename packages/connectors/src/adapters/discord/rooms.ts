import { DiscordAPIError } from '@discordjs/rest'
import type { APIChannel, APIUser } from 'discord-api-types/v10'
import type { RoomDiscoveryAdapter } from '../../room-discovery-adapter.js'
import type { DiscordClients } from './client.js'
import { discordId } from './protocol.js'
import { observeDiscordConversation, type DiscordConversationProfile } from './metadata.js'
import { observeDiscordActor } from './profile.js'
import { channelActorKey, parseChannelActorProfileObservation, parseChannelConversationProfileObservation, type ChannelMetadataSubject, type ConnectionConfig } from '@agentmux/core/connections'
import type { ChannelStoragePort } from '../../channel-storage.js'
import type { RoomProfileObservation } from '../../room-discovery-adapter.js'

const key = (subject: ChannelMetadataSubject) => subject.kind === 'actor' ? 'actor-profile:' + channelActorKey(subject.actor) : 'conversation-profile:' + JSON.stringify(subject.externalConversationId)

/** Enrich only this original native read; group members are not a guild directory. */
function observeDiscordRoomProfiles(input: { config: ConnectionConfig; externalConversationId?: string; metadata?: RoomProfileObservation }) {
  const metadata = input.metadata
  let revision: string | null | undefined
  try { if (metadata && input.externalConversationId) revision = metadata.storage.get(key({ kind: 'conversation', externalConversationId: input.externalConversationId }))?.revision ?? null }
  catch { return { conversation() {}, actor() {} } }
  function observe(subject: ChannelMetadataSubject, write: (storage: ChannelStoragePort, expected: string | null) => void) {
    try {
      if (!metadata?.current()) return
      const row = metadata.storage.get(key(subject))
      const exactConversation = subject.kind === 'conversation' && input.externalConversationId !== undefined
      if (exactConversation && (subject.externalConversationId !== input.externalConversationId || (row?.revision ?? null) !== revision)) return
      const previous = row?.value.kind === 'json' ? subject.kind === 'actor' ? parseChannelActorProfileObservation(row.value.value) : parseChannelConversationProfileObservation(row.value.value) : null
      if (!exactConversation && previous && previous.checkedAt >= metadata.startedAt) return
      write(metadata.storage, row?.revision ?? null)
      metadata.changed(subject)
    } catch { /* Optional profile observations cannot reject native discovery. */ }
  }
  return {
    conversation(channel: DiscordConversationProfile) {
      observe({ kind: 'conversation', externalConversationId: channel.id }, (storage, expected) => { observeDiscordConversation({ config: input.config, storage }, channel, expected) })
    },
    actor(user: APIUser) {
      const actor = { application: input.config.application, idType: 'snowflake', userId: user.id }
      observe({ kind: 'actor', actor }, (storage, expected) => { observeDiscordActor(storage, actor, user, expected) })
    }
  }
}
/** A native channel read does not assert guild membership, permissions or a complete room catalog. */
export function createDiscordRooms(clients: DiscordClients): RoomDiscoveryAdapter {
  const unconfirmed = { state: 'unknown', reason: 'response-unconfirmed' } as const
  const list: RoomDiscoveryAdapter['search'] = async (input, credential, signal) => {
    const observe = observeDiscordRoomProfiles(input)
    try {
      await clients.identity(input.config, credential, signal)
      const scope = [input.config.application.domain, input.config.application.appId, input.query ?? null]
      let guild: string | null = null, afterGuild: string | null = null, afterChannel: string | null = null
      if (input.cursor) {
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (!Array.isArray(cursor) || cursor.length !== 4 || JSON.stringify(cursor[0]) !== JSON.stringify(scope)) throw Error('The native catalog cursor belongs to another original query')
        afterGuild = cursor[1] === null ? null : discordId(cursor[1]); guild = cursor[2] === null ? null : discordId(cursor[2]); afterChannel = cursor[3] === null ? null : discordId(cursor[3])
      }
      const rest = clients.rest(input.config, credential)
      if (!guild) {
        const guilds = await rest.get('/users/@me/guilds', { query: new URLSearchParams({ limit: '1', ...(afterGuild ? { after: afterGuild } : {}) }), signal }) as Array<{ id: string }>
        if (!Array.isArray(guilds) || guilds.length > 1) throw Error('The original native guild page is unconfirmed')
        if (!guilds.length) return { observation: { state: 'ready' }, rooms: [], next: null }
        guild = discordId(guilds[0]!.id)
      }
      const channels = await rest.get(`/guilds/${guild}/channels`, { signal }) as Array<{ id: string; type: number; name?: string | null }>
      if (!Array.isArray(channels)) throw Error('The original native channel catalog is unconfirmed')
      const rooms = channels.filter(channel => [0, 5].includes(channel.type) && (!afterChannel || BigInt(discordId(channel.id)) > BigInt(afterChannel)) && (!input.query || channel.name?.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())))
        .sort((a, b) => BigInt(discordId(a.id)) < BigInt(discordId(b.id)) ? -1 : 1)
      const selected = rooms.slice(0, input.limit ?? 20)
      for (const channel of selected) observe.conversation(channel)
      const next = Buffer.from(JSON.stringify([scope, rooms.length > selected.length ? afterGuild : guild, rooms.length > selected.length ? guild : null, rooms.length > selected.length ? selected.at(-1)!.id : null])).toString('base64url')
      return { observation: { state: 'ready' }, rooms: selected.map(channel => ({ externalConversationId: channel.id, name: channel.name ?? null, state: 'active' })), next }
    } catch { return { observation: unconfirmed, rooms: [], next: null } }
  }
  return {
    // One native guild page per request; threads and direct rooms remain exactly addressable through get.
    list: (input, credential, signal) => list({ ...input, query: '' }, credential, signal),
    search: list,
    async get(input, credential, signal) {
      const observe = observeDiscordRoomProfiles(input)
      try {
        await clients.identity(input.config, credential, signal)
        const channel = await clients.rest(input.config, credential).get(`/channels/${discordId(input.externalConversationId)}`, { signal }) as APIChannel
        if (channel.id !== input.externalConversationId) return { observation: unconfirmed, room: null }
        observe.conversation(channel)
        return { observation: { state: 'ready' }, room: { externalConversationId: channel.id, name: 'name' in channel ? channel.name ?? null : null, state: 'active',
          mode: channel.type === 1 || channel.type === 3 ? 'direct' : [10, 11, 12, 15].includes(channel.type) ? 'topic' : [0, 2, 5, 13, 16].includes(channel.type) ? 'group' : 'unknown', membershipApproval: 'unknown' } }
      } catch (error) {
        return { observation: error instanceof DiscordAPIError && error.status === 403 ? { state: 'unavailable', reason: 'permission-denied' } : error instanceof DiscordAPIError && error.status === 404 ? { state: 'unavailable', reason: 'room-unavailable' } : unconfirmed, room: null }
      }
    },
    async members(input, credential, signal) {
      const observe = observeDiscordRoomProfiles(input)
      try {
        await clients.identity(input.config, credential, signal)
        const channel = await clients.rest(input.config, credential).get(`/channels/${discordId(input.externalConversationId)}`, { signal }) as { id?: string; type?: number; recipients?: APIUser[] }
        if (channel.id !== input.externalConversationId || ![1, 3].includes(channel.type ?? -1) || !Array.isArray(channel.recipients) || input.cursor) return { observation: unconfirmed, members: [], next: null }
        for (const user of channel.recipients) observe.actor(user)
        return { observation: { state: 'ready' }, members: channel.recipients.map(user => ({ idType: 'snowflake', userId: discordId(user.id), name: user.global_name || user.username })), next: null }
      } catch { return { observation: unconfirmed, members: [], next: null } }
    },
    async createLink(input, credential, signal) {
      try {
        await clients.identity(input.config, credential, signal)
        const invite = await clients.rest(input.config, credential).post(`/channels/${discordId(input.externalConversationId)}/invites`, { signal, body: { max_age: 604800, max_uses: 0, temporary: false, unique: true } }) as { code?: string; expires_at?: string | null; created_at?: string; max_age?: number }
        const expires = invite.expires_at ? Date.parse(invite.expires_at) : invite.created_at && invite.max_age ? Date.parse(invite.created_at) + invite.max_age * 1000 : NaN
        if (typeof invite.code !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(invite.code) || !Number.isFinite(expires) || expires <= 0) return { kind: 'unknown' }
        return { kind: 'confirmed', link: { url: 'https://discord.gg/' + invite.code, expiresAtUnixSeconds: Math.floor(expires / 1000) } }
      } catch (error) {
        return error instanceof DiscordAPIError && [401, 403, 404].includes(error.status) ? { kind: 'refused', reason: error.status === 404 ? 'room-unavailable' : 'permission-denied' } : { kind: 'unknown' }
      }
    }
  }
}
