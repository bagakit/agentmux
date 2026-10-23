import { useEffect, useMemo, useState } from 'react'
import type { AgentSessionUserMessage } from '@agentmux/core'
import type { ConversationWindowSnapshot } from '@agentmux/core/conversation'
import { channelActorKey, type ChannelActorProfileObservation } from '@agentmux/core/connections'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'

type ExternalAuthor = Extract<AgentSessionUserMessage['author'], { kind: 'external' }>
type ProfileRead = { observation?: ChannelActorProfileObservation; issue?: string }
const emptyProfiles = new Map<string, ProfileRead>()

export const channelProfileKey = (author: ExternalAuthor) =>
  JSON.stringify([author.connectionId, channelActorKey(author.actor)])

/** Local display reads for represented actors only. Native lookup belongs to the Channel owner. */
export function useChannelActorProfiles(authors: readonly ExternalAuthor[], owner: Pick<ConversationWindowSnapshot, 'hostId' | 'sourceHostId'> | undefined, visible: boolean) {
  const localHostId = useAppStore(state => state.config?.hosts.find(host => host.kind === 'local')?.id)
  const actors = useMemo(() => new Map(authors.map(author => [channelProfileKey(author), author])), [authors])
  const identity = JSON.stringify([...actors.keys()].sort())
  const scope = JSON.stringify([localHostId ?? null, owner?.hostId ?? null, owner?.sourceHostId ?? null])
  const local = Boolean(localHostId && owner?.hostId === localHostId && owner.sourceHostId === localHostId)
  const [read, setRead] = useState<{ scope: string; profiles: ReadonlyMap<string, ProfileRead> }>({ scope: '', profiles: emptyProfiles })
  useEffect(() => {
    const retain = (previous: typeof read) => new Map([...actors.keys()].flatMap(key => {
      const profile = previous.scope === scope ? previous.profiles.get(key) : undefined
      return profile ? [[key, profile] as const] : []
    }))
    setRead(previous => ({ scope, profiles: retain(previous) }))
    if (!visible || !local || !actors.size) return
    let live = true
    let notificationIssue: string | undefined
    const requests = new Map<string, number>()
    const load = (key: string) => {
      if (!live) return
      const author = actors.get(key)!, request = (requests.get(key) ?? 0) + 1
      requests.set(key, request)
      void api.connections.call('connection.metadata.get', { connectionId: author.connectionId, subject: { kind: 'actor', actor: author.actor } }).then(result => {
        if (!live || requests.get(key) !== request || !('actor' in result.entry.observation) || channelActorKey(result.entry.observation.actor) !== channelActorKey(author.actor)) return
        setRead(previous => ({ scope, profiles: new Map([...retain(previous), [key, {
          observation: result.entry.observation as ChannelActorProfileObservation, ...(notificationIssue ? { issue: notificationIssue } : {})
        }]]) }))
      }).catch(error => {
        if (!live || requests.get(key) !== request) return
        setRead(previous => ({ scope, profiles: new Map([...retain(previous), [key, {
          ...(previous.scope === scope ? previous.profiles.get(key) : {}), issue: presentError(error)
        }]]) }))
      })
    }
    let release: (() => void) | undefined
    try {
      release = api.connections.onMetadataChanged(change => {
        if (!live) return
        if (change.subject.kind !== 'actor') return
        const key = JSON.stringify([change.connectionId, channelActorKey(change.subject.actor)])
        if (actors.has(key)) load(key)
      }, state => {
        if (!live) return
        notificationIssue = state === 'ready' ? undefined : 'Live profile updates unavailable'
        if (state === 'ready') for (const key of actors.keys()) load(key)
        else setRead(previous => ({ scope, profiles: new Map([...actors.keys()].map(key => [key, {
          ...(previous.scope === scope ? previous.profiles.get(key) : {}), ...(notificationIssue ? { issue: notificationIssue } : {})
        }])) }))
      })
    } catch (error) { notificationIssue = `Live profile updates unavailable: ${presentError(error)}` }
    for (const key of actors.keys()) load(key)
    return () => { live = false; release?.() }
  }, [scope, identity, local, visible, api.connections.call, api.connections.onMetadataChanged])
  return useMemo(() => new Map<string, ProfileRead>([...actors.keys()].flatMap<readonly [string, ProfileRead]>(key => {
    if (!local) return [[key, { issue: 'Profile metadata is unavailable for this Host or source' }] as const]
    const profile = read.scope === scope ? read.profiles.get(key) : undefined
    return profile ? [[key, profile] as const] : []
  })), [scope, identity, local, read])
}
