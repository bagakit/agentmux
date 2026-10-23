import { AgentMuxError } from '@agentmux/core'
import { parseChannelMetadataParams, parseChannelMetadataResult, type ChannelMetadataPort, type ChannelMetadataInput, type ChannelMetadataGetInput, type ChannelMetadataListInput, type ChannelMetadataSubject, type ChannelMetadataChange } from '@agentmux/core/connections'
import type { ConnectionHost, SecretPort } from './connection-host.js'

/** Typed metadata management over adapter-owned keys. It cannot enumerate or clear retained effect resources. */
export function createChannelMetadata(connections: Pick<ConnectionHost, 'readConfiguration' | 'registeredAdapter' | 'channelStorage' | 'onChannelMetadataChanged'>, secrets: SecretPort, signal: AbortSignal, changed: (change: ChannelMetadataChange) => void): ChannelMetadataPort {
  function target(input: { connectionId: string; expectedConnectionRevision?: number; subject?: ChannelMetadataSubject }) {
    const current = connections.readConfiguration(input.connectionId)
    if (!current || signal.aborted) throw new AgentMuxError('The original Channel metadata owner is unavailable. Existing input remains available.', 'CHANNEL_METADATA_UNAVAILABLE')
    if (input.expectedConnectionRevision !== undefined && current.revision !== input.expectedConnectionRevision) throw new AgentMuxError('Read the current original Connection before changing its metadata cache.', 'CONNECTION_REVISION_CONFLICT')
    if (input.subject?.kind === 'actor' && (input.subject.actor.application.domain !== current.config.application.domain || input.subject.actor.application.appId !== current.config.application.appId)) throw new AgentMuxError('This actor belongs to another original application.', 'INVALID_CHANNEL_METADATA')
    const adapter = connections.registeredAdapter(current.config.adapterId)?.channelProfiles
    if (!adapter?.getMetadata) throw new AgentMuxError('The original adapter does not expose typed metadata management.', 'CHANNEL_METADATA_UNAVAILABLE')
    return { current, adapter, storage: connections.channelStorage(current.config) }
  }
  function read(input: ChannelMetadataGetInput) {
    const { current, adapter, storage } = target(input)
    return { connectionId: input.connectionId, connectionRevision: current.revision, application: current.config.application, entry: adapter.getMetadata!({ config: current.config, subject: input.subject, storage }) }
  }
  function notify(input: { connectionId: string; subject: ChannelMetadataSubject }) {
    const current = connections.readConfiguration(input.connectionId)
    if (current) changed({ connectionId: input.connectionId, application: current.config.application, subject: input.subject })
  }
  return {
    watch: async (listener, ended, context) => {
      await context?.assertCurrent?.()
      context?.signal?.throwIfAborted(); signal.throwIfAborted()
      let closed = false
      const release = connections.onChannelMetadataChanged(change => { if (!closed) listener(change) })
      const dispose = () => {
        if (closed) return
        closed = true; release()
        signal.removeEventListener('abort', ownerClosed)
        context?.signal?.removeEventListener('abort', dispose)
      }
      const ownerClosed = () => { dispose(); ended(new AgentMuxError('The original Channel metadata owner closed. Saved profiles and Agents are retained.', 'CHANNEL_METADATA_UNAVAILABLE')) }
      signal.addEventListener('abort', ownerClosed, { once: true })
      context?.signal?.addEventListener('abort', dispose, { once: true })
      if (signal.aborted || context?.signal?.aborted) dispose()
      return { dispose }
    },
    get: async (value, context) => {
      const input = parseChannelMetadataParams('connection.metadata.get', value)
      await context?.assertCurrent?.()
      return parseChannelMetadataResult('connection.metadata.get', read(input), input)
    },
    list: async (value, context) => {
      const input: ChannelMetadataListInput = parseChannelMetadataParams('connection.metadata.ls', value)
      await context?.assertCurrent?.()
      const { current, adapter, storage } = target(input)
      if (!adapter.listMetadata) throw new AgentMuxError('The exact Channel cannot list metadata.', 'CHANNEL_METADATA_UNAVAILABLE')
      const result = adapter.listMetadata({ config: current.config, kind: input.kind, limit: input.limit ?? 30, ...(input.cursor ? { cursor: input.cursor } : {}), storage })
      return parseChannelMetadataResult('connection.metadata.ls', { connectionId: input.connectionId, connectionRevision: current.revision, application: current.config.application, ...result }, input)
    },
    refresh: async (value, context) => {
      const input: ChannelMetadataInput = parseChannelMetadataParams('connection.metadata.refresh', value)
      await context?.assertCurrent?.()
      const { current, adapter, storage } = target(input)
      let credential: string | null
      try { credential = await secrets.resolve(current.config.credentialRef) } catch { credential = null }
      if (!credential) throw new AgentMuxError('The original Channel credential is unavailable. Confirmed local metadata and input remain available.', 'CHANNEL_METADATA_CREDENTIAL_UNAVAILABLE')
      await context?.assertCurrent?.(); target(input)
      const requestSignal = context?.signal ? AbortSignal.any([signal, context.signal]) : signal
      if (input.subject.kind === 'actor') await adapter.refreshActor({ actor: input.subject.actor, config: current.config, storage }, credential, requestSignal)
      else {
        if (!adapter.refreshConversation) throw new AgentMuxError('The exact Channel cannot refresh conversation metadata.', 'CHANNEL_METADATA_UNAVAILABLE')
        await adapter.refreshConversation({ config: current.config, externalConversationId: input.subject.externalConversationId, storage }, credential, requestSignal)
      }
      await context?.assertCurrent?.(); target(input)
      notify(input)
      return parseChannelMetadataResult('connection.metadata.refresh', read(input), input)
    },
    clear: async (value, context) => {
      const input = parseChannelMetadataParams('connection.metadata.clear', value)
      await context?.assertCurrent?.()
      const { current, adapter, storage } = target(input)
      if (!adapter.clearMetadata) throw new AgentMuxError('The exact Channel cannot clear metadata.', 'CHANNEL_METADATA_UNAVAILABLE')
      const cleared = adapter.clearMetadata({ config: current.config, subject: input.subject, expectedCacheRevision: input.expectedCacheRevision, storage })
      notify(input)
      return parseChannelMetadataResult('connection.metadata.clear', { ...read(input), cleared }, input)
    }
  }
}
