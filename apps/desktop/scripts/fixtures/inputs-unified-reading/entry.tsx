import { fixtureEpoch as _privacyFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { InputHistoryOriginalRecords } from '@agentmux/client-ui/components/InputHistoryList'
import { projectConversationReading, projectSessionInputs, parseConversationReadPage, type ConversationTimelineReadInput } from '@agentmux/core/conversation'
import type { AgentInputMailboxItem, AgentInputMailboxPage } from '@agentmux/core/agent-input-mailbox'
import type { AgentSessionHistoryPage, AgentSessionHistoryReadPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import { AgentSessionComposer } from '../../../src/renderer/src/components/AgentSessionComposer'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Private, explicitly synthetic source pages exercise the actual Core projection and product consumers.
// These observations are not evidence of a Provider read, native adoption or a user Runtime action.
const agentSessionId = 'private-inputs-native-fixture', sourceHostId = 'private-original-host'
const source = { providerId: 'codex' as const, nativeSessionId: 'private-original-native' }
const key = { kind: 'prompt' as const, agentSessionId, expectedRun: { runId: 'private-original-run' }, submissionId: 'private-original-input' }
const privateCorrelation = 'amux-input-v1.' + btoa(JSON.stringify({ key, nonce: 'a'.repeat(32) })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const text = '请核对原输入，并保留每一次发送的回执。'
const nativeText = '原生系统上下文\n' + text
const timestamp = _privacyFixtureEpoch(20749, 43200)
const history: AgentSessionHistoryPage = { agentSessionId, sourceHostId, source, nextCursor: null, items: [{
  id: 'private-native-original', kind: 'user-message', turnId: 'private-original-turn', startedAt: timestamp,
  contentParts: [{ kind: 'text', text: nativeText }], conversation: { adoptedInput: { key },
    nativeInput: { source, turnId: 'private-original-turn', semanticItemId: 'private-native-input', clientCorrelation: privateCorrelation } }
}] }
const timeline: AgentTimelineSnapshot = { agentSessionId, sourceHostId, revision: 1, items: [
  { id: 'private-captured-original', agentSessionId, kind: 'user_message', source: 'user', status: 'complete',
    title: 'Original input', content: text, inputRef: key, publicContent: 'confirmed', authorHuman: true,
    sourceChannel: 'api', createdAt: timestamp, updatedAt: timestamp },
  { id: 'private-same-text-independent', agentSessionId, kind: 'user_message', source: 'user', status: 'complete',
    title: 'Independent input', content: text, inputRef: { ...key, submissionId: 'private-independent-input' },
    publicContent: 'confirmed', authorHuman: true, sourceChannel: 'api', createdAt: timestamp - 60_000, updatedAt: timestamp - 60_000 }
] }
const ref = { key, waitGeneration: 1 }
const journal: AgentInputMailboxItem = { kind: 'controlled', sequence: 1, recordedAt: timestamp,
  intent: { key, execution: 'immediate', admissionIntent: { kind: 'manual-actor', expectedRun: key.expectedRun },
    source: { kind: 'prompt', prompt: text, authorHuman: true } },
  receipt: { key, ref, persistence: 'confirmed', status: 'unknown', observation: 'closed', admission: null,
    control: { ref, state: 'dispatch-authorized', gateId: 'private-original-gate', at: timestamp } } }
const projection = projectConversationReading({ agentSessionId, routeHostId: 'local', executionHostId: sourceHostId, historyPage: history, timeline })
const messages = projection.originalRecords.flatMap(record => record.input ? [record.input] : [])
const groups = projectSessionInputs({ hostId: 'local', sourceHostId, agentSessionId, messages, inputs: projection.inputs, mailbox: [journal] })
const reads: unknown[] = [], copied: string[] = [], dispatches: unknown[] = []
function conversation(input: ConversationTimelineReadInput) {
  const projected = projection.timeline, reference = { hostId: 'local', agentSessionId }
  const checkpoint = { ...reference, sourceHostId, frontier: { ...reference, scope: projected.scope, cuts: [] } }
  const units = [...projected.events].reverse().map(event => ({ kind: 'item' as const,
    item: { event, records: projected.records.filter(record => event.recordIds.includes(record.id)) } }))
  return parseConversationReadPage({ ...reference, sourceHostId, scope: projected.scope, coverage: projected.coverage,
    order: { ...projected.order, direction: 'newest-first' }, items: units, nextCursor: null, budgetBytes: input.maxBytes ?? 128 * 1024,
    window: { id: 'private-original-window', revision: 1, itemCount: units.length, complete: true,
      view: 'private-original-view', replay: 'private-original-replay', checkpoint,
      outside: { older: null, newer: null }, navigation: { older: null, newer: null } } }, input)
}
api.conversation.readAgentConversation = async input => { reads.push({ kind: 'conversation', input }); return conversation(input) }
api.conversation.readConversationChanges = async input => { const page = conversation(input); return { ...page, checkpoint: page.window.checkpoint, more: false } }
api.conversation.observeConversation = async input => {
  const page = conversation(input), closed = new AbortController()
  return { hostId: page.hostId, sourceHostId, agentSessionId, scope: page.scope, coverage: page.coverage, closed: closed.signal, dispose() { closed.abort() } }
}
api.conversation.releaseConversationView = async input => ({ hostId: input.hostId, sourceHostId, agentSessionId, viewId: input.view, released: true })
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'private-workspace', name: 'Private reading fixture', hostId: 'local', path: new URL("private/agentmux-inputs-fixture", new URL('/', import.meta.url)).pathname, kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id: agentSessionId, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: new URL("private/agentmux-inputs-fixture", new URL('/', import.meta.url)).pathname,
  promptSubmissionPredecessor: null, agentSessionUpdatedAt: timestamp, label: 'Inputs reading', createdAt: timestamp, updatedAt: timestamp,
  latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: timestamp },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId, run: key.expectedRun }
}
api.sessions.historyPage = async (control, request) => { reads.push({ kind: 'native-page', control, request }); return history }
api.sessions.observeHistory = async () => ({ source, dispose() {} })
api.sessions.readHistory = async (control, request) => {
  reads.push({ kind: 'query', control, request })
  const found = messages.filter(message => message.source.kind === request.source && (!request.query || message.content.includes(request.query)))
  return { hostId: control.hostId, sourceHostId, agentSessionId, source: request.source, revision: 'a'.repeat(64),
    availability: found.length ? 'available' : 'empty', order: 'newest-first', items: [], nextCursor: null,
    budgetBytes: request.maxBytes ?? 128 * 1024, kind: 'user-message', userMessages: found,
    scan: { examined: messages.filter(message => message.source.kind === request.source).length, complete: true },
    ...(request.source === 'native' ? { nativeSource: source } : {}) } satisfies AgentSessionHistoryReadPage
}
api.sessions.inputMailbox = async (control, request) => { reads.push({ kind: 'journal', control, request }); return {
  agentSessionId, queueId: 'private-original-journal', cut: { incarnation: 'private-original-incarnation', throughSequence: 1 },
  budgetBytes: request.maxBytes ?? 64 * 1024, items: [{ kind: 'item', item: journal }], nextCursor: null,
  coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' }
} satisfies AgentInputMailboxPage }
api.sessions.listMessages = async (control, request) => ({ hostId: control.hostId, participantSessionId: agentSessionId,
  direction: request.direction, messages: [], nextBeforeSequence: null })
