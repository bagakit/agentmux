import '../result-ready-input-continuity/entry'
import { flushSync } from 'react-dom'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import type { AgentDisplayState, ContinuousProgressLoop } from '@agentmux/core'

const base = (window as any).resultReady
api.continuousProgress.list = async (control) => {
  const session = useAppStore.getState().sessions.find(session => session.id === control.agentSessionId)!
  return [{ loopId: 'private-mailbox-loop', hostId: session.hostId, agentSessionId: session.id,
    providerId: session.providerId, workspacePath: session.workspacePath, status: 'active', intervalMs: 60_000,
    nextCheckAt: Date.now() + 60_000, prompt: 'Private continuous progress' } satisfies ContinuousProgressLoop]
}
const probe = {
  sessionId: base.sessionId,
  seed(pending = true) {
    base.seed()
    flushSync(() => useAppStore.setState({ noticeReadReceipts: {}, agentSteerInFlight: {},
      agentSteerQueues: { [base.sessionId]: pending ? [{ operationId: 'private-pending', text: 'Original queued instruction', status: 'queued',
        runId: useAppStore.getState().sessions.find(session => session.id === base.sessionId)!.control.run.runId }] : [] } }))
  },
  unread(count: number) {
    flushSync(() => useAppStore.setState({ noticeReadReceipts: {}, timelines: {
      [base.sessionId]: { agentSessionId: base.sessionId, revision: count + 1, items: Array.from({ length: count }, (_, i) => ({
        id: `private-incoming-${i}`, agentSessionId: base.sessionId, authorAgentSessionId: 'private-peer',
        kind: 'user_message' as const, status: 'complete' as const, source: 'user' as const,
        title: 'Prompt', content: `Private received message ${i + 1}`, createdAt: i + 1, updatedAt: i + 1
      })) }
    } }))
  },
  state(display: AgentDisplayState) {
    flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === base.sessionId
      ? { ...session, status: { state: display, source: 'native-hook' as const, observedAt: Date.now() } } : session) })))
  },
  draft(text: string) { flushSync(() => useAppStore.getState().setAgentComposerDraft(base.sessionId, text)) },
  appearance(mode: 'dark' | 'light') { applyAppAppearance(mode) },
  facts() { return { ...base.facts(), queues: useAppStore.getState().agentSteerQueues, receipts: useAppStore.getState().noticeReadReceipts } },
  terminal: base.terminal
}
Object.assign(window, { mailboxBadge: probe })
probe.seed()
