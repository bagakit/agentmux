import { useCallback, useMemo } from 'react'
import { projectConversationWindow, type AgentConversationRecordSource } from '@agentmux/core/conversation'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from './api'

export type AgentSessionControlInput = AgentSessionControl
export function useSessionUserMessages(control?: AgentSessionControlInput, options?: { enabled?: boolean }) {
  const view = useConversationView(api.conversation, control, (options?.enabled ?? true) && Boolean(control), control ? { identity: control.run.runId } : {})
  const page = view.reading?.historyPage ?? null
  const messages = useMemo(() => view.reading?.records.flatMap(record => record.input ? [record.input] : []) ?? [], [view.reading])
  const sourceChanged = [view.error, view.observationError].some(error => ['AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'native-source-changed'].includes((error as (Error & { code?: string }) | null)?.code ?? ''))
  const readForReveal = useCallback(async (source: AgentConversationRecordSource) => {
    const settled = await view.settle()
    let accepted = settled ? projectConversationWindow(settled) : view.reading
    const loaded = accepted?.originalRecords.some(item => item.rawId === source.recordId && item.source.kind === source.kind &&
      (source.kind !== 'native' || item.source.kind === 'native' && item.source.providerId === source.providerId && item.source.nativeSessionId === source.nativeSessionId))
    if (!loaded && settled?.window.navigation.older && !view.loading) {
      const next = await view.earlier(); if (next) accepted = projectConversationWindow(next)
    }
    return { page: accepted?.historyPage ?? null, records: accepted?.originalRecords ?? [], error: view.error, windowFrozen: view.historical, sourceChanged }
  }, [view.reading, view.error, view.historical, view.loading, sourceChanged, view.earlier, view.settle])
  return { messages, conversation: view, nativeHistoryPage: page, nativeContextItems: page?.items ?? [], nextCursor: view.snapshot?.window.navigation.older ?? null,
    hasMore: view.hasMore, loading: view.loading, error: view.error, observationError: view.observationError, windowFrozen: view.historical,
    windowIncomplete: Boolean(view.snapshot?.window.outside.older), sourceChanged, loadEarlier: view.earlier, refresh: view.refresh, readForReveal }
}
