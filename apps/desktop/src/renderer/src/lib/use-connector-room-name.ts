import { useEffect, useState } from 'react'
import type { ChannelMetadataResult, RoomBinding } from '@agentmux/core/connections'
import { api } from './api'

/** Names are local Channel observations; only this visible original group's miss needs a native lookup. */
export function useConnectorRoomName(binding: RoomBinding | null, refresh = 0, visible = true) {
  const identity = binding ? JSON.stringify([binding.connectionId, binding.application.domain, binding.application.appId, binding.externalConversationId]) : ''
  const [read, setRead] = useState<{ identity: string; name?: string; issue: string; loading: boolean } | null>(null)
  useEffect(() => {
    if (!binding || !visible) return
    let live = true, generation = 0
    const subject = { kind: 'conversation' as const, externalConversationId: binding.externalConversationId }
    const finish = (request: number, name: string | undefined, issue: string, preserveName = false) => {
      if (live && generation === request) setRead(previous => ({ identity,
        ...(name ? { name } : preserveName && previous?.identity === identity && previous.name ? { name: previous.name } : {}), issue, loading: false }))
    }
    const matches = (result: ChannelMetadataResult) => result.connectionId === binding.connectionId &&
      result.application.domain === binding.application.domain && result.application.appId === binding.application.appId &&
      result.entry.subject.kind === 'conversation' && result.entry.subject.externalConversationId === binding.externalConversationId
    const load = (nativeOnMiss: boolean) => {
      const request = ++generation
      setRead(previous => ({ ...(previous?.identity === identity ? previous : {}), identity, issue: '', loading: true }))
      void (async () => {
        let result = await api.connections.call('connection.metadata.get', { connectionId: binding.connectionId, subject })
        if (!live || request !== generation) return
        if (!matches(result)) { finish(request, undefined, 'Group name unconfirmed', true); return }
        const saved = result.entry.observation.profile?.name
        if (!saved && nativeOnMiss) result = await api.connections.call('connection.metadata.refresh', { connectionId: binding.connectionId, expectedConnectionRevision: result.connectionRevision, subject })
        if (!matches(result)) { finish(request, undefined, 'Group name unconfirmed', true); return }
        const name = result.entry.observation.profile?.name
        finish(request, name, result.entry.observation.freshness === 'stale' ? 'Saved name · refresh unconfirmed' : name ? '' : 'Group name unconfirmed')
      })().catch(() => finish(request, undefined, 'Group name unconfirmed', true))
    }
    load(true)
    const release = api.connections.onMetadataChanged(change => {
      if (change.connectionId === binding.connectionId && change.application.domain === binding.application.domain && change.application.appId === binding.application.appId &&
        change.subject.kind === 'conversation' && change.subject.externalConversationId === binding.externalConversationId) load(false)
    })
    return () => { live = false; generation++; release() }
  }, [identity, refresh, visible])
  const current = read?.identity === identity ? read : null
  return { label: current?.name ?? binding?.externalConversationId ?? '', issue: current?.issue ?? '', loading: visible && !!binding && (!current || current.loading) }
}
