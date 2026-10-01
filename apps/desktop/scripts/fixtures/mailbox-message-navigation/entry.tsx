import { flushSync } from 'react-dom'
import type { AgentSessionHistoryPage, AgentSessionHistoryObservation } from '@agentmux/core'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'

await import('../mailbox-badge/entry')
const base = (window as any).resultReady, badge = (window as any).mailboxBadge
const body = 'Exactly recorded input. Identical text and raw id are deliberately shared by captured and native records.'
const source = { providerId: 'codex', nativeSessionId: 'private-native-a' }
let observations = new Set<(event: AgentSessionHistoryObservation) => void>()
let readCalls: unknown[] = [], acquisitions = 0, disposals = 0, dispatches: unknown[] = []
let pending: { resolve(page: AgentSessionHistoryPage): void; reject(error: Error): void } | null = null
let delayNext = false
function page(): AgentSessionHistoryPage {
  return { agentSessionId: base.sessionId, source, items: [
    { id: 'same', kind: 'user-message', contentParts: [{ kind: 'text', text: body }], recordedAt: 1 },
    ...Array.from({ length: 20 }, (_, i) => ({ id: 'native-response-' + i, kind: 'assistant-message' as const,
      contentParts: [{ kind: 'text' as const, text: 'A later recorded response ' + (i + 1) + '.\nA second readable line in this response.' }], recordedAt: i + 2 }))
  ] }
}
api.sessions.historyPage = async (control, request) => {
  readCalls.push({ control, request })
  if (delayNext) { delayNext = false; return new Promise((resolve, reject) => { pending = { resolve, reject } }) }
  return page()
}
api.sessions.observeHistory = async (_control, listener) => {
  ++acquisitions; observations.add(listener)
  let disposed = false
  return { source, dispose() { if (!disposed) { disposed = true; ++disposals; observations.delete(listener) } } }
}
api.sessions.submitPrompt = async (...args) => { dispatches.push(args); throw new Error('Private navigation must not submit prompts') }
api.sessions.submitMessage = async (...args) => { dispatches.push(args); throw new Error('Private navigation must not submit messages') }
const probe = {
  sessionId: base.sessionId, body,
  seed(appearance: 'dark' | 'light', draft: string) {
    badge.seed(true); badge.appearance(appearance); badge.draft(draft)
    observations = new Set(); readCalls = []; acquisitions = 0; disposals = 0; dispatches = []; pending = null; delayNext = false
    flushSync(() => useAppStore.setState({ timelines: { [base.sessionId]: { agentSessionId: base.sessionId, revision: 2, items: [
      { id: 'same', agentSessionId: base.sessionId, kind: 'user_message', status: 'complete', source: 'user',
        authorAgentSessionId: 'private-peer', title: 'Recorded input', content: body, createdAt: 100, updatedAt: 100 },
      ...Array.from({ length: 32 }, (_, i) => ({ id: 'later-response-' + i, agentSessionId: base.sessionId,
        kind: 'assistant_message' as const, status: 'complete' as const, source: 'native-hook' as const,
        content: 'Later captured response ' + (i + 1) + '.\nThe conversation retains its original recorded ordering.', createdAt: 101 + i, updatedAt: 101 + i }))
    ] } } }))
  },
  key(kind: 'captured' | 'native') { return conversationMessageSourceKey(base.sessionId, kind === 'captured'
    ? { kind, submissionId: 'same' } : { kind, ...source, recordId: 'same' }) },
  revalidate() { delayNext = true; for (const observer of observations) observer({ kind: 'invalidated', agentSessionId: base.sessionId, source }) },
  complete(outcome: 'provider' | 'session' | 'failed') {
    const request = pending; pending = null
    if (!request) throw new Error('An actual bounded read must already be in flight')
    if (outcome === 'failed') request.reject(new Error('private revalidation unavailable'))
    else request.resolve({ ...page(), source: { providerId: outcome === 'provider' ? 'claude' : 'codex', nativeSessionId: outcome === 'session' ? 'private-native-b' : source.nativeSessionId } })
  },
  visible: base.visible,
  facts() { return { ...badge.facts(), readCalls, acquisitions, disposals, observers: observations.size, pending: Boolean(pending), dispatches,
    mode: useAppStore.getState().viewModes[base.sessionId] } },
  terminal: base.terminal
}
Object.assign(window, { mailboxNavigation: probe })
probe.seed('dark', 'Original unsent draft')
