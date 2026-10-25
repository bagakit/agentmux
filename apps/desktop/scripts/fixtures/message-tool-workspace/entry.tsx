import { flushSync } from 'react-dom'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import type { AgentMuxMessageNotification, AgentSessionHistoryObservation } from '@agentmux/core'
import '../agent-region-identity-menu/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { historyPage, visualInputPage, journalWire } from './data'

const base = (window as any).identityMenu
const calls: Array<{ action: string; reference?: unknown; query?: unknown }> = []
const notificationRecords = new Map<string, { messageId: string; notice: AgentMuxMessageNotification }>()
const fixtureNoticeStorage = 'private-message-workspace-notices'
let resumedScene = false
api.sessions.notifyMessage = async (reference, messageId, operationId) => {
  calls.push({ action: 'notify-reference', reference, query: { messageId, operationId } })
  const { message } = await api.sessions.readMessage(reference, messageId)
  if (!message?.envelope.recipientSessionId || !message.envelope.recipientRunId) throw new Error('The private scene needs its original notification recipient')
  const runId = resumedScene ? 'private-resumed-' + message.envelope.recipientSessionId : message.envelope.recipientRunId
  const key = { kind: 'prompt' as const, agentSessionId: message.envelope.recipientSessionId, expectedRun: { runId }, submissionId: operationId }
  const notice: AgentMuxMessageNotification = { notificationId: operationId, key, messageIds: [messageId], wire: 'Private original Core reference notification',
    condition: { expectedRun: key.expectedRun, afterSubmissionId: null }, mode: 'steer', state: 'unconfirmed',
    reason: 'The original input receipt is not yet confirmed. Check this same operation.' }
  notificationRecords.set(operationId, { messageId, notice })
  // Only this private API fixture retains backend records across the actual Renderer reload.
  localStorage.setItem(fixtureNoticeStorage, JSON.stringify([...notificationRecords]))
  if (resumedScene) throw new Error('The response was lost after the notification request was recorded. Check this original operation.')
  return { hostId: reference.hostId, notification: notice, input: null }
}
api.sessions.inspectMessageNotification = async (reference, messageId, operationId) => {
  calls.push({ action: 'inspect-notification', reference, query: { messageId, operationId } })
  const retained = notificationRecords.get(operationId) ?? new Map<string, { messageId: string; notice: AgentMuxMessageNotification }>(JSON.parse(localStorage.getItem(fixtureNoticeStorage) ?? '[]')).get(operationId)
  if (!retained) return { hostId: reference.hostId, notification: null, input: null }
  if (retained.messageId !== messageId) throw new Error('The scene only observes its exact original notification')
  const { reason: _unconfirmedReason, ...notice } = retained.notice
  return { hostId: reference.hostId, notification: { ...notice, state: 'submitted' }, input: null }
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
let automationScene = false
let progressActionsScene = false
let pendingProgressAction: { held: import('@agentmux/core').ContinuousProgressLoop; resolve(loop: import('@agentmux/core').ContinuousProgressLoop): void; reject(error: Error): void } | undefined
let automationUpdated: import('@agentmux/core').ContinuousProgressLoop | undefined
const originalProgressList = api.continuousProgress.list
api.continuousProgress.list = async target => {
  const records = await originalProgressList(target)
  return automationScene && automationUpdated ? records.map(record => record.loopId === automationUpdated!.loopId ? automationUpdated! : record) : records
}
const originalScheduleList = api.schedule.list
api.schedule.list = async query => {
  if (!automationScene || !original || original.kind !== 'agent') return originalScheduleList(query)
  if (progressActionsScene) return { schedules: [], executionScope: 'connected-host' }
  const target = { hostId: original.hostId, agentSessionId: original.control.agentSessionId, providerId: original.providerId, workspacePath: original.workspacePath }
  const expected = query.target ?? query.scope
  if (expected && !Object.entries(expected).every(([key, value]) => target[key as keyof typeof target] === value))
    return { schedules: [], executionScope: 'connected-host' }
  return { schedules: [{ ...target, loopId: 'private-minute-arrangement', intervalMs: 1000, everyMs: 300000,
    prompt: '请检查当前任务并报告真实进展。', status: 'active', nextCheckAt: fixtureEpoch(0, 0, 3600000),
    revision: 1, creationOperationId: 'private-automation-create', futureIntentId: 'private-automation-intent' }], executionScope: 'connected-host' }
}
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
api.continuousProgress.action = async (target, loopId, action, expectedLoop, operationId) => {
  if (!progressActionsScene) { calls.push({ action: 'automation-action' }); throw new Error('Reading cannot operate automation') }
  const [held] = await api.continuousProgress.list(target)
  if (!held || held.loopId !== loopId || pendingProgressAction || JSON.stringify(held) !== JSON.stringify(expectedLoop) ||
    JSON.stringify(target) !== JSON.stringify({ hostId: held.hostId, agentSessionId: held.agentSessionId, providerId: held.providerId, workspacePath: held.workspacePath }) ||
    !operationId || action !== 'resume' && action !== 'check') throw new Error('The private action must use the exact original loop, target and request.')
  calls.push({ action: 'fixture-progress-action', reference: target, query: { loopId, action, operationId, expectedLoop } })
  return await new Promise<import('@agentmux/core').ContinuousProgressLoop>((resolve, reject) => { pendingProgressAction = { held: structuredClone(held), resolve, reject } })
}
api.continuousProgress.update = async request => {
  if (!automationScene) throw new Error('This private reading scene cannot update automation.')
  const [held] = await api.continuousProgress.list(request.target)
  if (!held || held.loopId !== request.loopId || held.status !== 'paused' || JSON.stringify(held) !== JSON.stringify(request.expectedLoop))
    throw new Error('The private update must retain the exact original paused loop.')
  calls.push({ action: 'fixture-progress-update', reference: request.target, query: { loopId: request.loopId, operationId: request.operationId, intervalMs: request.intervalMs, prompt: request.prompt } })
  automationUpdated = { ...held, intervalMs: request.intervalMs, prompt: request.prompt }
  return structuredClone(automationUpdated)
}
Object.assign(window, { messageWorkspace: {
  seed(theme: 'dark' | 'light', tag: string, empty = false, retainNotificationIntents = false) {
    if (pendingProgressAction) throw new Error('Settle the original private progress action before changing scenes.')
    automationScene = false
    progressActionsScene = false
    automationUpdated = undefined
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
    notificationRecords.clear()
    if (!retainNotificationIntents) localStorage.removeItem(fixtureNoticeStorage)
    resumedScene = false
    return { generation, ...a2a, journalWire, draft: '保留这份尚未发送的草稿。' }
  },
  automation() { automationScene = true; base.progress('paused', true) },
  progressActions() { automationScene = true; progressActionsScene = true; base.progress('paused') },
  settleProgressAction(outcome: 'skipped' | 'failure') {
    const pending = pendingProgressAction
    if (!pending) throw new Error('There is no original private progress action to settle.')
    pendingProgressAction = undefined
    if (outcome === 'failure') { pending.reject(new Error('The original check could not be confirmed. The Agent and manual input remain available.')); return }
    automationUpdated = { ...pending.held, status: 'active', lastOutcome: 'skipped', lastDecision: 'working', lastTickAt: fixtureEpoch(0, 0, 10000) }
    pending.resolve(structuredClone(automationUpdated))
  },
  resumed() { resumedScene = true },
  forgetNotification(operationId: string) { notificationRecords.delete(operationId); localStorage.setItem(fixtureNoticeStorage, JSON.stringify([...notificationRecords])) },
  async restore(theme: 'dark' | 'light', tag: string) { await useAppStore.persist.rehydrate(); return this.seed(theme, tag, false, true) },
  facts() { return { ...base.facts(), notificationIntents: useAppStore.getState().mailboxNotificationIntents, calls: [...calls], historyObservers: observers.size, progress: base.progressFacts() } },
  originalMessage: (messageId: string) => api.sessions.readMessage({ hostId: original.hostId, agentSessionId: original.id }, messageId),
  terminal: () => base.terminal()
} })
