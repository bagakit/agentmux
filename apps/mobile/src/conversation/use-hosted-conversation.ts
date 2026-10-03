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
    let watchEpoch = 0
    let watchAbort: AbortController | undefined
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined, recoveryDelay = 1000
    const canRecover = (error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      return !['AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED', 'INVALID_CONTROL_REQUEST', 'CONTROL_PERMISSION_DENIED'].includes(code)
    }
    function recoverReading() {
      if (!live || recoveryTimer || document.visibilityState === 'hidden') return
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined
        if (!live || document.visibilityState === 'hidden') return
        attemptedSource = null
        void refresh(cursor)
      }, recoveryDelay)
      recoveryDelay = Math.min(recoveryDelay * 2, 15000)
    }
    function invalidateWatch() {
      watchEpoch++; watchAbort?.abort(); watchPending = false; watchEstablished = false; attemptedSource = null
      releaseHistory?.(); releaseHistory = undefined
    }
    let releaseHistory: (() => void) | undefined
    let watchPending = false, watchEstablished = false, attemptedSource: string | null = null
    let locator = ''
    const locatorKey = (session: AgentMuxAgentSession) => JSON.stringify([session.run, session.hostId, session.nativeHandle, session.observedNativeHandle])
    try { locator = locatorKey(client.agentSession(id)) } catch { /* The original reference remains. */ }
    function ensureHistoryWatch(sourceKey: string) {
      if (!live || watchPending || watchEstablished || attemptedSource === sourceKey) return
      attemptedSource = sourceKey; watchPending = true
      const epoch = watchEpoch, controller = new AbortController(); watchAbort = controller
      void client!.observeSessionHistory(id!, observation => {
        if (!live || epoch !== watchEpoch || observation.agentSessionId !== id) return
        if (observation.kind === 'unavailable') {
          invalidateWatch(); recoverReading()
          patch({ notice: observation.message })
        } else if (cursor) patch({ newerAvailable: true })
        else void refresh()
      }, { signal: controller.signal }).then(handle => {
        if (!live || epoch !== watchEpoch) handle.dispose()
        else { watchEstablished = true; releaseHistory = () => handle.dispose(); recoveryDelay = 1000; if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = undefined } }
      }).catch(error => {
        if (!live || epoch !== watchEpoch) return
        watchEstablished = false; attemptedSource = null; patch({ notice: errorMessage(error) })
        if (canRecover(error)) recoverReading()
      }).finally(() => { if (epoch === watchEpoch) watchPending = false })
    }
    let cursor: string | undefined
    let requestedCursor: string | undefined
    const patch = (changes: Partial<Projection>) => {
      if (live) setProjection(value => ({ ...(value.id === id ? value : empty(id)), ...changes }))
    }
    async function refresh(nextCursor?: string): Promise<void> {
      if (!live) return
      if (reading) { dirty = true; requestedCursor = nextCursor; return }
      reading = true
      const epoch = watchEpoch
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
        if (epoch !== watchEpoch) { dirty = true; requestedCursor = cursor; return }
        if (timeline.status === 'fulfilled') {
          if (timeline.value.agentSessionId === id) patch({ timeline: timeline.value })
          else patch({ notice: 'The Host returned another Session’s timeline. The original reading is retained.' })
        } else patch({ notice: errorMessage(timeline.reason) })
        if (history.status === 'fulfilled') {
          if (history.value.agentSessionId === id) {
            patch({ page: history.value, olderWindow: Boolean(cursor), newerAvailable: false })
            // A successfully confirmed native source is the earliest valid point to establish its watch.
            // The initial failed probe never permanently retires this visible reader.
            ensureHistoryWatch(JSON.stringify([history.value.source, client!.agentSession(id!).run]))
          }
          else patch({ notice: 'The Host returned another Session’s history. The original reading is retained.' })
        } else { patch({ notice: errorMessage(history.reason) }); if (canRecover(history.reason)) recoverReading() }
      } finally {
        reading = false
        patch({ reading: false })
        if (live && dirty) { dirty = false; void refresh(requestedCursor) }
      }
    }
    refreshRef.current = async nextCursor => { attemptedSource = null; await refresh(nextCursor) }
    const unlisten = client.onEvent(event => {
      if (!live) return
      if (event.type === 'connection-state') {
        patch({ disconnected: event.state !== 'restored', notice: event.state === 'restored' ? null :
          'The original Host is unreachable. Reading and drafts are retained; unconfirmed writes are not resent.' })
        if (event.state === 'restored') { invalidateWatch(); void refresh(cursor) }
      } else if (event.type === 'agent-session' && event.session.agentSessionId === id) {
        patch({ session: event.session })
        const nextLocator = locatorKey(event.session)
        if (nextLocator !== locator) {
          locator = nextLocator; invalidateWatch()
          void refresh(cursor)
        }
      } else if (event.type === 'agent-timeline' && event.agentSessionId === id) {
        void refresh(cursor)
      } else if (event.type === 'agent-error' && (!event.agentSessionId || event.agentSessionId === id)) {
        patch({ notice: event.message })
      }
    })
    const foreground = () => {
      if (document.visibilityState === 'hidden') { if (recoveryTimer) clearTimeout(recoveryTimer); recoveryTimer = undefined; return }
      if (!watchEstablished) { attemptedSource = null; void refresh(cursor) }
    }
    document.addEventListener('visibilitychange', foreground)
    void refresh()
    return () => {
      live = false
      invalidateWatch()
      if (recoveryTimer) clearTimeout(recoveryTimer)
      document.removeEventListener('visibilitychange', foreground)
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
