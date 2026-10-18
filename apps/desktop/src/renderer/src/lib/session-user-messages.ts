import { useCallback, useEffect, useMemo, useRef } from 'react'
import { projectConversationWindow, type AgentConversationRecordSource } from '@agentmux/core/conversation'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from './api'
import { desktopConversationDiagnostics } from './conversation-diagnostic-options'

export type AgentSessionControlInput = AgentSessionControl
export function useSessionUserMessages(control?: AgentSessionControlInput, options?: { enabled?: boolean; initialInputs?: number }) {
  const enabled = (options?.enabled ?? true) && Boolean(control), target = options?.initialInputs ?? 0
  const key = control ? JSON.stringify([control.hostId, control.agentSessionId, control.run.runId]) : ''
  const initial = useRef({ key, batches: 1, settled: target === 0 })
  if (initial.current.key !== key) initial.current = { key, batches: 1, settled: target === 0 }
  const demand = initial.current
  const view = useConversationView(api.conversation, control, enabled, { ...(control ? { identity: control.run.runId } : {}),
    diagnostics: desktopConversationDiagnostics('input-summary', control?.run.runId) })
  const page = view.reading?.historyPage ?? null
  const messages = useMemo(() => view.reading?.inputs ?? [], [view.reading])
  // This visible consumer seeks inputs through its original canonical window.
  // Wire fragments complete one frame; only new source batches use this budget.
  const seekEarlier = !demand.settled && target > 0 && Boolean(view.snapshot) && messages.length < target && view.hasMore &&
    demand.batches < 3 && !view.error && !view.observationError
  const initialLoading = enabled && !demand.settled && !view.error && !view.observationError && (!view.snapshot || view.loading || seekEarlier)
  useEffect(() => {
    if (!enabled || demand.settled || view.loading || !view.snapshot) return
    if (!seekEarlier) { demand.settled = true; return }
    demand.batches++
    void view.earlier(undefined, { preserveCurrent: true })
  }, [enabled, demand, seekEarlier, view.loading, view.snapshot, view.earlier])
  const loadEarlier = useCallback(() => {
    demand.settled = true
    return view.earlier()
  }, [demand, view.earlier])
  // Exact-source history seeds retain record IDs; they are not entity list rows.
  const sourceMessages = useMemo(() => view.reading?.originalRecords.flatMap(record => record.input ? [record.input] : []) ?? [], [view.reading])
  const sourceChanged = [view.error, view.observationError].some(error => ['AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'native-source-changed'].includes((error as (Error & { code?: string }) | null)?.code ?? ''))
  const readForReveal = useCallback(async (source: AgentConversationRecordSource) => {
    let settled = await view.settle()
    let accepted = settled?.snapshot ? projectConversationWindow(settled.snapshot) : null
    const loaded = accepted?.originalRecords.some(item => item.rawId === source.recordId && item.source.kind === source.kind &&
      (source.kind !== 'native' || item.source.kind === 'native' && item.source.providerId === source.providerId && item.source.nativeSessionId === source.nativeSessionId))
    if (!loaded && !settled?.error && settled?.snapshot?.window.navigation.older) {
      const pending = view.earlier()
      settled = await view.settle()
      await pending
      accepted = settled?.snapshot ? projectConversationWindow(settled.snapshot) : null
    }
    return { page: accepted?.historyPage ?? null, records: accepted?.originalRecords ?? [], error: settled?.error ?? null, cancelled: !settled,
      windowFrozen: settled?.historical ?? false,
      sourceChanged: ['AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'native-source-changed'].includes((settled?.error as (Error & { code?: string }) | null)?.code ?? '') }
  }, [view.earlier, view.settle])
  const windowFull = (view.error as (Error & { code?: string }) | null)?.code === 'AGENT_CONVERSATION_WINDOW_FULL'
  return { messages, sourceMessages, conversation: view, nativeHistoryPage: page, nativeContextItems: page?.items ?? [], nextCursor: view.snapshot?.window.navigation.older ?? null,
    hasMore: view.hasMore, loading: view.loading || initialLoading, error: windowFull ? view.sourceError : view.error, observationError: view.observationError, windowFrozen: view.historical,
    windowIncomplete: Boolean(view.snapshot?.window.outside.older || target > 0 && view.hasMore), sourceChanged, loadEarlier, refresh: view.refresh, readForReveal }
}
