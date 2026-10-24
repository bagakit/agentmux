import { useEffect, useMemo, useRef } from 'react'
import type { AgentSessionHistoryPage, AgentSessionHistorySource } from '@agentmux/core'
import { useConversationView, type ConversationViewOperation } from '@agentmux/client-ui/use-conversation-view'
import { describeConversationWindow, projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { CONVERSATION_MAX_WINDOW_RECORDS, type ConversationItemRef, type ConversationReadOptions, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import { api } from './api'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { nativeSourceKey, type AgentNativeSourceFacts } from '../../../shared/agent-native-source'
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
export type ConversationReadingIntent = 'current' | 'record' | 'seed' | 'earlier' | 'newer' | 'coverage' | 'live'
export { conversationReadingAnchor, restoreConversationAnchor } from '@agentmux/client-ui/conversation-reading-anchor'

function handleSource(handle: AgentNativeSourceFacts['nativeHandle']): AgentSessionHistorySource | undefined {
  return handle?.kind === 'provider' ? { providerId: handle.providerId, nativeSessionId: handle.sessionId } : undefined
}
const matchesSource = (a: AgentSessionHistorySource, b?: AgentSessionHistorySource) => !!b && a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId

function remainingReadLimit(snapshot: ConversationWindowSnapshot | null): number {
  const count = snapshot?.units.reduce((total, unit) => total + unit.records.length, 0) ?? 0
  const sources = snapshot?.scope.sources.filter(source => source.kind === 'native' || source.kind === 'captured').length ?? 1
  return Math.min(100, Math.floor((CONVERSATION_MAX_WINDOW_RECORDS - count) / Math.max(1, sources)))
}

/** DOM reading state over complete frames from the one public backend Reader. */
export function useSessionConversationWindow(reading: ConversationReading | undefined,
  beforeCommit: (frame: ReturnType<typeof projectConversationWindow>, intent: ConversationReadingIntent, beforeRecordId?: string) => boolean,
  coverageDuration = 24 * 3_600_000) {
  const presentationIntent = useRef(0)
  const boundary = useRef<string | null>(null)
  const intent = useRef<ConversationReadingIntent>('seed')
  const admissionIntent = useRef<ConversationReadingIntent>('seed')
  const key = reading ? JSON.stringify([reading.reference.hostId, reading.reference.agentSessionId, reading.identity]) : ''
  // Confirming the same target changes authority, not the source of this open reading window.
  const bindingKey = reading?.nativeSourceFacts ? nativeSourceKey(reading.nativeSourceFacts) : ''
  const acceptedBinding = useRef({ key, bindingKey })
  const coverageDemand = useRef({ key, duration: coverageDuration, remaining: 2 })
  const protectionReason = useRef<ReadingDiagnosticReason>('unknown')
  const view = useConversationView(api.conversation, reading?.reference, reading?.enabled === true, {
    ...(reading ? { identity: reading.identity } : {}),
    diagnostics: desktopConversationDiagnostics('conversation-pane', reading?.consumer?.runId),
    heldReason: () => protectionReason.current,
    beforeCommit: (snapshot, operation, _displayedFrame, replayingHeldIntent) => {
      protectionReason.current = 'unknown'
      const next = projectConversationWindow(snapshot)
      const currentIntent = replayingHeldIntent ? admissionIntent.current
        : operation === 'changes' || operation === 'reopen' || operation === 'resume' ? 'live' : intent.current
      admissionIntent.current = currentIntent
      if (!beforeCommit(next, currentIntent, boundary.current ?? undefined)) {
        protectionReason.current = 'native-reading-protection'; return false
      }
      // The accepted current page is the first page of this explicit batch.
      if (operation === 'latest') coverageDemand.current.remaining = snapshot.window.anchor ? 0 : 2
      if (operation === 'latest') presentationIntent.current++
      acceptedBinding.current = { key, bindingKey }
      return true
    }
  })
  const projection = useMemo(() => view.reading ? describeConversationWindow(view.reading) : null, [view.reading])
  const page = projection?.historyPage ?? null
  // Headers retain the original position and time even when their unread body
  // is absent from the complete-record compatibility projection.
  const nativeMetadata = useMemo(() => [...view.snapshot?.units ?? []].reverse().flatMap(unit =>
    unit.records.flatMap<{ id: string; startedAt?: number; completedAt?: number }>(record => record.original.kind === 'native' ? [record.original.item]
      : record.original.kind === 'deferred' && record.original.item.kind === 'native' ? [record.original.item.item] : [])), [view.snapshot])
  const currentSource = handleSource(reading?.nativeSourceFacts?.nativeHandle)
  const previousSource = Boolean(page && currentSource && !matchesSource(page.source, currentSource))
  const bindingChanged = acceptedBinding.current.key === key && acceptedBinding.current.bindingKey !== bindingKey
  const navigate = (operation: ConversationViewOperation) => {
    intent.current = operation === 'older' ? 'earlier' : operation === 'newer' ? 'newer' : operation === 'latest' ? 'current' : 'live'
    if (operation === 'older' && !boundary.current) boundary.current = nativeMetadata[0]?.id ?? null
    if (operation === 'latest') boundary.current = null
    return operation === 'older' ? view.earlier() : operation === 'newer' ? view.newer() : operation === 'changes' ? view.changes() : view.refresh()
  }
  useEffect(() => { boundary.current = null; intent.current = 'seed'; admissionIntent.current = 'seed' }, [key])
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
    const times = nativeMetadata.flatMap(item => item.startedAt === undefined ? [] : [item.startedAt])
    if (coverageDuration !== Infinity && (!times.length || Math.max(...times) - Math.min(...times) >= coverageDuration)) { coverageDemand.current.remaining = 0; return }
    const limit = remainingReadLimit(view.snapshot)
    if (limit <= 0 || view.snapshot?.window.outside.newer) {
      coverageDemand.current.remaining = 0; return
    }
    coverageDemand.current.remaining--
    intent.current = 'coverage'; void view.earlier(limit)
  }, [page, nativeMetadata, view.loading, view.held, view.hasMore, view.error, reading?.enabled, bindingChanged, coverageDuration])
  const selectSource = (source?: AgentSessionHistorySource) => {
    intent.current = 'current'; boundary.current = null; coverageDemand.current.remaining = 0
    if (source) void view.selectSource(source); else void view.refresh()
  }
  const automaticReadError = intent.current === 'coverage' && view.errorOperation === 'older' ? view.error : null
  const error = (automaticReadError ? null : view.error?.message) ?? view.observationError?.message ?? (bindingChanged ? 'Native source changed. The original window is retained; explicitly open Current source or Previous source.' : null)
  const currentOutside = Boolean(view.snapshot?.window.navigation.newer || view.newerAvailable || view.held)
  const expiredHistorical = view.historical && (view.error as { code?: string } | null)?.code === 'AGENT_CONVERSATION_VIEW_EXPIRED'
  const boundaryIndex = nativeMetadata.findIndex(item => item.id === boundary.current)
  const previousRecord = nativeMetadata[boundaryIndex - 1]
  return { page, projection, acceptHeld: view.acceptHeld, presentationIntent: presentationIntent.current, snapshot: view.snapshot, readActivity: { sourceRead: view.sourceRead, loading: view.loading }, readProcessDetail: view.readProcessDetail, inspect: view.inspect, noteDiagnostic: view.noteDiagnostic, capturedSnapshot: projection?.captured,
    captured: projection?.captured.items ?? null, capturedLoading: view.loading, capturedHasMore: view.hasMore,
    readCapturedEarlier: () => { coverageDemand.current.remaining = 0; void navigate('older') },
    historical: view.historical || previousSource || bindingChanged, hasEarlierNavigation: Boolean(boundary.current) || previousSource,
    previousSource, coverageLoading: view.loading && view.operation === 'older' && intent.current === 'coverage', loading: view.loading, error, automaticReadError,
    held: view.held, loadingEarlier: view.loading && view.operation === 'older' && intent.current === 'earlier',
    historyBoundary: boundary.current && boundaryIndex > 0 ? { beforeRecordId: boundary.current,
      recordedAt: previousRecord?.completedAt ?? previousRecord?.startedAt } : null,
    currentOutside, newerOutside: currentOutside, hasNewer: view.hasNewer, hasMore: view.hasMore,
    readEarlier: () => { coverageDemand.current.remaining = 0; void navigate('older') }, readNewer: () => { coverageDemand.current.remaining = 0; void navigate('newer') },
    prepareEarlier: () => {
      if (!reading?.enabled || view.loading || view.held || view.error || !view.hasMore) return false
      coverageDemand.current.remaining = 0
      intent.current = 'earlier'
      if (!boundary.current) boundary.current = nativeMetadata[0]?.id ?? null
      // Actual directional reading may slide the Core window. Presentation
      // admission still protects the visible original, selection and return path.
      void view.earlier(100)
      return true
    },
    retryLabel: expiredHistorical ? 'Read current records' : 'Retry',
    retry: () => {
      if (expiredHistorical) {
        const original = view.snapshot?.scope.sources.find(source => source.kind === 'native')
        selectSource(original?.kind === 'native' ? { providerId: original.providerId, nativeSessionId: original.nativeSessionId } : undefined)
      } else void view.retry()
    }, showLatestAutomatically: () => { if (view.held) view.acceptHeld(); else if (!view.error && !view.historical && view.newerAvailable) void navigate('changes') },
    selectRecord: (record: ConversationItemRef, readOptions?: ConversationReadOptions) => {
      intent.current = 'record'; boundary.current = null; coverageDemand.current.remaining = 0
      return view.selectRecord(record, readOptions)
    },
    showCurrent: () => { coverageDemand.current.remaining = 0; void navigate('latest') },
    showCurrentSource: () => selectSource(currentSource), showPreviousSource: () => selectSource(handleSource(reading?.nativeSourceFacts?.nativeConfirmation?.previousNativeHandle)) }
}
