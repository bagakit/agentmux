import { createContext, useContext, type ComponentProps } from 'react'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { vi } from 'vitest'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { ActivityView as AcceptedActivityView } from '../../src/renderer/src/components/ActivityView'
import { ConversationView as AcceptedConversationView } from '@agentmux/client-ui/components/ConversationView'
import type { useSessionConversationWindow } from '../../src/renderer/src/lib/session-conversation-window'

const StaticWindow = createContext<ReturnType<typeof useSessionConversationWindow> | null>(null)
vi.mock('../../src/renderer/src/lib/session-conversation-window', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/lib/session-conversation-window')>()
  return { ...actual, useSessionConversationWindow: (...args: Parameters<typeof actual.useSessionConversationWindow>) => {
    const window = useContext(StaticWindow)
    // Explicit static presenter instances supply this context. A separately imported real
    // Activity uses the unchanged production hook and real public Reader, never raw props.
    return window ?? actual.useSessionConversationWindow(...args)
  } }
})

/** Static source fixtures go through the one pure Core facade, not the production Reader or a raw fallback. */
export function StaticConversationView(props: Omit<ComponentProps<typeof AcceptedConversationView>, 'records'>) {
  const projection = projectConversationReading({ agentSessionId: props.sessionId,
    ...(props.executionHostId === undefined ? {} : { executionHostId: props.executionHostId, routeHostId: props.executionHostId }),
    ...(props.page === undefined || props.page === null ? {} : { historyPage: props.page }),
    ...(props.timeline === undefined ? {} : { timeline: props.timeline }) })
  return <AcceptedConversationView {...props} records={projection.records} originalRecords={projection.originalRecords} coverage={projection.timeline.coverage} />
}

/** DOM/folding/Range/Copy fixture only. Real IPC/Hosted Reader qualification lives in conversation-reader-cutover. */
export function StaticActivityView(props: ComponentProps<typeof AcceptedActivityView> & { items: AgentTimelineSnapshot['items']; timelineSnapshot?: AgentTimelineSnapshot }) {
  const agentSessionId = props.sessionId ?? props.timelineSnapshot?.agentSessionId ?? props.nativeHistoryPage?.agentSessionId ?? props.items[0]?.agentSessionId
  if (!agentSessionId) throw new Error('A static fixture needs its original Session scope.')
  const timeline = props.timelineSnapshot ?? { agentSessionId, revision: 0, items: props.items }
  const page = props.nativeHistoryPage ?? null
  const accepted = projectConversationReading({ agentSessionId,
    ...(props.executionHostId === undefined ? {} : { executionHostId: props.executionHostId, routeHostId: props.executionHostId }),
    ...(page ? { historyPage: page } : {}), timeline })
  const captured = { ...timeline, agentSessionId, items: timeline.items.filter(item => item.agentSessionId === agentSessionId) }
  const noop = () => {}
  const window: ReturnType<typeof useSessionConversationWindow> = {
    acceptHeld: noop, presentationIntent: 0, page, projection: { ...accepted, historyPage: page ?? undefined, captured }, snapshot: null, capturedSnapshot: captured,
    captured: captured.items, capturedLoading: false, capturedHasMore: false,
    historical: false, hasEarlierNavigation: false, previousSource: false, coverageLoading: false,
    loading: false, error: null, automaticReadError: null, readActivity: { sourceRead: null, loading: false }, held: false, loadingEarlier: false, historyBoundary: null,
    currentOutside: false, newerOutside: false, hasNewer: false, hasMore: Boolean(page?.nextCursor),
    readCapturedEarlier: noop, readEarlier: noop, readNewer: noop, prepareEarlier: () => false, retryLabel: 'Retry', retry: noop, showLatestAutomatically: noop,
    inspect: () => ({ snapshot: null, loading: false, operation: null, sourceRead: null, error: null, errorOperation: null,
      sourceError: null, observationError: null, held: false, historical: false, newerAvailable: false, pending: null,
      dirty: null, inFlight: false, watch: { binding: false, bound: false, closed: null, windowId: null, invalidations: 0, unavailable: 0 } }),
    noteDiagnostic: noop,
    showCurrent: noop, showCurrentSource: noop, showPreviousSource: noop
  }
  const { items: _items, timelineSnapshot: _timeline, ...presenter } = props
  return <StaticWindow.Provider value={window}><AcceptedActivityView {...presenter} /></StaticWindow.Provider>
}
