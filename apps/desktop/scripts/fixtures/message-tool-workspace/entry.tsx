import { flushSync } from 'react-dom'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import type { AgentSessionHistoryObservation } from '@agentmux/core'
import '../agent-region-identity-menu/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { historyPage, visualInputPage, journalWire } from './data'

const base = (window as any).identityMenu
const calls: Array<{ action: string; reference?: unknown; query?: unknown }> = []
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
  seed(theme: 'dark' | 'light', tag: string, empty = false) {
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
    flushSync(() => useAppStore.setState({ timelines: {}, agentComposerDrafts: { [original.id]: '保留这份尚未发送的草稿。' },
      agentSteerQueues: { [original.id]: [{ operationId: 'workspace-pending', runId: original.control.run.runId,
        text: '待发：确认消息边界后，再逐项完成设计核对。', status: 'queued', promptCondition: null,
        enqueuedAt: fixtureEpoch(0, 0, 5000), awaitingExplicitSend: true }] } }))
    calls.length = 0
    return { generation, ...a2a, journalWire, draft: '保留这份尚未发送的草稿。' }
  },
  facts() { return { ...base.facts(), calls: [...calls], historyObservers: observers.size, progress: base.progressFacts() } },
  terminal: () => base.terminal()
} })
