import { useEffect, useMemo, useState } from 'react'
import type { AgentSessionUserMessage } from '@agentmux/core'
import type { ConversationWindowSnapshot } from '@agentmux/core/conversation'
import { channelActorKey, channelMetadataSubjectKey, type ChannelActorProfileObservation, type ChannelConversationProfileObservation } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { connectorProfileGroupKey, useConnectorProfileGroups, type ConnectorProfileGroup } from './use-connector-room-name'

type ExternalAuthor = Extract<AgentSessionUserMessage['author'], { kind: 'external' }>
type ProfileRead = { observation?: ChannelActorProfileObservation; conversation?: ChannelConversationProfileObservation; issue?: string; conversationIssue?: string }

export const channelProfileKey = (author: ExternalAuthor) => JSON.stringify([
  author.authoritySource?.hostingRuntimeId ?? null, author.connectionId, channelActorKey(author.actor), author.externalConversationId
])

/** The reading selects original people and conversations; the shared metadata owner reads their profiles. */
export function useChannelActorProfiles(authors: readonly ExternalAuthor[], owner: Pick<ConversationWindowSnapshot, 'hostId' | 'sourceHostId'> | undefined, visible: boolean) {
  const localHostId = useAppStore(state => state.config?.hosts.find(host => host.kind === 'local')?.id)
  const actors = new Map(authors.map(author => [channelProfileKey(author), author]))
  const identity = JSON.stringify([...actors.keys()].sort())
  const legacyLocal = Boolean(localHostId && owner?.hostId === localHostId && owner.sourceHostId === localHostId)
  const runtimes = [...new Set([...actors.values()].flatMap(author => author.authoritySource ? [author.authoritySource.hostingRuntimeId] : []))].sort()
  const runtimeIdentity = JSON.stringify(runtimes)
  const [routes, setRoutes] = useState<ReadonlyMap<string, { target?: ConnectionHostingTarget; issue?: string }>>(new Map())
  useEffect(() => {
    if (!visible || !runtimes.length) return
    let live = true
    setRoutes(previous => new Map(runtimes.flatMap(runtimeId => {
      const route = previous.get(runtimeId)
      return route ? [[runtimeId, route] as const] : []
    })))
    for (const runtimeId of runtimes) void api.connections.hostingTarget({ runtimeId }).then(target => {
      if (!live) return
      const exact = target.runtimeId === runtimeId
      setRoutes(previous => new Map([...previous,
        [runtimeId, exact ? { target } : { ...previous.get(runtimeId), issue: 'Original profile hosting owner unconfirmed' }]]))
    }).catch(error => {
      if (!live) return
      setRoutes(previous => new Map([...previous,
        [runtimeId, { ...previous.get(runtimeId), issue: presentError(error) }]]))
    })
    return () => { live = false }
  }, [runtimeIdentity, visible, api.connections.hostingTarget])
  const groups = new Map<string, ConnectorProfileGroup>(), selected = new Map<string, { group: ConnectorProfileGroup; pending: boolean; issue?: string }>()
  for (const [key, author] of actors) {
    const runtimeId = author.authoritySource?.hostingRuntimeId
    const route = runtimeId ? routes.get(runtimeId) : undefined
    const hostingTarget = runtimeId ? route?.target ?? null : legacyLocal ? undefined : null
    const group: ConnectorProfileGroup = { connection: { connectionId: author.connectionId, application: author.actor.application }, hostingTarget,
      subjects: [{ kind: 'actor', actor: author.actor }, { kind: 'conversation', externalConversationId: author.externalConversationId }] }
    const id = connectorProfileGroupKey(group), earlier = groups.get(id)
    groups.set(id, earlier ? { ...group, subjects: [...earlier.subjects, ...group.subjects] } : group)
    const pending = Boolean(runtimeId && !route)
    selected.set(key, { group, pending, ...(route?.issue ? { issue: route.issue } : !pending && hostingTarget === null ? { issue: 'Profile metadata is unavailable for this Host or source' } : {}) })
  }
  const reads = useConnectorProfileGroups([...groups.values()], visible)
  return useMemo(() => {
  const result = new Map<string, ProfileRead>()
  for (const [key, { group, issue, pending }] of selected) {
    const author = actors.get(key)!, profiles = reads.get(connectorProfileGroupKey(group))
    const actor = profiles?.get(channelMetadataSubjectKey({ kind: 'actor', actor: author.actor }))
    const room = profiles?.get(channelMetadataSubjectKey({ kind: 'conversation', externalConversationId: author.externalConversationId }))
    const person = actor?.observation && 'actor' in actor.observation ? actor.observation : undefined
    const conversation = room?.observation && 'externalConversationId' in room.observation ? room.observation : undefined
    const updates = actor?.updatesUnconfirmed || room?.updatesUnconfirmed ? 'Live profile updates unavailable' : ''
    result.set(key, { ...(person ? { observation: person } : {}), ...(conversation ? { conversation } : {}),
      issue: pending ? '' : [issue, actor?.issue, updates].filter(Boolean).join(' · '), conversationIssue: pending ? '' : [issue, room?.issue, updates].filter(Boolean).join(' · ') })
  }
  return result
  }, [identity, reads, routes, legacyLocal])
}
