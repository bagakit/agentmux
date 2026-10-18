import { channelActorKey, parseChannelActorProfileObservation, type ChannelActorProfileObservation, type ConnectionActor } from '@agentmux/core/connections'
import type { APIUser } from 'discord-api-types/v10'
import type { ChannelProfileAdapter, ChannelActorProfileRead } from '../../channel-profile-adapter.js'
import type { ChannelStoragePort } from '../../channel-storage.js'
import { discordAvatar, discordId } from './protocol.js'
import type { DiscordClients } from './client.js'

const key = (actor: ConnectionActor) => 'actor-profile:' + channelActorKey(actor)
const missing = (actor: ConnectionActor): ChannelActorProfileObservation => ({ actor, state: 'unknown', profile: null, checkedAt: Date.now(), freshness: 'unknown', reason: 'not-observed' })
export function readDiscordActor(input: ChannelActorProfileRead): ChannelActorProfileObservation {
  const row = input.storage.get(key(input.actor))
  if (!row) return missing(input.actor)
  if (row.value.kind !== 'json') throw Error('The original Discord profile is not metadata')
  const observation = parseChannelActorProfileObservation(row.value.value)
  if (channelActorKey(observation.actor) !== channelActorKey(input.actor)) throw Error('The original Discord profile belongs to another actor')
  // Gateway user observations and explicit refresh update this native cache. Age alone does not certify current data.
  return { ...observation, freshness: observation.profile ? 'stale' : 'unknown' }
}
export function observeDiscordActor(storage: ChannelStoragePort, actor: ConnectionActor, user: APIUser): ChannelActorProfileObservation {
  if (discordId(user.id) !== actor.userId || actor.idType !== 'snowflake') throw Error('The native user does not match the original actor')
  const now = Date.now(), avatarUrl = discordAvatar(user)
  const observation = parseChannelActorProfileObservation({ actor, state: 'observed', checkedAt: now, freshness: 'current',
    profile: { name: user.global_name || user.username, ...(avatarUrl ? { avatarUrl } : {}), observedAt: now } })
  const old = storage.get(key(actor))
  storage.put({ key: key(actor), value: { kind: 'json', value: observation }, expectedRevision: old?.revision ?? null })
  return observation
}
export function createDiscordProfiles(clients: DiscordClients): ChannelProfileAdapter {
  return { readActor: readDiscordActor, async refreshActor(input, credential, signal) {
    const cached = readDiscordActor(input)
    let observation: ChannelActorProfileObservation
    try {
      if (input.actor.idType !== 'snowflake' || (input.actor.application.domain !== input.config.application.domain || input.actor.application.appId !== input.config.application.appId)) return { ...cached, state: 'unavailable', checkedAt: Date.now(), freshness: cached.profile ? 'stale' : 'unknown', reason: 'unsupported-actor' }
      const user = await clients.rest(input.config, credential).get(`/users/${discordId(input.actor.userId)}`, { signal }) as APIUser
      return observeDiscordActor(input.storage, input.actor, user)
    } catch { observation = { ...cached, state: 'unavailable', checkedAt: Date.now(), freshness: cached.profile ? 'stale' : 'unknown', reason: 'source-unconfirmed' } }
    const old = input.storage.get(key(input.actor)); input.storage.put({ key: key(input.actor), value: { kind: 'json', value: observation }, expectedRevision: old?.revision ?? null })
    return observation
  } }
}
