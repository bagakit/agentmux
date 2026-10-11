import { readCapturedConversationPage, retainCapturedItems } from '@agentmux/client-ui/captured-conversation-page'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import { agentEvidenceStale, msUntilSemanticStatusStale, type AgentObservation } from '@agentmux/core/agent-status'
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
  pageOwner: { client: AgentMuxHostedClient; agentSessionId: string; hostId?: string; workspacePath?: string } | null
  answerContext: AgentSessionHistoryPage | null
  reading: boolean
  notice: string | null
  disconnected: boolean
  olderWindow: boolean
  capturedHasMore: boolean
  newerAvailable: boolean
  activity: { owner: object; hostId: string; runId: string; observation: AgentObservation } | null
}
const empty = (id: string | null): Projection => ({
  id, session: null, timeline: null, page: null, pageOwner: null, answerContext: null, reading: false, notice: null,
  disconnected: false, olderWindow: false, capturedHasMore: true, newerAvailable: false, activity: null
})

/** Retained readonly SDK projections; no history reconciliation, Run owner or local business queue. */
export function useHostedConversation(client: AgentMuxHostedClient | null, id: string | null, active: boolean, beforeCapturedCommit?: (snapshot: AgentTimelineSnapshot) => boolean) {
  const capturedGuard = useRef(beforeCapturedCommit); capturedGuard.current = beforeCapturedCommit
  const [projection, setProjection] = useState<Projection>(() => empty(id))
  const activityOwner = useMemo(() => ({}), [client, id, active])
  const projectionRef = useRef(projection); projectionRef.current = projection
  const currentPage = useRef(projection.page)
  currentPage.current = projection.id === id ? projection.page : null
  const capturedOlderRef = useRef<(() => Promise<void>) | null>(null)
  const timelineRef = useRef(projection.timeline); timelineRef.current = projection.id === id ? projection.timeline : null
  const refreshRef = useRef<((cursor?: string) => Promise<void>) | null>(null)
  const readingWindow = useRef<{ client: AgentMuxHostedClient | null; id: string | null; cursor?: string | undefined }>({ client, id })
  useEffect(() => {
    let live = true
    setProjection(value => value.id === id ? value : empty(id))
    if (!client || !id || !active) { refreshRef.current = null; capturedOlderRef.current = null; return }
    let reading = false, dirty = false
    let watchEpoch = 0
    let activityEpoch = 0, activityReading = false, activityDirty = false
    let activityExpiry: ReturnType<typeof setTimeout> | undefined
    function clearActivity() {
      activityEpoch++
      if (activityExpiry !== undefined) clearTimeout(activityExpiry)
      activityExpiry = undefined
      patch({ activity: null })
    }
    async function readActivity(): Promise<void> {
      if (!live || document.hidden || typeof client!.statusAgent !== 'function') return
      const generation = ++activityEpoch
      if (activityReading) { activityDirty = true; return }
      activityReading = true
      try {
        const value = await client!.statusAgent(id!)
        if (!live || generation !== activityEpoch) return
        const original = client!.agentSession(id!)
        if (value.session.agentSessionId !== id || original.agentSessionId !== id ||
            value.session.hostId !== original.hostId || value.session.run.runId !== original.run.runId ||
            value.run.runId !== original.run.runId) { clearActivity(); return }
        if (activityExpiry !== undefined) clearTimeout(activityExpiry)
        activityExpiry = undefined
        const { observation } = value
        // Core owns the active/readiness/process judgment and its freshness window.
        // This reader only expires the presentation, without changing a Session or input.
        if (observation.semantic === 'active' && agentEvidenceStale(observation, Date.now())) { clearActivity(); return }
        patch({ activity: { owner: activityOwner, hostId: original.hostId, runId: original.run.runId, observation } })
        if (observation.semantic === 'active') activityExpiry = setTimeout(() => {
          if (live && generation === activityEpoch) clearActivity()
        }, msUntilSemanticStatusStale({ state: 'working', observedAt: observation.observedAt }, Date.now()))
      } catch { if (live && generation === activityEpoch) clearActivity() }
      finally {
        activityReading = false
        if (live && activityDirty) { activityDirty = false; void readActivity() }
      }
    }
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
        } else if (cursor) { patch({ newerAvailable: true }); void refreshAnswers() }
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
    if (readingWindow.current.client !== client || readingWindow.current.id !== id) readingWindow.current = { client, id }
    let cursor = readingWindow.current.cursor
    let answersReading = false, answersDirty = false, answersRevision = 0
    const sameSource = (left: AgentSessionHistoryPage, right: AgentSessionHistoryPage) =>
      left.agentSessionId === right.agentSessionId && left.sourceHostId === right.sourceHostId && left.source.providerId === right.source.providerId && left.source.nativeSessionId === right.source.nativeSessionId
    async function refreshAnswers(): Promise<void> {
      if (!live || !cursor) return
      if (answersReading) { answersDirty = true; return }
      answersReading = true
      const epoch = watchEpoch, revision = ++answersRevision
      try {
        const page = await client!.sessionHistoryPage(id!, { limit: 30 })
        if (live && epoch === watchEpoch && revision === answersRevision && cursor && page.agentSessionId === id) {
          if (currentPage.current && sameSource(currentPage.current, page)) patch({ answerContext: page })
          else patch({ notice: 'The answer source changed. The original reading and drafts are retained.' })
        }
      } catch (error) { if (live && epoch === watchEpoch) patch({ notice: errorMessage(error) }) }
      finally { answersReading = false; if (live && answersDirty) { answersDirty = false; void refreshAnswers() } }
    }
    let capturedEpoch = 0
    let capturedCursor: string | null | undefined, capturedRevision: string | undefined, capturedOlder = false, capturedReading = false
    async function readCapturedOlder(): Promise<void> {
      if (!live || capturedReading || capturedCursor === null) return
      capturedReading = true; const epoch = ++capturedEpoch; patch({ reading: true })
      const original = timelineRef.current, base = original?.items ?? [], known = new Set(base.map(item => item.id))
      let incoming: AgentTimelineSnapshot['items'] = [], next: string | null | undefined = capturedCursor, scanned = 0
      try {
        let page: Awaited<ReturnType<typeof readCapturedConversationPage>>
        do {
          page = await readCapturedConversationPage(input => client!.readAgentSessionHistory(input), {
            hostId: 'local', agentSessionId: id!, limit: 100, ...(next ? { cursor: next } : {}) }, () => live && epoch === capturedEpoch)
          if (!live || epoch !== capturedEpoch) return
          if (original?.sourceHostId && original.sourceHostId !== page.snapshot.sourceHostId) throw new Error('The original captured source Host changed. Its reading and cursor are retained.')
          if (capturedRevision !== undefined && capturedRevision !== page.revision) throw new Error('Captured source changed. Original reading and cursor are retained; refresh Current.')
          incoming = retainCapturedItems(page.snapshot.items, incoming); scanned += page.snapshot.items.length; next = page.nextCursor
        } while (next && !incoming.some(item => !known.has(item.id)) && scanned <= 1200)
        const items = retainCapturedItems(incoming, base).slice(0, 1200)
        if (JSON.stringify(items).length * 2 > 12 * 1024 * 1024) throw new Error('Captured history exceeds this reading window. Original content/cursor and drafts are retained.')
        const timeline = { ...page.snapshot, items }; if (capturedGuard.current?.(timeline) === false) throw new Error('Original selected captured reading is retained. Release the selection and retry the same page.'); timelineRef.current = timeline
        capturedCursor = next; capturedRevision = page.revision; capturedOlder = true
        patch({ timeline, capturedHasMore: next !== null, olderWindow: true })
      } catch (error) { if (live) patch({ notice: errorMessage(error) }) }
      finally { if (epoch === capturedEpoch) { capturedReading = false; if (live) patch({ reading }) } }
    }
    capturedOlderRef.current = readCapturedOlder
    let requestedCursor: string | undefined
    const patch = (changes: Partial<Projection>) => {
      if (live) setProjection(value => ({ ...(value.id === id ? value : empty(id)), ...changes }))
    }
    async function refresh(nextCursor?: string): Promise<void> {
      if (!live) return
      if (reading) { dirty = true; requestedCursor = nextCursor; return }
      reading = true
      answersRevision++
      const epoch = watchEpoch
      cursor = nextCursor
      readingWindow.current.cursor = cursor
      patch({ reading: true, notice: null })
      void readActivity()
      try {
        // Each read fails independently: a native-history probe cannot suppress an existing
        // Session or its captured input projection, nor become an admission gate for a Prompt.
        let pageSession: AgentMuxAgentSession | undefined
        try {
          const session = client!.agentSession(id!)
          if (session.agentSessionId === id) { pageSession = session; patch({ session }) }
          else patch({ notice: 'The Host returned another Session’s metadata. The original reading is retained.' })
        }
        catch (error) { patch({ notice: errorMessage(error) }) }
        const [timeline, history] = await Promise.allSettled([
          client!.sessionTimeline(id!), client!.sessionHistoryPage(id!, { limit: 30, ...(cursor ? { cursor } : {}) })
        ])
        if (!live) return
        if (epoch !== watchEpoch) { dirty = true; requestedCursor = cursor; return }
        if (timeline.status === 'fulfilled') {
          if (timeline.value.agentSessionId !== id) patch({ notice: 'The Host returned another Session’s timeline. The original reading is retained.' })
          else if (!capturedOlder) {
            const prior = timelineRef.current
            const sourceChanged = projectionRef.current.pageOwner && projectionRef.current.pageOwner.client !== client &&
              !(history.status === 'fulfilled' && (!currentPage.current || sameSource(currentPage.current, history.value)))
            const value = prior && prior.agentSessionId === id ? { ...timeline.value, items: retainCapturedItems(prior.items, timeline.value.items).slice(-1200) } : timeline.value
            if (sourceChanged || capturedGuard.current?.(value) === false) patch({ newerAvailable: true,
              notice: 'Original captured reading is retained. Return Current after releasing the selection to read the newer source.' })
            else { timelineRef.current = value; patch({ timeline: value }) }
          }
        } else patch({ notice: errorMessage(timeline.reason) })
        if (history.status === 'fulfilled') {
          if (history.value.agentSessionId === id) {
            if (cursor && currentPage.current && !sameSource(currentPage.current, history.value)) {
              patch({ notice: 'The native source changed. The original reading and drafts are retained.' })
              return
            }
            currentPage.current = history.value
            patch({ page: history.value, pageOwner: { client: client!, agentSessionId: id!,
              ...(pageSession ? { hostId: pageSession.hostId, workspacePath: pageSession.workspacePath } : {}) },
              ...(!cursor ? { answerContext: history.value } : {}), olderWindow: Boolean(cursor) || capturedOlder, newerAvailable: false })
            if (cursor) void refreshAnswers()
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
    refreshRef.current = async nextCursor => { attemptedSource = null; if (!nextCursor) { capturedEpoch++; capturedReading = false; capturedCursor = undefined; capturedRevision = undefined; capturedOlder = false; patch({ capturedHasMore: true }) }; await refresh(nextCursor) }
    const unlisten = client.onEvent(event => {
      if (!live) return
      if (event.type === 'connection-state') {
        clearActivity()
        patch({ disconnected: event.state !== 'restored', notice: event.state === 'restored' ? null :
          'The original Host is unreachable. Reading and drafts are retained; unconfirmed writes are not resent.' })
        if (event.state === 'restored') { invalidateWatch(); void refresh(cursor) }
      } else if (event.type === 'agent-session' && event.session.agentSessionId === id) {
        clearActivity(); void readActivity()
        patch({ session: event.session })
        const nextLocator = locatorKey(event.session)
        if (nextLocator !== locator) {
          locator = nextLocator; invalidateWatch()
          void refresh(cursor)
        }
      } else if (event.type === 'agent-status' && event.agentSessionId === id) {
        clearActivity(); void readActivity()
      } else if (event.type === 'process-state' && event.agentSessionId === id) {
        try {
          if (event.run.runId === client.agentSession(id).run.runId) { clearActivity(); void readActivity() }
        } catch { clearActivity() }
      } else if (event.type === 'agent-timeline' && event.agentSessionId === id) {
        if (cursor) { patch({ newerAvailable: true }); void refreshAnswers() }
        else void refresh()
      } else if (event.type === 'agent-error' && (!event.agentSessionId || event.agentSessionId === id)) {
        patch({ notice: event.message })
      }
    })
    const foreground = () => {
      if (document.visibilityState === 'hidden') { clearActivity(); if (recoveryTimer) clearTimeout(recoveryTimer); recoveryTimer = undefined; return }
      void readActivity()
      if (!watchEstablished) { attemptedSource = null; void refresh(cursor) }
    }
    document.addEventListener('visibilitychange', foreground)
    void refresh(cursor)
    return () => {
      live = false
      if (activityExpiry !== undefined) clearTimeout(activityExpiry)
      invalidateWatch()
      if (recoveryTimer) clearTimeout(recoveryTimer)
      document.removeEventListener('visibilitychange', foreground)
      unlisten()
      refreshRef.current = null; capturedOlderRef.current = null
    }
  }, [client, id, active, activityOwner])
  const refresh = useCallback(() => refreshRef.current?.(), [])
  const older = useCallback(() => {
    if (projection.id !== id) return
    const native = projection.page?.nextCursor ? refreshRef.current?.(projection.page.nextCursor) : undefined
    return Promise.all([native, capturedOlderRef.current?.()])
  }, [projection.id, projection.page, id])
  const selected = projection.id === id ? projection : empty(id)
  const activity = active && !selected.disconnected && selected.activity?.owner === activityOwner &&
    selected.activity.hostId === selected.session?.hostId && selected.activity.runId === selected.session?.run.runId
    ? selected.activity.observation : null
  return { ...selected, activity, refresh, older }
}
