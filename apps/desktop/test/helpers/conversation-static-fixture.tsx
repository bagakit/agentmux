import { createContext, useContext, type ComponentProps } from 'react'
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
export function StaticActivityView(props: ComponentProps<typeof AcceptedActivityView>) {
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
    page, projection: { ...accepted, historyPage: page ?? undefined, captured }, snapshot: null, capturedSnapshot: captured,
    captured: captured.items, capturedLoading: false, capturedHasMore: false, capturedError: null,
    historical: false, hasEarlierNavigation: false, previousSource: false, coverageLoading: false,
    loading: false, error: null, readActivity: { sourceRead: null, loading: false }, held: false, loadingEarlier: false, historyBoundary: null,
    currentOutside: false, newerOutside: false, hasNewer: false, hasMore: Boolean(page?.nextCursor),
    readCapturedEarlier: noop, readEarlier: noop, readNewer: noop, retry: noop, showLatestAutomatically: noop,
    showCurrent: noop, showCurrentSource: noop, showPreviousSource: noop
  }
  return <StaticWindow.Provider value={window}><AcceptedActivityView {...props} /></StaticWindow.Provider>
}
