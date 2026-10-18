import { useEffect, useState } from 'react'
import type { RoomBinding } from '@agentmux/core/connections'
import { api } from './api'

/** Visible original audiences share a bounded metadata read, never a second relationship store. */
export function useConnectorRoomName(binding: RoomBinding | null, refresh = 0) {
  const identity = binding ? JSON.stringify([binding.bindingId, binding.connectionId, binding.application, binding.externalConversationId]) : ''
  const revision = binding?.revision
  const [read, setRead] = useState<{ identity: string; name?: string; issue: string; loading: boolean } | null>(null)
  useEffect(() => {
    if (!binding) return
    let live = true
    setRead(previous => ({ ...(previous?.identity === identity ? previous : {}), identity, issue: '', loading: true }))
    const finish = (name: string | undefined, issue: string) => {
      if (live) setRead(previous => ({ ...(previous?.identity === identity ? previous : {}), identity, ...(name ? { name } : {}), issue, loading: false }))
    }
    void (async () => {
      const { connection } = await api.connections.call('connection.inspect', { connectionId: binding.connectionId })
      if (!live) return
      if (!connection || connection.config.connectionId !== binding.connectionId || connection.config.application.domain !== binding.application.domain || connection.config.application.appId !== binding.application.appId) {
        finish(undefined, 'Group name unavailable'); return
      }
      const result = await api.connections.call('connection.room.get', { connectionId: binding.connectionId, expectedConnectionRevision: connection.revision, externalConversationId: binding.externalConversationId })
      const observed = result.observation.state === 'ready' && result.connectionId === binding.connectionId && result.connectionRevision === connection.revision &&
        result.application?.domain === binding.application.domain && result.application.appId === binding.application.appId && result.room?.externalConversationId === binding.externalConversationId
      const name = observed ? result.room?.name ?? undefined : undefined
      finish(name, result.observation.state !== 'ready' ? 'Group name unconfirmed' : name ? '' : 'Group name unavailable')
    })().catch(() => finish(undefined, 'Group name unconfirmed'))
    return () => { live = false }
  }, [identity, revision, refresh])
  const current = read?.identity === identity ? read : null
  return { label: current?.name ?? binding?.externalConversationId ?? '', issue: current?.issue ?? '', loading: !!binding && (!current || current.loading) }
}
