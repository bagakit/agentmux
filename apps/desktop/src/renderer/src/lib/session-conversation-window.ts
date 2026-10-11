import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionHistoryPage, AgentSessionHistorySource, AgentTimelineSnapshot } from '@agentmux/core'
import { useConversationView, type ConversationViewOperation } from '@agentmux/client-ui/use-conversation-view'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { api } from './api'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { nativeBindingKey, type AgentNativeSourceFacts } from '../../../shared/agent-native-source'

export type ConversationReading = {
  reference: SessionHistoryReference
  /** A live Run fences the window; a retired Session needs no invented Run. */
  identity: string
  enabled: boolean
  opened?: boolean
  onClose?: (() => void) | undefined
  readCaptured?: boolean
  returnLabel?: string
  /** Core-confirmed sources; a new binding does not replace an open reading window. */
  nativeSourceFacts?: AgentNativeSourceFacts
  /** Presentation facts supplied by the existing host; absent facts remain unknown. */
  consumer?: { runId?: string; regionId?: string; presentationId?: string; visible: boolean; parked?: boolean; activityShown: boolean; viewMode: string }
}
export type ConversationReadingIntent = 'current' | 'seed' | 'earlier' | 'newer' | 'coverage' | 'live'
export { conversationReadingAnchor, protectsConversationWindow, restoreConversationAnchor, type ConversationWindowProjection } from '@agentmux/client-ui/conversation-reading-anchor'
import type { ConversationWindowProjection } from '@agentmux/client-ui/conversation-reading-anchor'

function handleSource(handle: AgentNativeSourceFacts['nativeHandle']): AgentSessionHistorySource | undefined {
  return handle?.kind === 'provider' ? { providerId: handle.providerId, nativeSessionId: handle.sessionId } : undefined
}
const matchesSource = (a: AgentSessionHistorySource, b?: AgentSessionHistorySource) => !!b && a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId

