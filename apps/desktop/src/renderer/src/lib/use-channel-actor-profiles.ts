import { useEffect, useMemo, useState } from 'react'
import type { AgentSessionUserMessage } from '@agentmux/core'
import { channelActorKey, type ChannelActorProfileObservation } from '@agentmux/core/connections'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'

type ProfileRead = { observation?: ChannelActorProfileObservation; issue?: string }
const emptyProfiles = new Map<string, ProfileRead>()

export const channelProfileKey = (author: Extract<AgentSessionUserMessage['author'], { kind: 'external' }>) =>
  JSON.stringify([author.connectionId, channelActorKey(author.actor)])

/** Local display reads for represented actors only. Native lookup belongs to the Channel owner. */
export function useChannelActorProfiles(messages: readonly AgentSessionUserMessage[], visible: boolean) {
  const actors = useMemo(() => new Map(messages.flatMap(message => message.author.kind === 'external'
    ? [[channelProfileKey(message.author), message.author] as const] : [])), [messages])
  const identity = JSON.stringify([...actors.keys()].sort())
  const [read, setRead] = useState<{ identity: string; profiles: ReadonlyMap<string, ProfileRead> }>({ identity: '', profiles: emptyProfiles })
  useEffect(() => {
    if (!visible || !actors.size) return
    let live = true
    let notificationIssue: string | undefined
    const requests = new Map<string, number>()
    const load = (key: string) => {
      const author = actors.get(key)!, request = (requests.get(key) ?? 0) + 1
      requests.set(key, request)
      void api.connections.call('connection.metadata.get', { connectionId: author.connectionId, subject: { kind: 'actor', actor: author.actor } }).then(result => {
        if (!live || requests.get(key) !== request || !('actor' in result.entry.observation) || channelActorKey(result.entry.observation.actor) !== channelActorKey(author.actor)) return
        setRead(previous => ({ identity, profiles: new Map([...(previous.identity === identity ? previous.profiles : []), [key, {
          observation: result.entry.observation as ChannelActorProfileObservation, ...(notificationIssue ? { issue: notificationIssue } : {})
        }]]) }))
      }).catch(error => {
        if (!live || requests.get(key) !== request) return
        setRead(previous => ({ identity, profiles: new Map([...(previous.identity === identity ? previous.profiles : []), [key, {
          ...(previous.identity === identity ? previous.profiles.get(key) : {}), issue: presentError(error)
        }]]) }))
      })
    }
    let release: (() => void) | undefined
    try {
      release = api.connections.onMetadataChanged(change => {
        if (change.subject.kind !== 'actor') return
        const key = JSON.stringify([change.connectionId, channelActorKey(change.subject.actor)])
        if (actors.has(key)) load(key)
      }, state => {
        notificationIssue = state === 'ready' ? undefined : 'Live profile updates unavailable'
        if (state === 'ready') for (const key of actors.keys()) load(key)
        else setRead(previous => ({ identity, profiles: new Map([...actors.keys()].map(key => [key, {
          ...(previous.identity === identity ? previous.profiles.get(key) : {}), ...(notificationIssue ? { issue: notificationIssue } : {})
        }])) }))
      })
    } catch (error) { notificationIssue = `Live profile updates unavailable: ${presentError(error)}` }
    for (const key of actors.keys()) load(key)
    return () => { live = false; release?.() }
  }, [identity, visible, api.connections.call, api.connections.onMetadataChanged])
  return read.identity === identity ? read.profiles : emptyProfiles
}
