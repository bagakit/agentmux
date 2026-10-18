import { AgentMuxError } from '@agentmux/core'
import { channelActorKey, parseChannelActorProfileObservation, parseChannelConversationProfileObservation, parseChannelMetadataEntry, type ChannelConversationProfileObservation, type ChannelMetadataSubject, type ConnectionConfig } from '@agentmux/core/connections'
import type { ChannelProfileAdapter } from '../../channel-profile-adapter.js'
import type { ChannelStoragePort } from '../../channel-storage.js'
import type { DiscordClients } from './client.js'
import { discordId } from './protocol.js'

const key = (subject: ChannelMetadataSubject) => subject.kind === 'actor' ? 'actor-profile:' + channelActorKey(subject.actor) : 'conversation-profile:' + JSON.stringify(subject.externalConversationId)
type Read = { config: ConnectionConfig; subject: ChannelMetadataSubject; storage: ChannelStoragePort }
export function observeDiscordConversation(input: { config: ConnectionConfig; storage: ChannelStoragePort }, channel: { id: string; name?: string | null }, expectedRevision?: string | null): ChannelConversationProfileObservation {
  const id = discordId(channel.id), now = Date.now()
  const observation = parseChannelConversationProfileObservation({ application: input.config.application, externalConversationId: id, checkedAt: now,
    state: 'observed', freshness: 'current', profile: { ...(channel.name ? { name: channel.name } : {}), observedAt: now } })
  const storageKey = key({ kind: 'conversation', externalConversationId: id })
  input.storage.put({ key: storageKey, expectedRevision: expectedRevision === undefined ? input.storage.get(storageKey)?.revision ?? null : expectedRevision, value: { kind: 'json', value: observation } })
  return observation
}
export function createDiscordMetadataCache(actors: Pick<ChannelProfileAdapter, 'readActor'>) {
  const getMetadata = (input: Read) => {
    const row = input.storage.get(key(input.subject))
    const observation = input.subject.kind === 'actor' ? actors.readActor({ actor: input.subject.actor, storage: input.storage }) : !row
      ? { application: input.config.application, externalConversationId: input.subject.externalConversationId, state: 'unknown', profile: null, checkedAt: Date.now(), freshness: 'unknown', reason: 'not-observed' }
      : row.value.kind === 'json' ? (() => { const original = parseChannelConversationProfileObservation(row.value.value); return { ...original, freshness: original.profile ? original.state === 'observed' && Date.now() - original.checkedAt < 5 * 60_000 ? 'current' : 'stale' : 'unknown' } })() : (() => { throw Error('The original channel profile is not metadata') })()
    return parseChannelMetadataEntry({ subject: input.subject, observation, cacheRevision: row?.revision ?? null }, input.config.application)
  }
  return {
    getMetadata,
    listMetadata(input) {
      const page = input.storage.list({ prefix: input.kind + '-profile:', limit: input.limit, ...(input.cursor ? { after: input.cursor } : {}) })
      return { entries: page.entries.map(entry => {
        const row = input.storage.get(entry.key)
        if (row?.value.kind !== 'json') throw Error('The original metadata is unavailable')
        const subject: ChannelMetadataSubject = input.kind === 'actor' ? { kind: 'actor', actor: parseChannelActorProfileObservation(row.value.value).actor }
          : { kind: 'conversation', externalConversationId: parseChannelConversationProfileObservation(row.value.value).externalConversationId }
        if (key(subject) !== entry.key) throw Error('The original metadata subject changed')
        return getMetadata({ ...input, subject })
      }), next: page.next }
    },
    clearMetadata(input) {
      const storageKey = key(input.subject), row = input.storage.get(storageKey)
      if (!row) return false
      if (input.expectedCacheRevision === null) throw new AgentMuxError('The exact metadata changed. Read its original revision before clearing.', 'CHANNEL_STORAGE_CONFLICT')
      return input.storage.delete({ key: storageKey, expectedRevision: input.expectedCacheRevision })
    }
  } satisfies Pick<ChannelProfileAdapter, 'getMetadata' | 'listMetadata' | 'clearMetadata'>
}
export function createDiscordMetadata(clients: DiscordClients, actors: ChannelProfileAdapter): Pick<ChannelProfileAdapter, 'getMetadata' | 'listMetadata' | 'clearMetadata' | 'refreshConversation'> {
  const cache = createDiscordMetadataCache(actors), getMetadata = cache.getMetadata
  return { ...cache, async refreshConversation(input, credential, signal) {
      const subject: ChannelMetadataSubject = { kind: 'conversation', externalConversationId: discordId(input.externalConversationId) }, original = input.storage.get(key(subject))
      const cached = getMetadata({ ...input, subject }).observation as ChannelConversationProfileObservation
      let observation: ChannelConversationProfileObservation
      try {
        await clients.identity(input.config, credential, signal)
        const channel = await clients.rest(input.config, credential).get(`/channels/${input.externalConversationId}`, { signal }) as { id: string; name?: string | null }
        if (channel.id !== input.externalConversationId) throw Error('The original native channel changed')
        signal.throwIfAborted()
        return observeDiscordConversation(input, channel, original?.revision ?? null)
      } catch {
        observation = { ...cached, state: 'unavailable', checkedAt: Date.now(), freshness: cached.profile ? 'stale' : 'unknown', reason: 'source-unconfirmed' }
      }
      if (!signal.aborted) try { input.storage.put({ key: key(subject), expectedRevision: original?.revision ?? null, value: { kind: 'json', value: observation } }) }
      catch { return getMetadata({ ...input, subject }).observation as ChannelConversationProfileObservation }
      return observation
    }
  }
}