api.sessions.notifyInputOccupation = async () => {}
api.continuousProgress.list = async () => []
api.continuousProgress.pauseForInput = async () => {}
api.ui.writeClipboardText = async value => { copied.push(value) }
for (const name of ['submitPrompt', 'write', 'resume', 'recover', 'stop', 'interrupt', 'respondInteraction', 'rejoinInputWaiting', 'stopInputWaiting', 'launchAgent'] as const) {
  api.sessions[name] = async (...args: unknown[]) => { dispatches.push({ name, args }); throw new Error('Private reading fixture forbids dispatch: ' + name) }
}
useAppStore.setState({ config, sessions: [session], timelines: { [agentSessionId]: timeline }, agentNames: {},
  agentComposerDrafts: { [agentSessionId]: '保留的未发送草稿。' }, agentComposerHistory: {}, agentComposerHistoryNavigation: {},
  agentSteerQueues: {}, noticeReadReceipts: {}, error: null })
mountThemeRuntime(window, { appAppearance: new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark' })
function OriginalReadingProbe() {
  const first = messages.find(message => message.source.kind === 'native')!
  const second = messages.find(message => message.source.kind === 'captured')!
  const [originals, setOriginals] = useState([first, second])
  Object.assign(window, { withdrawFirstOriginal: () => setOriginals([second]) })
  return <InputHistoryOriginalRecords messages={originals}
    onRead={message => <p data-reading-probe-id={message.id}>{message.content}</p>} onCopy={async () => true} />
}
function mountOriginalReadingProbe() {
  const container = document.createElement('section')
  container.id = 'original-reading-probe'
  container.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg-primary);padding:24px'
  document.body.append(container)
  const root = createRoot(container)
  root.render(<OriginalReadingProbe />)
  Object.assign(window, { unmountOriginalReadingProbe: () => { root.unmount(); container.remove() } })
}
Object.assign(window, { inputsNativeFixture: { text, nativeText, messages, groups, journal, reads, copied, dispatches, mountOriginalReadingProbe,
  facts: () => ({ reads, copied, dispatches, draft: useAppStore.getState().agentComposerDrafts[agentSessionId],
    queues: useAppStore.getState().agentSteerQueues,
    groupCounts: groups.map(group => ({ messages: group.messages.length, mailbox: group.mailbox.length })), receiptStatus: journal.kind === 'controlled' ? journal.receipt?.status : null }) } })
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider>
  <main className="inputs-native-fixture">
    <header className="inputs-native-fixture__heading"><strong>Messages · Inputs</strong><span>私有读取场景 · 不连接用户 Session</span></header>
    <section className="inputs-native-fixture__workface" data-workbench-region-id="private-inputs-region">
      <div className="inputs-native-fixture__context"><strong>同一输入，一个阅读位置</strong><p>三份原来源可追溯；同文的独立输入保留。</p></div>
      <AgentSessionComposer sessionId={agentSessionId} />
    </section>
  </main>
</DesktopClientUiProvider>)
