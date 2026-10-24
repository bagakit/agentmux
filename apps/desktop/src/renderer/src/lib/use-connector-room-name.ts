import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useEffect, useState } from 'react'
import type { ChannelMetadataResult, RoomBinding } from '@agentmux/core/connections'
import { api } from './api'

/** Names are local Channel observations; only this visible original group's miss needs a native lookup. */
export function useConnectorRoomName(binding: RoomBinding | null, refresh = 0, visible = true, hostingTarget?: ConnectionHostingTarget | null) {
  const identity = binding ? JSON.stringify([binding.connectionId, binding.application.domain, binding.application.appId, binding.externalConversationId, hostingTarget]) : ''
  const [read, setRead] = useState<{ identity: string; name?: string; issue: string; loading: boolean } | null>(null)
  useEffect(() => {
    if (!binding || !visible || hostingTarget === null) return
    let live = true, generation = 0, subscriptionIssue = ''
    const subject = { kind: 'conversation' as const, externalConversationId: binding.externalConversationId }
    const finish = (request: number, name: string | undefined, issue: string, preserveName = false) => {
      if (live && generation === request) setRead(previous => ({ identity,
        ...(name ? { name } : preserveName && previous?.identity === identity && previous.name ? { name: previous.name } : {}),
        issue: [issue, subscriptionIssue].filter(Boolean).join(' · '), loading: false }))
    }
    const matches = (result: ChannelMetadataResult) => result.connectionId === binding.connectionId &&
      result.application.domain === binding.application.domain && result.application.appId === binding.application.appId &&
      result.entry.subject.kind === 'conversation' && result.entry.subject.externalConversationId === binding.externalConversationId
    const load = (nativeOnMiss: boolean) => {
      const request = ++generation
      setRead(previous => ({ ...(previous?.identity === identity ? previous : {}), identity, issue: subscriptionIssue, loading: true }))
      void (async () => {
        let result = await api.connections.call('connection.metadata.get', { connectionId: binding.connectionId, subject }, hostingTarget)
        if (!live || request !== generation) return
        if (!matches(result)) { finish(request, undefined, 'Group name unconfirmed', true); return }
        const saved = result.entry.observation.profile?.name
        if (!saved && nativeOnMiss) result = await api.connections.call('connection.metadata.refresh', { connectionId: binding.connectionId, expectedConnectionRevision: result.connectionRevision, subject }, hostingTarget)
        if (!matches(result)) { finish(request, undefined, 'Group name unconfirmed', true); return }
        const name = result.entry.observation.profile?.name
        finish(request, name, result.entry.observation.state === 'unavailable' ? 'Group name update unavailable' : name ? '' : 'Group name unconfirmed')
      })().catch(() => finish(request, undefined, 'Group name unconfirmed', true))
    }
    let release: (() => void) | undefined
    try {
      release = api.connections.onMetadataChanged(change => {
        if (change.connectionId === binding.connectionId && change.application.domain === binding.application.domain && change.application.appId === binding.application.appId &&
          change.subject.kind === 'conversation' && change.subject.externalConversationId === binding.externalConversationId) load(false)
      }, state => {
        subscriptionIssue = state === 'ready' ? '' : 'Group name updates unconfirmed'
        if (state === 'ready') load(false)
        else setRead(previous => ({ ...(previous?.identity === identity ? previous : {}), identity, issue: subscriptionIssue, loading: false }))
      }, hostingTarget)
    } catch { subscriptionIssue = 'Group name updates unconfirmed' }
    load(true)
    return () => { live = false; generation++; if (release) release() }
  }, [identity, refresh, visible])
  const current = read?.identity === identity ? read : null
  return { label: current?.name ?? binding?.externalConversationId ?? '', issue: hostingTarget === null ? 'Original bot hosting owner unconfirmed' : current?.issue ?? '', loading: hostingTarget !== null && visible && !!binding && (!current || current.loading) }
}
