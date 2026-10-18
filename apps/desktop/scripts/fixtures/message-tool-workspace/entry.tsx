import { flushSync } from 'react-dom'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import type { AgentSessionHistoryObservation } from '@agentmux/core'
import '../agent-region-identity-menu/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { historyPage, visualInputPage, journalWire } from './data'

const base = (window as any).identityMenu
const calls: Array<{ action: string; reference?: unknown; query?: unknown }> = []
const notificationKeys = new Map<string, { messageId: string; key: { kind: 'prompt'; agentSessionId: string; expectedRun: { runId: string }; submissionId: string } }>()
api.sessions.notifyMessage = async (reference, messageId, operationId) => {
  calls.push({ action: 'notify-reference', reference, query: { messageId, operationId } })
  const { message } = await api.sessions.readMessage(reference, messageId)
  if (!message?.envelope.recipientSessionId || !message.envelope.recipientRunId) throw new Error('The private scene needs its original notification recipient')
  const key = { kind: 'prompt' as const, agentSessionId: message.envelope.recipientSessionId, expectedRun: { runId: message.envelope.recipientRunId }, submissionId: operationId }
  notificationKeys.set(operationId, { messageId, key })
  return { hostId: reference.hostId, notification: { notificationId: operationId, key, messageIds: [messageId], wire: 'Private original Core reference notification',
    condition: { expectedRun: key.expectedRun, afterSubmissionId: null }, mode: 'steer', state: 'unconfirmed', reason: 'The original input receipt is not yet confirmed. Refresh this same operation.' }, input: null }
}
api.sessions.inspectMessageNotification = async (reference, messageId, key) => {
  calls.push({ action: 'inspect-notification', reference, query: { messageId, key } })
  if (key.kind !== 'prompt' || notificationKeys.get(key.submissionId)?.messageId !== messageId) throw new Error('The scene only observes its exact original notification')
  return { record: { agentSessionId: key.agentSessionId, run: key.expectedRun,
    admission: { inputKey: key, submissionId: key.submissionId, acknowledged: true, intent: { run: key.expectedRun, execution: 'immediate',
      admissionIntent: { kind: 'manual-actor', expectedRun: key.expectedRun }, prompt: 'Private original Core reference notification',
      message: { systemContext: 'Private original Core reference notification', a2aNotificationId: key.submissionId } } } } as never }
}
api.sessions.messageEvents = async (reference, query = {}) => {
  calls.push({ action: 'notification-events', reference, query })
  return { hostId: reference.hostId, participantSessionId: reference.agentSessionId, afterSequence: query.afterSequence ?? 0,
    latest: query.latest ?? false, beforeSequence: query.beforeSequence ?? null, throughSequence: query.throughSequence ?? 0,
    incarnation: 'private-notification-journal', messageId: query.messageId ?? null, broadcastOperationId: null,
    events: [], nextAfterSequence: null, nextBeforeSequence: null }
}
const observers = new Set<(event: AgentSessionHistoryObservation) => void>()
const readDispatches = api.sessions.dispatches
let emptyViews = false
let original = useAppStore.getState().sessions.find(session => session.kind === 'agent')!
if (original.kind !== 'agent') throw new Error('The private production scene has an original Agent')
api.sessions.dispatches = async (reference, query) => {
  if (!emptyViews) return readDispatches(reference, query)
  calls.push({ action: 'collaboration-page', reference, query })
  return { hostId: reference.hostId, participantSessionId: reference.agentSessionId, dispatches: [], nextSourceMessageId: null }
}
api.sessions.inputMailbox = async (reference, query) => {
  calls.push({ action: 'journal', reference, query })
  return visualInputPage(reference.agentSessionId, original.control.run)
}
api.sessions.readHistory = async (reference, query) => {
  calls.push({ action: 'history', reference, query })
  return historyPage(reference.hostId, reference.agentSessionId, query.source, query.query)
}
api.sessions.historyPage = async control => ({ agentSessionId: control.agentSessionId,
  source: { providerId: 'codex', nativeSessionId: 'workspace-native' }, items: [], nextCursor: null })
api.sessions.observeHistory = async (_control, listener) => {
  observers.add(listener)
  return { source: { providerId: 'codex', nativeSessionId: 'workspace-native' }, dispose() { observers.delete(listener) } }
}
api.sessions.submitPrompt = async () => { calls.push({ action: 'dispatch' }); throw new Error('The private reading scene cannot submit input') }
api.continuousProgress.create = async () => { calls.push({ action: 'automation-create' }); throw new Error('Reading cannot create automation') }
api.continuousProgress.action = async () => { calls.push({ action: 'automation-action' }); throw new Error('Reading cannot operate automation') }
Object.assign(window, { messageWorkspace: {
  seed(theme: 'dark' | 'light', tag: string, empty = false, retainNotificationIntents = false) {
    emptyViews = empty
    base.appearance(theme)
    const generation = base.mode('terminal')
    const a2a = base.mailboxLayout(tag)
    original = useAppStore.getState().sessions.find(session => session.id === a2a.agentSessionId)!
    if (empty && original.kind === 'agent') {
      // This private scene supplies an available Session without a capability diagnostic.
      const { terminalCapability: _diagnostic, ...available } = original
      original = available
      flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === original.id ? available : session) })))
    }
    base.progress('inactive')
    flushSync(() => useAppStore.setState({ timelines: {}, mailboxNotificationIntents: retainNotificationIntents ? useAppStore.getState().mailboxNotificationIntents : {}, mailboxNotificationFeedback: {}, mailboxNotificationHistory: {}, agentComposerDrafts: { [original.id]: '保留这份尚未发送的草稿。' },
      agentSteerQueues: { [original.id]: [{ operationId: 'workspace-pending', runId: original.control.run.runId,
        text: '待发：确认消息边界后，再逐项完成设计核对。', status: 'queued', promptCondition: null,
        enqueuedAt: fixtureEpoch(0, 0, 5000), awaitingExplicitSend: true }] } }))
    calls.length = 0
    notificationKeys.clear()
    return { generation, ...a2a, journalWire, draft: '保留这份尚未发送的草稿。' }
  },
  async restore(theme: 'dark' | 'light', tag: string) { await useAppStore.persist.rehydrate(); return this.seed(theme, tag, false, true) },
  facts() { return { ...base.facts(), notificationIntents: useAppStore.getState().mailboxNotificationIntents, calls: [...calls], historyObservers: observers.size, progress: base.progressFacts() } },
  originalMessage: (messageId: string) => api.sessions.readMessage({ hostId: original.hostId, agentSessionId: original.id }, messageId),
  terminal: () => base.terminal()
} })
