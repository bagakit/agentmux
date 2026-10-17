import { useEffect, useMemo, useRef } from 'react'
import type { AgentSessionHistoryPage, AgentSessionHistorySource, AgentTimelineSnapshot } from '@agentmux/core'
import { useConversationView, type ConversationViewOperation } from '@agentmux/client-ui/use-conversation-view'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { CONVERSATION_MAX_WINDOW_RECORDS } from '@agentmux/core/conversation'
import { api } from './api'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { nativeBindingKey, type AgentNativeSourceFacts } from '../../../shared/agent-native-source'
import { useWorkbenchDocument } from './workbench-document'
import { desktopConversationDiagnostics } from './conversation-diagnostic-options'
import type { ReadingDiagnosticReason } from '@agentmux/core/reading-diagnostic'

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
  coverageDuration = 24 * 3_600_000, beforeCapturedCommit?: (snapshot: AgentTimelineSnapshot, displayed?: AgentTimelineSnapshot) => boolean) {
  const document = useWorkbenchDocument()
  const displayed = useRef<AgentSessionHistoryPage | null>(null)
  const boundary = useRef<string | null>(null)
  const intent = useRef<ConversationReadingIntent>('seed')
  const admissionIntent = useRef<ConversationReadingIntent>('seed')
  const key = reading ? JSON.stringify([reading.reference.hostId, reading.reference.agentSessionId, reading.identity]) : ''
  const bindingKey = reading?.nativeSourceFacts ? nativeBindingKey(reading.nativeSourceFacts) : ''
  const acceptedBinding = useRef({ key, bindingKey })
  const coverageDemand = useRef({ key, duration: coverageDuration, remaining: 2 })
  const protectionReason = useRef<ReadingDiagnosticReason>('unknown')
  const view = useConversationView(api.conversation, reading?.reference, reading?.enabled === true, {
    ...(reading ? { identity: reading.identity } : {}),
    diagnostics: desktopConversationDiagnostics('conversation-pane', reading?.consumer?.runId),
    heldReason: () => protectionReason.current,
    beforeCommit: (snapshot, operation, displayedFrame, replayingHeldIntent) => {
      protectionReason.current = 'unknown'
      const next = projectConversationWindow(snapshot), page = next.historyPage
      const currentIntent = replayingHeldIntent ? admissionIntent.current
        : operation === 'changes' || operation === 'reopen' || operation === 'resume' ? 'live' : intent.current
      admissionIntent.current = currentIntent
      // The accepted current page is the first page of this explicit batch.
      if (!replayingHeldIntent && operation === 'latest') coverageDemand.current.remaining = 2
      if (beforeCapturedCommit?.(next.captured, displayedFrame ? projectConversationWindow(displayedFrame).captured : undefined) === false) {
        protectionReason.current = 'captured-reading-protection'; return false
      }
      if (page && !beforeCommit(page, currentIntent, displayed.current ?? undefined, { current: displayed.current,
        ...(boundary.current ? { recordBoundary: { beforeRecordId: boundary.current } } : {}) })) {
        protectionReason.current = 'native-reading-protection'; return false
      }
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
    if (operation === 'latest') boundary.current = null
    return operation === 'older' ? view.earlier() : operation === 'newer' ? view.newer() : operation === 'changes' ? view.changes() : view.refresh()
  }
  useEffect(() => { boundary.current = null; intent.current = 'seed'; admissionIntent.current = 'seed' }, [key])
  useEffect(() => {
    if (!view.held || !reading?.enabled) return
    const changed = () => view.acceptHeld()
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [document, view.held, view.acceptHeld, reading?.enabled])
  // A time-range selection admits bounded complete Core pages. No raw records or
  // Provider positions are accumulated by this presentation.
  useEffect(() => {
    const previous = coverageDemand.current
    coverageDemand.current = { key, duration: coverageDuration, remaining: previous.key !== key ? 2
      : coverageDuration > previous.duration ? 3 : coverageDuration < previous.duration ? 0 : previous.remaining }
  }, [key, coverageDuration])
  useEffect(() => {
    if (view.error || view.held || !reading?.enabled || bindingChanged) { coverageDemand.current.remaining = 0; return }
    if (!coverageDemand.current.remaining || view.loading || !page) return
    if (!view.hasMore) { coverageDemand.current.remaining = 0; return }
    const times = page.items.flatMap(item => item.startedAt === undefined ? [] : [item.startedAt])
    if (coverageDuration !== Infinity && (!times.length || Math.max(...times) - Math.min(...times) >= coverageDuration)) { coverageDemand.current.remaining = 0; return }
    const count = view.snapshot?.units.reduce((total, unit) => total + unit.records.length, 0) ?? 0
    const sources = view.snapshot?.scope.sources.filter(source => source.kind === 'native' || source.kind === 'captured').length ?? 1
    const limit = Math.min(100, Math.floor((CONVERSATION_MAX_WINDOW_RECORDS - count) / Math.max(1, sources)))
    if (limit <= 0 || view.snapshot?.window.outside.newer) {
      coverageDemand.current.remaining = 0; return
    }
    coverageDemand.current.remaining--
    intent.current = 'coverage'; void view.earlier(limit)
  }, [page, view.loading, view.held, view.hasMore, view.error, reading?.enabled, bindingChanged, coverageDuration])
  const selectSource = (source?: AgentSessionHistorySource) => {
    intent.current = 'current'; boundary.current = null; coverageDemand.current.remaining = 0
    if (source) void view.selectSource(source); else void view.refresh()
  }
  const automaticReadError = intent.current === 'coverage' && view.errorOperation === 'older' ? view.error : null
  const error = (automaticReadError ? null : view.error?.message) ?? view.observationError?.message ?? (bindingChanged ? 'Native source changed. The original window is retained; explicitly open Current source or Previous source.' : null)
  const currentOutside = Boolean(view.snapshot?.window.navigation.newer || view.newerAvailable || view.held)
  const expiredHistorical = view.historical && (view.error as { code?: string } | null)?.code === 'AGENT_CONVERSATION_VIEW_EXPIRED'
  return { page, projection, snapshot: view.snapshot, readActivity: { sourceRead: view.sourceRead, loading: view.loading }, inspect: view.inspect, noteDiagnostic: view.noteDiagnostic, capturedSnapshot: projection?.captured,
    captured: projection?.captured.items ?? null, capturedLoading: view.loading, capturedHasMore: view.hasMore,
    readCapturedEarlier: () => { coverageDemand.current.remaining = 0; void navigate('older') },
    historical: view.historical || previousSource || bindingChanged, hasEarlierNavigation: Boolean(boundary.current) || previousSource,
    previousSource, coverageLoading: view.loading && view.operation === 'older' && intent.current === 'coverage', loading: view.loading, error, automaticReadError,
    held: view.held, loadingEarlier: view.loading && view.operation === 'older' && intent.current === 'earlier',
    historyBoundary: boundary.current && page?.items.some(item => item.id === boundary.current) ? { beforeRecordId: boundary.current } : null,
    currentOutside, newerOutside: currentOutside, hasNewer: view.hasNewer, hasMore: view.hasMore,
    readEarlier: () => { coverageDemand.current.remaining = 0; void navigate('older') }, readNewer: () => { coverageDemand.current.remaining = 0; void navigate('newer') },
    retryLabel: expiredHistorical ? 'Read current records' : 'Retry',
    retry: () => {
      if (expiredHistorical) {
        const original = view.snapshot?.scope.sources.find(source => source.kind === 'native')
        selectSource(original?.kind === 'native' ? { providerId: original.providerId, nativeSessionId: original.nativeSessionId } : undefined)
      } else void view.retry()
    }, showLatestAutomatically: () => { if (view.held) view.acceptHeld(); else if (!view.historical && view.newerAvailable) void navigate('changes') },
    showCurrent: () => { coverageDemand.current.remaining = 0; void navigate('latest') },
    showCurrentSource: () => selectSource(currentSource), showPreviousSource: () => selectSource(handleSource(reading?.nativeSourceFacts?.nativeConfirmation?.previousNativeHandle)) }
}
