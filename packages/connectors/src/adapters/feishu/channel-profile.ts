import type { Client } from '@larksuiteoapi/node-sdk'
import { channelActorKey, parseChannelActorProfileObservation, type ChannelActorProfileObservation, type ConnectionConfig } from '@agentmux/core/connections'
import type { ChannelProfileAdapter, ChannelActorProfileRead } from '../../channel-profile-adapter.js'

type WithClient = <T>(config: ConnectionConfig, credential: string, call: (client: Client) => Promise<T>, signal?: AbortSignal) => Promise<T>
// Display freshness belongs to this native adapter. A stale value remains readable.
const PROFILE_FRESH_MS = 5 * 60_000
const actorKey = (input: ChannelActorProfileRead) => 'actor-profile:' + channelActorKey(input.actor)
const missing = (input: ChannelActorProfileRead): ChannelActorProfileObservation => ({ actor: input.actor, state: 'unknown', profile: null, checkedAt: Date.now(), freshness: 'unknown', reason: 'not-observed' })
function readActor(input: ChannelActorProfileRead): ChannelActorProfileObservation {
  const row = input.storage.get(actorKey(input))
  if (!row) return missing(input)
  if (row.value.kind !== 'json') throw Error('Original actor profile is not metadata')
  const observed = parseChannelActorProfileObservation(row.value.value)
  if (channelActorKey(observed.actor) !== channelActorKey(input.actor)) throw Error('Original actor profile changed identity')
  return { ...observed, freshness: observed.profile ? observed.state === 'observed' && Date.now() - observed.checkedAt < PROFILE_FRESH_MS ? 'current' : 'stale' : 'unknown' }
}

/** Exact contact.user observation through the same authenticated official SDK as native intake. */
export function createFeishuChannelProfiles(withClient: WithClient): ChannelProfileAdapter {
  return {
    readActor,
    async refreshActor(input, credential, signal) {
      const storageKey = actorKey(input), original = input.storage.get(storageKey), cached = readActor(input)
      const failure = (reason: NonNullable<ChannelActorProfileObservation['reason']>): ChannelActorProfileObservation => ({ ...cached, state: 'unavailable', checkedAt: Date.now(), freshness: cached.profile ? 'stale' : 'unknown', reason })
      let observation: ChannelActorProfileObservation
      const idType = input.actor.idType
      if (!['open_id', 'user_id', 'union_id'].includes(idType)) observation = failure('unsupported-actor')
      else if (input.actor.application.domain !== input.config.application.domain || input.actor.application.appId !== input.config.application.appId) observation = failure('source-unconfirmed')
      else try {
        const response = await withClient(input.config, credential, client => client.contact.user.get({ path: { user_id: encodeURIComponent(input.actor.userId) }, params: { user_id_type: idType as 'open_id' | 'user_id' | 'union_id' } }), signal)
        signal.throwIfAborted()
        if (response.code !== 0 || !response.data?.user) observation = failure('not-visible')
        else {
          const user = response.data.user
          if (user[idType as 'open_id' | 'user_id' | 'union_id'] !== input.actor.userId) observation = failure('source-unconfirmed')
          else {
            const now = Date.now()
            observation = parseChannelActorProfileObservation({ actor: input.actor, state: 'observed', checkedAt: now, freshness: 'current', profile: {
              ...(user.name ? { name: user.name } : {}), ...(user.avatar?.avatar_240 ? { avatarUrl: user.avatar.avatar_240 } : {}), observedAt: now
            } })
          }
        }
      } catch { observation = failure('source-unconfirmed') }
      if (signal.aborted) return observation
      try { input.storage.put({ key: storageKey, expectedRevision: original?.revision ?? null, value: { kind: 'json', value: observation } }); return observation }
      catch {
        // Another original refresh or clear owns a changed revision. Do not overwrite it.
        const current = readActor(input)
        return current.profile ? current : { ...observation, state: 'unavailable', freshness: observation.profile ? 'stale' : 'unknown', reason: 'storage-unconfirmed' }
      }
    }
  }
}
