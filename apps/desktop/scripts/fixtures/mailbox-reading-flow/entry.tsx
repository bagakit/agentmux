import '../result-ready-input-continuity/entry'
import { flushSync } from 'react-dom'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import type { ContinuousProgressLoop } from '@agentmux/core'

const original = (window as any).resultReady
const longBody = Array.from({ length: 90 }, (_, index) => `Original message line ${index + 1}: review the recorded facts and retain these exact words.`).join('\n')
let loops: ContinuousProgressLoop[] = []
const listeners = new Set<(loop: ContinuousProgressLoop) => void>(), reads: unknown[] = [], clipboard: string[] = [], sends: unknown[] = []
api.continuousProgress.list = async target => { reads.push(target); return loops }
api.continuousProgress.onChanged = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
api.ui.writeClipboardText = async text => { clipboard.push(text) }
let failPick = false
const fileRequests: unknown[] = []
api.ui.chooseFiles = async options => { fileRequests.push(options); if (failPick) { failPick = false; throw new Error('Private file selection request failed. The original draft is retained.') }; return null }
api.sessions.submitPrompt = async (...args) => { sends.push(args) }
api.sessions.refresh = async target => useAppStore.getState().sessions.find(session => session.id === target.agentSessionId)!
api.sessions.historyPage = async target => ({ agentSessionId: target.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'private-reading-native' }, items: [
  { id: 'native-old', kind: 'user-message', startedAt: 10, contentParts: [{ kind: 'text', text: 'Terminal recorded input with an unknown author.' }] },
  { id: 'native-unknown', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Observed native message with no recorded time.' }] }
], nextCursor: null })
const probe = {
  sessionId: original.sessionId, longBody,
  seed() {
    original.seed()
    const session = useAppStore.getState().sessions.find(session => session.id === original.sessionId)!
    loops = []
    flushSync(() => useAppStore.setState({ noticeReadReceipts: {}, agentSteerInFlight: {}, timelines: {
      [session.id]: { agentSessionId: session.id, revision: 1, items: [
        { id: 'in-long', agentSessionId: session.id, kind: 'user_message', status: 'complete', source: 'user', authorAgentSessionId: 'private-peer', title: 'Prompt', content: longBody, createdAt: 50, updatedAt: 50 },
        { id: 'in-short', agentSessionId: session.id, kind: 'user_message', status: 'complete', source: 'user', authorAgentSessionId: 'private-peer', title: 'Prompt', content: 'Check the handoff before editing the delivery target.', createdAt: 60, updatedAt: 60 },
        { id: 'sent', agentSessionId: session.id, kind: 'user_message', status: 'complete', source: 'user', authorHuman: true, title: 'Prompt', content: 'A confirmed Message Tool instruction.', createdAt: 20, updatedAt: 20 }
      ] } }, agentSteerQueues: { [session.id]: [
        { operationId: 'reading-old', text: 'Old Run message retained here.', status: 'deferred', runId: 'old-private-run', enqueuedAt: 999 },
        { operationId: 'reading-next', text: longBody, status: 'deferred', runId: session.control.run.runId, promptCondition: { expectedRun: session.control.run, afterSubmissionId: session.promptSubmissionPredecessor }, enqueuedAt: 40, error: 'Delivery confirmation was not observed. Diagnostic: private=1' },
        { operationId: 'reading-later', text: 'Later queued message, awaiting its original turn in the queue.', status: 'queued', runId: session.control.run.runId, enqueuedAt: 1 }
      ] } }))
  },
  failNextFileRequest() { failPick = true },
  notice() { flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === original.sessionId
    ? { ...session, terminalCapability: { state: 'unknown', mode: 'degraded', reason: 'handshake-timeout', run: session.control.run, observedAt: 30 } } : session) }))) },
  draft(text: string) { flushSync(() => useAppStore.getState().setAgentComposerDraft(original.sessionId, text)) },
  appearance(mode: 'dark' | 'light') { applyAppAppearance(mode) },
  terminal: original.terminal,
  facts() { return { ...original.facts(), queues: useAppStore.getState().agentSteerQueues, receipts: useAppStore.getState().noticeReadReceipts, clipboard, sends, fileRequests, progress: { reads, observers: listeners.size } } }
}
Object.assign(window, { mailboxReading: probe })
probe.seed()
