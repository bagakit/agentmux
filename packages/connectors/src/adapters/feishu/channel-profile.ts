import type { Client } from '@larksuiteoapi/node-sdk'
import { channelActorKey, parseChannelActorProfileObservation, type ChannelActorProfileObservation, type ConnectionConfig } from '@agentmux/core/connections'
import type { ChannelProfileAdapter, ChannelActorProfileRead } from '../../channel-profile-adapter.js'
import { AgentMuxError } from '@agentmux/core'
import { parseChannelConversationProfileObservation, parseChannelMetadataEntry, type ChannelMetadataSubject, type ChannelConversationProfileObservation, type ChannelMetadataEntry } from '@agentmux/core/connections'
import type { ChannelStoragePort } from '../../channel-storage.js'
import type { RoomProfileObservation } from '../../room-discovery-adapter.js'

type WithClient = <T>(config: ConnectionConfig, credential: string, call: (client: Client) => Promise<T>, signal?: AbortSignal) => Promise<T>
// Display freshness belongs to this native adapter. A stale value remains readable.
const PROFILE_FRESH_MS = 5 * 60_000
const actorKey = (input: ChannelActorProfileRead) => 'actor-profile:' + channelActorKey(input.actor)
const conversationKey = (id: string) => 'conversation-profile:' + JSON.stringify(id)
const missing = (input: ChannelActorProfileRead): ChannelActorProfileObservation => ({ actor: input.actor, state: 'unknown', profile: null, checkedAt: Date.now(), freshness: 'unknown', reason: 'not-observed' })
function readActor(input: ChannelActorProfileRead): ChannelActorProfileObservation {
  const row = input.storage.get(actorKey(input))
  if (!row) return missing(input)
  if (row.value.kind !== 'json') throw Error('Original actor profile is not metadata')
  const observed = parseChannelActorProfileObservation(row.value.value)
  if (channelActorKey(observed.actor) !== channelActorKey(input.actor)) throw Error('Original actor profile changed identity')
  if (observed.profile && !observed.profile.name && !observed.profile.avatarUrl) return { ...observed, state: 'unavailable', profile: null, freshness: 'unknown', reason: 'not-visible' }
  return { ...observed, freshness: observed.profile ? observed.state === 'observed' && Date.now() - observed.profile.observedAt < PROFILE_FRESH_MS ? 'current' : 'stale' : 'unknown' }
}

/** The native response may omit fields. Retained fields keep their earlier confirmation time. */
function conversationObservation(config: ConnectionConfig, id: string, native: { name?: unknown; avatar?: unknown }, previous: ChannelConversationProfileObservation | null): ChannelConversationProfileObservation {
  const now = Date.now(), name = typeof native.name === 'string' && native.name ? native.name : undefined
  const avatarUrl = typeof native.avatar === 'string' && native.avatar ? native.avatar : undefined
  if (!name && !avatarUrl) throw Error('No native group profile was observed')
  const retained = (!name && previous?.profile?.name) || (!avatarUrl && previous?.profile?.avatarUrl)
  const observedAt = retained ? previous!.profile!.observedAt : now
  return parseChannelConversationProfileObservation({ application: config.application, externalConversationId: id, state: 'observed', checkedAt: now,
    freshness: now - observedAt < PROFILE_FRESH_MS ? 'current' : 'stale', profile: { ...previous?.profile,
      ...(name ? { name } : {}), ...(avatarUrl ? { avatarUrl } : {}), observedAt } })
}

/** Capture only an already-known target; catalog subjects are discovered by their response. */
export function observeFeishuRoomProfiles(input: { config: ConnectionConfig; externalConversationId?: string; metadata?: RoomProfileObservation }): (id: string, native: { name?: unknown; avatar?: unknown }) => void {
  const metadata = input.metadata
  if (!metadata) return () => {}
  let expectedRevision: string | null | undefined
  try { if (input.externalConversationId) expectedRevision = metadata.storage.get(conversationKey(input.externalConversationId))?.revision ?? null }
  catch { return () => {} }
  return (id, native) => {
    try {
      if (!metadata.current() || input.externalConversationId && id !== input.externalConversationId) return
      const key = conversationKey(id), row = metadata.storage.get(key)
      if (expectedRevision !== undefined && (row?.revision ?? null) !== expectedRevision) return
      const previous = row?.value.kind === 'json' ? parseChannelConversationProfileObservation(row.value.value) : null
      if (previous && (previous.externalConversationId !== id || previous.application.domain !== input.config.application.domain || previous.application.appId !== input.config.application.appId)) return
      if (expectedRevision === undefined && previous && previous.checkedAt >= metadata.startedAt) return
      const observation = conversationObservation(input.config, id, native, previous)
      metadata.storage.put({ key, expectedRevision: row?.revision ?? null, value: { kind: 'json', value: observation } })
      metadata.changed({ kind: 'conversation', externalConversationId: id })
    } catch { /* Optional profile observation never rejects a native room read. */ }
  }
}

