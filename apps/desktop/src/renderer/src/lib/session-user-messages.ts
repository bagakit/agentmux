import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import type { AgentSessionControl, SessionHistoryReference } from '../../../shared/contracts'
import { api } from './api'
import { desktopConversationDiagnostics } from './conversation-diagnostic-options'

export type AgentSessionControlInput = AgentSessionControl
export function useSessionUserMessages(control?: AgentSessionControlInput, options?: { enabled?: boolean; initialInputs?: number; reading?: { reference: SessionHistoryReference; port: typeof api.conversation; identity: string } }) {
  const reference = options?.reading?.reference ?? control
  const enabled = (options?.enabled ?? true) && Boolean(reference), target = options?.initialInputs ?? 0
  const key = options?.reading?.identity ?? (control ? JSON.stringify([control.hostId, control.agentSessionId, control.run.runId]) : '')
  const initial = useRef({ key, batches: 1, settled: target === 0 })
  if (initial.current.key !== key) initial.current = { key, batches: 1, settled: target === 0 }
  const demand = initial.current
  const view = useConversationView(options?.reading?.port ?? api.conversation, reference, enabled, { ...(key ? { identity: key } : {}),
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
  const sourceChanged = ['AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'native-source-changed'].includes((view.error as (Error & { code?: string }) | null)?.code ?? '')
  const windowFull = (view.error as (Error & { code?: string }) | null)?.code === 'AGENT_CONVERSATION_WINDOW_FULL'
  return { messages, sourceMessages, conversation: view, nativeHistoryPage: page, nativeContextItems: page?.items ?? [], nextCursor: view.snapshot?.window.navigation.older ?? null,
    hasMore: view.hasMore, loading: view.loading || initialLoading, error: windowFull ? view.sourceError : view.error, observationError: view.observationError, windowFrozen: view.historical,
    windowIncomplete: Boolean(view.snapshot?.window.outside.older || target > 0 && view.hasMore), sourceChanged, loadEarlier, refresh: view.refresh }
}
