import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { SessionMailbox } from '../../../src/renderer/src/components/SessionMailbox'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import inputScene from 'virtual:a2a-primary-scene'
import '../../../src/renderer/src/styles/index.css'
import './surface.css'

const scene = inputScene.scenarios.idle
const calls: unknown[] = [], copied: string[] = [], forbidden: string[] = []
const pending: Array<{ messageId: string; resolve(value: unknown): void; reject(error: Error): void }> = []
const draft = '保留这份尚未发送的草稿。'
let surface: 'conversation' | 'mailbox' = 'conversation'
let participant = scene.reference.agentSessionId
const originals = scene.originals
const inputKey = scene.original.notification.key
const humanText = '这条人类原输入仍可阅读。', unknownText = '这条未核作者输入仍保留。'
function controlled(id: string, text: string, human: boolean) {
  return { kind: 'controlled', sequence: human ? 2 : 1, recordedAt: 1,
    intent: { key: { kind: 'prompt', agentSessionId: participant, expectedRun: scene.session.run, submissionId: id },
      admissionIntent: { kind: 'manual-actor', expectedRun: scene.session.run }, execution: 'immediate',
      source: { kind: 'prompt', prompt: text, ...(human ? { authorHuman: true } : {}) } }, receipt: null,
    failure: { name: 'Error', code: 'PRIVATE_OBSERVATION_UNKNOWN', message: '这条私有输入的投递观察未确认；原输入保留。' } }
}
const inputs = [controlled('fixture-human-input', humanText, true), controlled('fixture-unknown-input', unknownText, false),
  { kind: 'submission', sequence: 3, recordedAt: 1, key: inputKey,
    record: { agentSessionId: participant, run: scene.session.run, admission: scene.session.promptCompletionAdmission } }]
api.ui.writeClipboardText = async text => { copied.push(text) }
api.sessions.onEvent = () => () => {}
api.sessions.readMessage = async (reference, messageId, notificationId) => {
  calls.push({ kind: 'message', reference: { ...reference }, messageId, notificationId })
  if (surface === 'conversation') return { hostId: reference.hostId, message: await new Promise((resolve, reject) => pending.push({ messageId, resolve, reject })) as typeof scene.original }
  return { hostId: reference.hostId, message: structuredClone(originals.find(({ envelope }) => envelope.messageId === messageId)) }
}
api.sessions.listMessages = async (reference, options) => {
  calls.push({ kind: 'list', reference: { ...reference }, direction: options.direction })
  const messages = originals.filter(({ envelope }) => (options.direction === 'incoming' ? envelope.recipientSessionId : envelope.senderSessionId) === reference.agentSessionId)
    .map(original => { const { body, ...envelope } = original.envelope; return { ...original, envelope, bodyPreview: body, bodyBytes: new TextEncoder().encode(body).length } })
  return { hostId: reference.hostId, participantSessionId: reference.agentSessionId, direction: options.direction, messages, nextBeforeSequence: null }
}
api.sessions.inputMailbox = async (reference, options) => {
  calls.push({ kind: 'inputs', reference: { ...reference } })
  return { agentSessionId: reference.agentSessionId, queueId: 'private-input-inventory', cut: { incarnation: 'private-input-cut', throughSequence: 3 },
    budgetBytes: options?.maxBytes ?? 64 * 1024, items: [...inputs].sort((a, b) => b.sequence - a.sequence).map(item => ({ kind: 'item', item })), nextCursor: null,
    coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } }
}
// Fail loudly if reading accidentally reaches a business input or consumption action.
for (const method of ['sendMessage', 'notifyMessage', 'acknowledgeMessages', 'submitPrompt', 'write'] as const) {
  if (method in api.sessions) Object.assign(api.sessions, { [method]: async () => { forbidden.push(method); throw Error('Reading attempted ' + method) } })
}
const reader = {
  readAgentConversation: async reference => { calls.push({ kind: 'conversation', reference: { ...reference } }); return structuredClone(scene.page) },
  readConversationChanges: async () => structuredClone(scene.page),
  observeConversation: async () => ({ sourceHostId: scene.snapshot.sourceHostId, scope: scene.snapshot.scope, closed: new AbortController().signal, dispose() {} }),
  releaseConversationView: async () => ({})
}
Object.assign(api.conversation, reader)
const root = createRoot(document.getElementById('root')!)
mountThemeRuntime(window, { appAppearance: 'dark' })
function Scene({ generation }: { generation: number }) {
  return <DesktopClientUiProvider><main className="reference-reading-probe" data-generation={generation}>
    <header className="reference-reading-probe__header"><strong>{surface === 'conversation' ? 'Conversation' : 'Messages'}</strong><span>A2A 原信阅读</span></header>
    <section className="reference-reading-probe__reader">
      {surface === 'conversation' ? <ActivityView sessionId={scene.reference.agentSessionId} executionHostId={scene.reference.hostId} capability="complete-events"
        conversationReading={{ reference: scene.reference, identity: 'reference-reading', enabled: true, opened: true }} /> :
        <div className="reference-reading-probe__mail-trigger"><SessionMailbox
          control={{ kind: 'agent', hostId: scene.reference.hostId, agentSessionId: participant,
            run: participant === scene.reference.agentSessionId ? scene.session.run : { runId: scene.original.envelope.senderRunId } }}
          system={{ scope: participant, available: true, notices: [], unread: [], acknowledge() {} }} queued={[]}
          reading={{ describeSpeaker: speaker => ({ name: speaker.id }) }} onCopyQueued={async text => { copied.push(text); return true }} /></div>}
    </section>
    <label className="reference-reading-probe__draft">Draft<textarea aria-label="Unsent draft" defaultValue={draft} /></label>
  </main></DesktopClientUiProvider>
}
Object.assign(window, { a2aReferenceReading: {
  ready: true,
  seed(next: 'conversation' | 'mailbox', theme: 'dark' | 'light', generation: number, sender = false) {
    if (pending.length) throw Error('Do not discard an unsettled original read')
    surface = next; participant = sender ? scene.original.envelope.senderSessionId : scene.reference.agentSessionId
    calls.length = 0; copied.length = 0; updateThemeSelection({ appAppearance: theme })
    flushSync(() => root.render(<Scene key={generation} generation={generation} />))
    return { reference: scene.reference, participant, messageId: scene.messageId, notificationId: scene.notificationId,
      messages: originals.map(({ envelope }) => ({ messageId: envelope.messageId, body: envelope.body })), wire: scene.wire, draft,
      originalRecords: scene.projection.records[0].records.map(record => record.original.item), humanText, unknownText }
  },
  settle(outcome: 'failure' | 'original') {
    const request = pending.shift(); if (!request) throw Error('No original read is pending')
    if (outcome === 'failure') request.reject(Error('原信存储暂不可用，原引用保留。'))
    else request.resolve(structuredClone(originals.find(({ envelope }) => envelope.messageId === request.messageId)))
  },
  facts() { return { calls: structuredClone(calls), copied: [...copied], forbidden: [...forbidden], pending: pending.length,
    draft: document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent draft"]')?.value,
    draftFocused: document.activeElement === document.querySelector('[aria-label="Unsent draft"]') } }
} })