/** Exact contact.user observation through the same authenticated official SDK as native intake. */
export function createFeishuChannelProfiles(withClient: WithClient): ChannelProfileAdapter {
  const adapter: ChannelProfileAdapter = {
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
          else if (!user.name && !user.avatar?.avatar_240) observation = failure('not-visible')
          else {
            const now = Date.now(), avatarUrl = user.avatar?.avatar_240
            const retained = !user.name && cached.profile?.name || !avatarUrl && cached.profile?.avatarUrl
            const observedAt = retained ? cached.profile!.observedAt : now
            observation = parseChannelActorProfileObservation({ actor: input.actor, state: 'observed', checkedAt: now, freshness: now - observedAt < PROFILE_FRESH_MS ? 'current' : 'stale', profile: {
              ...cached.profile, ...(user.name ? { name: user.name } : {}), ...(avatarUrl ? { avatarUrl } : {}), observedAt
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
  return Object.assign(adapter, createFeishuMetadata(withClient, adapter))
}

function createFeishuMetadata(withClient: WithClient, actors: ChannelProfileAdapter): Pick<ChannelProfileAdapter, 'getMetadata' | 'listMetadata' | 'clearMetadata' | 'refreshConversation'> {
  const storageKey = (subject: ChannelMetadataSubject) => subject.kind === 'actor' ? 'actor-profile:' + channelActorKey(subject.actor) : 'conversation-profile:' + JSON.stringify(subject.externalConversationId)
  type Read = { config: ConnectionConfig; subject: ChannelMetadataSubject; storage: ChannelStoragePort }
  function getMetadata(input: Read): ChannelMetadataEntry {
    const { subject, storage, config } = input, row = storage.get(storageKey(subject))
    if (subject.kind === 'actor') return parseChannelMetadataEntry({ subject, observation: actors.readActor({ actor: subject.actor, storage }), cacheRevision: row?.revision ?? null }, config.application)
    let observation: ChannelConversationProfileObservation
    if (!row) observation = { application: config.application, externalConversationId: subject.externalConversationId, state: 'unknown', profile: null, checkedAt: Date.now(), freshness: 'unknown', reason: 'not-observed' }
    else {
      if (row.value.kind !== 'json') throw Error('Original conversation profile is not metadata')
      const original = parseChannelConversationProfileObservation(row.value.value)
      observation = { ...original, freshness: original.profile ? original.state === 'observed' && Date.now() - original.profile.observedAt < PROFILE_FRESH_MS ? 'current' : 'stale' : 'unknown' }
    }
    return parseChannelMetadataEntry({ subject, observation, cacheRevision: row?.revision ?? null }, config.application)
  }
  return {
    getMetadata,
    listMetadata(input) {
      const prefix = input.kind === 'actor' ? 'actor-profile:' : 'conversation-profile:'
      const page = input.storage.list({ limit: input.limit, prefix, ...(input.cursor ? { after: input.cursor } : {}) })
      const entries = page.entries.map(entry => {
        const row = input.storage.get(entry.key)
        if (!row || row.value.kind !== 'json') throw Error('Original metadata value is unavailable')
        const subject: ChannelMetadataSubject = input.kind === 'actor'
          ? { kind: 'actor', actor: parseChannelActorProfileObservation(row.value.value).actor }
          : { kind: 'conversation', externalConversationId: parseChannelConversationProfileObservation(row.value.value).externalConversationId }
        return getMetadata({ ...input, subject })
      })
      return { entries, next: page.next }
    },
    clearMetadata(input) {
      const key = storageKey(input.subject), row = input.storage.get(key)
      if (!row) return false
      if (input.expectedCacheRevision === null) throw new AgentMuxError('The exact metadata cache changed. Read its original revision before clearing.', 'CHANNEL_STORAGE_CONFLICT')
      return input.storage.delete({ key, expectedRevision: input.expectedCacheRevision })
    },
    async refreshConversation(input, credential, signal) {
      const subject: ChannelMetadataSubject = { kind: 'conversation', externalConversationId: input.externalConversationId }, key = storageKey(subject)
      const original = input.storage.get(key), cached = getMetadata({ ...input, subject }).observation as ChannelConversationProfileObservation
      const failure = (): ChannelConversationProfileObservation => ({ ...cached, state: 'unavailable', checkedAt: Date.now(), freshness: cached.profile ? 'stale' : 'unknown', reason: 'source-unconfirmed' })
      let observation: ChannelConversationProfileObservation
      try {
        const response = await withClient(input.config, credential, client => client.im.chat.get({ path: { chat_id: encodeURIComponent(input.externalConversationId) }, params: { user_id_type: 'open_id' } }), signal)
        signal.throwIfAborted()
        if (response.code !== 0 || !response.data || typeof response.data.name !== 'string') observation = failure()
        else {
          observation = conversationObservation(input.config, input.externalConversationId, response.data, cached)
        }
      } catch { observation = failure() }
      if (!signal.aborted) {
        try { input.storage.put({ key, expectedRevision: original?.revision ?? null, value: { kind: 'json', value: observation } }) }
        catch { return getMetadata({ ...input, subject }).observation as ChannelConversationProfileObservation }
      }
      return observation
    }
  }
}