/** DOM reading state over complete frames from the one public backend Reader. */
export function useSessionConversationWindow(reading: ConversationReading | undefined,
  beforeCommit: (page: AgentSessionHistoryPage, intent: ConversationReadingIntent, currentOriginal?: AgentSessionHistoryPage, projection?: ConversationWindowProjection) => boolean,
  coverageDuration = 24 * 3_600_000, beforeCapturedCommit?: (snapshot: AgentTimelineSnapshot) => boolean) {
  const displayed = useRef<AgentSessionHistoryPage | null>(null)
  const boundary = useRef<string | null>(null)
  const intent = useRef<ConversationReadingIntent>('seed')
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const key = reading ? JSON.stringify([reading.reference.hostId, reading.reference.agentSessionId, reading.identity]) : ''
  const bindingKey = reading?.nativeSourceFacts ? nativeBindingKey(reading.nativeSourceFacts) : ''
  const acceptedBinding = useRef({ key, bindingKey })
  const view = useConversationView(api.conversation, reading?.reference, reading?.enabled === true, {
    ...(reading ? { identity: reading.identity } : {}),
    beforeCommit: (snapshot, operation) => {
      const next = projectConversationWindow(snapshot), page = next.historyPage
      const currentIntent = operation === 'changes' ? 'live' : intent.current
      if (page && !beforeCommit(page, currentIntent, displayed.current ?? undefined, { current: displayed.current,
        ...(boundary.current ? { recordBoundary: { beforeRecordId: boundary.current } } : {}) })) return false
      if (beforeCapturedCommit?.(next.captured) === false) return false
      acceptedBinding.current = { key, bindingKey }
      return true
    }
  })
  const projection = useMemo(() => view.snapshot ? projectConversationWindow(view.snapshot) : null, [view.snapshot])
  const page = projection?.historyPage ?? null
  displayed.current = page
  const currentSource = handleSource(reading?.nativeSourceFacts?.nativeHandle)
  const previousSource = Boolean(page && currentSource && !matchesSource(page.source, currentSource))
  const bindingChanged = acceptedBinding.current.key === key && acceptedBinding.current.bindingKey !== bindingKey
  const navigate = (operation: ConversationViewOperation) => {
    intent.current = operation === 'older' ? 'earlier' : operation === 'newer' ? 'newer' : operation === 'latest' ? 'current' : 'live'
    if (operation === 'older' && !boundary.current) boundary.current = page?.items[0]?.id ?? null
    if (operation === 'latest') { boundary.current = null; setCoverageError(null) }
    return operation === 'older' ? view.earlier() : operation === 'newer' ? view.newer() : operation === 'changes' ? view.changes() : view.refresh()
  }
  useEffect(() => { boundary.current = null; intent.current = 'seed'; setCoverageError(null) }, [key])
  useEffect(() => {
    if (!view.held || !reading?.enabled) return
    const changed = () => view.acceptHeld()
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [view.held, view.acceptHeld, reading?.enabled])
  // A time-range selection admits bounded complete Core pages. No raw records or
  // Provider positions are accumulated by this presentation.
  const coverageDemand = useRef(false)
  useEffect(() => { coverageDemand.current = true; setCoverageError(null) }, [key, coverageDuration])
  useEffect(() => {
    if (view.error) { coverageDemand.current = false; return }
    if (!coverageDemand.current || !reading?.enabled || view.loading || view.held || !page || !view.hasMore || bindingChanged) return
    const times = page.items.flatMap(item => item.startedAt === undefined ? [] : [item.startedAt])
    if (coverageDuration !== Infinity && (!times.length || Math.max(...times) - Math.min(...times) >= coverageDuration)) { coverageDemand.current = false; return }
    const count = view.snapshot?.units.reduce((total, unit) => total + unit.records.length, 0) ?? 0
    if (count >= 1200 || view.snapshot?.window.outside.newer) {
      coverageDemand.current = false; setCoverageError('The selected time range exceeds this bounded reading window. Scroll earlier to continue.'); return
    }
    intent.current = 'coverage'; void view.earlier()
  }, [page, view.loading, view.held, view.hasMore, view.error, reading?.enabled, bindingChanged, coverageDuration])
  const selectSource = (source?: AgentSessionHistorySource) => {
    intent.current = 'current'; boundary.current = null; coverageDemand.current = false; setCoverageError(null)
    if (source) void view.selectSource(source); else void view.refresh()
  }
  const error = view.error?.message ?? view.observationError?.message ?? (bindingChanged ? 'Native source changed. The original window is retained; explicitly open Current source or Previous source.' : coverageError)
  const currentOutside = Boolean(view.snapshot?.window.navigation.newer || view.newerAvailable || view.held)
  return { page, projection, snapshot: view.snapshot, inspect: view.inspect, capturedSnapshot: projection?.captured,
    captured: projection?.captured.items ?? null, capturedLoading: view.loading, capturedHasMore: view.hasMore,
    readCapturedEarlier: () => { coverageDemand.current = false; void navigate('older') }, capturedError: view.sourceError ? null : error,
    historical: view.historical || previousSource || bindingChanged, hasEarlierNavigation: Boolean(boundary.current) || previousSource,
    previousSource, coverageLoading: view.loading && intent.current === 'coverage', loading: view.loading, error,
    held: view.held, loadingEarlier: view.loading && intent.current === 'earlier',
    historyBoundary: boundary.current && page?.items.some(item => item.id === boundary.current) ? { beforeRecordId: boundary.current } : null,
    currentOutside, newerOutside: currentOutside, hasNewer: view.hasNewer, hasMore: view.hasMore,
    readEarlier: () => { coverageDemand.current = false; void navigate('older') }, readNewer: () => { coverageDemand.current = false; void navigate('newer') },
    retry: () => { void view.retry() }, showLatestAutomatically: () => { if (view.held) view.acceptHeld(); else if (!view.historical && view.newerAvailable) void navigate('changes') },
    showCurrent: () => { coverageDemand.current = false; void navigate('latest') },
    showCurrentSource: () => selectSource(currentSource), showPreviousSource: () => selectSource(handleSource(reading?.nativeSourceFacts?.nativeConfirmation?.previousNativeHandle)) }
}
