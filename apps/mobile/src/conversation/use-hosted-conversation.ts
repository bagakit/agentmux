import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import { errorMessage } from './delivery'

export type MobileConnection = {
  state: 'unavailable' | 'connecting' | 'connected' | 'disconnected'
  message: string
  issue?: string
}

type Projection = {
  id: string | null
  session: AgentMuxAgentSession | null
  timeline: AgentTimelineSnapshot | null
  page: AgentSessionHistoryPage | null
  reading: boolean
  notice: string | null
  disconnected: boolean
  olderWindow: boolean
  newerAvailable: boolean
}
const empty = (id: string | null): Projection => ({
  id, session: null, timeline: null, page: null, reading: false, notice: null,
  disconnected: false, olderWindow: false, newerAvailable: false
})

/** Retained readonly SDK projections; no history reconciliation, Run owner or local business queue. */
export function useHostedConversation(client: AgentMuxHostedClient | null, id: string | null, active: boolean) {
  const [projection, setProjection] = useState<Projection>(() => empty(id))
  const refreshRef = useRef<((cursor?: string) => Promise<void>) | null>(null)
  useEffect(() => {
    let live = true
    setProjection(value => value.id === id ? value : empty(id))
    if (!client || !id || !active) { refreshRef.current = null; return }
    let reading = false, dirty = false
    let cursor: string | undefined
    let requestedCursor: string | undefined
    const patch = (changes: Partial<Projection>) => {
      if (live) setProjection(value => ({ ...(value.id === id ? value : empty(id)), ...changes }))
    }
    async function refresh(nextCursor?: string): Promise<void> {
      if (!live) return
      if (reading) { dirty = true; requestedCursor = nextCursor; return }
      reading = true
      cursor = nextCursor
      patch({ reading: true, notice: null })
      try {
        // Each read fails independently: a native-history probe cannot suppress an existing
        // Session or its captured input projection, nor become an admission gate for a Prompt.
        try {
          const session = client!.agentSession(id!)
          if (session.agentSessionId === id) patch({ session })
          else patch({ notice: 'The Host returned another Session’s metadata. The original reading is retained.' })
        }
        catch (error) { patch({ notice: errorMessage(error) }) }
        const [timeline, history] = await Promise.allSettled([
          client!.sessionTimeline(id!), client!.sessionHistoryPage(id!, { limit: 30, ...(cursor ? { cursor } : {}) })
        ])
        if (!live) return
        if (timeline.status === 'fulfilled') {
          if (timeline.value.agentSessionId === id) patch({ timeline: timeline.value })
          else patch({ notice: 'The Host returned another Session’s timeline. The original reading is retained.' })
        } else patch({ notice: errorMessage(timeline.reason) })
        if (history.status === 'fulfilled') {
          if (history.value.agentSessionId === id) patch({ page: history.value, olderWindow: Boolean(cursor), newerAvailable: false })
          else patch({ notice: 'The Host returned another Session’s history. The original reading is retained.' })
        } else patch({ notice: errorMessage(history.reason) })
      } finally {
        reading = false
        patch({ reading: false })
        if (live && dirty) { dirty = false; void refresh(requestedCursor) }
      }
    }
    refreshRef.current = refresh
    const unlisten = client.onEvent(event => {
      if (!live) return
      if (event.type === 'connection-state') {
        patch({ disconnected: event.state !== 'restored', notice: event.state === 'restored' ? null :
          'The original Host is unreachable. Reading and drafts are retained; unconfirmed writes are not resent.' })
        if (event.state === 'restored') void refresh(cursor)
      } else if (event.type === 'agent-session' && event.session.agentSessionId === id) {
        patch({ session: event.session })
      } else if (event.type === 'agent-timeline' && event.agentSessionId === id) {
        void refresh(cursor)
      } else if (event.type === 'agent-error' && (!event.agentSessionId || event.agentSessionId === id)) {
        patch({ notice: event.message })
      }
    })
    const lifetime = new AbortController()
    let releaseHistory: (() => void) | undefined
    void client.observeSessionHistory(id, observation => {
      if (!live || observation.agentSessionId !== id) return
      if (observation.kind === 'unavailable') patch({ notice: observation.message })
      else if (cursor) patch({ newerAvailable: true })
      else void refresh()
    }, { signal: lifetime.signal }).then(handle => {
      if (!live) handle.dispose()
      else releaseHistory = () => handle.dispose()
    }).catch(error => { patch({ notice: errorMessage(error) }) })
    void refresh()
    return () => {
      live = false
      lifetime.abort()
      releaseHistory?.()
      unlisten()
      refreshRef.current = null
    }
  }, [client, id, active])
  const refresh = useCallback(() => refreshRef.current?.(), [])
  const older = useCallback(() => {
    if (projection.id === id && projection.page?.nextCursor) return refreshRef.current?.(projection.page.nextCursor)
  }, [projection.id, projection.page, id])
  return { ...(projection.id === id ? projection : empty(id)), refresh, older }
}
