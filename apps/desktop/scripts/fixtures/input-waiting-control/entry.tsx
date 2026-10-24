import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import type { AgentInputMailboxItem, AgentInputMailboxPage } from '@agentmux/core/agent-input-mailbox'
import type { AgentInputSubmissionReceipt, AgentInputWaitStopReceipt } from '@agentmux/core'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { SessionMailbox } from '../../../src/renderer/src/components/SessionMailbox'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import '../../../src/renderer/src/styles/index.css'

const at = fixtureEpoch(0, 0, 1000), hostId = 'original-chat-host', agentSessionId = 'original-private-agent'
const run = { runId: 'original-private-run' }
const key = { kind: 'message' as const, agentSessionId, expectedRun: run, messageId: 'original-external-message' }
const ref = { key, waitGeneration: 1 }
const originalControlOperationId = 'original-external-control'
const actor = { application: { domain: 'open.feishu.cn', appId: 'original-private-bot' }, idType: 'open_id', userId: 'original-person' }
const original: AgentInputSubmissionReceipt = { key, ref, originalControlOperationId, persistence: 'confirmed',
  control: { ref, state: 'enabled', at, waiting: { phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored' } },
  admission: null, status: 'waiting', observation: 'rejoin-needed' }
let receipt = structuredClone(original)
let outcome: AgentInputWaitStopReceipt['outcome'] = 'stopped-before-dispatch'
const reads: unknown[] = [], actions: unknown[] = [], forbidden: string[] = []
const body = 'Please review the release plan and retain this original request.\n\nThis message is waiting for the original Agent. Stopping its wait must not stop the Agent or resend the message.'
const message = { schema: 'agentmux.a2a.v1' as const, messageId: key.messageId, operationId: originalControlOperationId,
  createdAt: at, sender: { kind: 'external' as const, connectionId: 'original-connection', actor,
    externalConversationId: 'original-private-chat', externalMessageId: 'original-native-message', bindingId: 'original-binding', bindingRevision: 1,
    grantId: 'original-input-grant', grantRevision: 1 }, recipient: { kind: 'agent-session' as const, agentSessionId },
  threadId: 'original-private-thread', correlationId: 'original-private-correlation', replyTo: null, workspaceId: null,
  senderSessionId: null, senderRunId: null, recipientSessionId: agentSessionId, recipientRunId: run.runId, body,
  channelProfile: { actor, state: 'observed' as const, profile: { name: 'Ava Chen', observedAt: at }, checkedAt: at, freshness: 'current' as const } }
const config = await api.config.get()
useAppStore.setState({ config, sessions: [], timelines: {}, loading: false, mailboxNotificationIntents: {}, mailboxNotificationFeedback: {}, mailboxNotificationHistory: {} })
mountThemeRuntime(window, config.appearance)
api.sessions.listMessages = async (target, query = {}) => {
  reads.push({ method: 'listMessages', target, query })
  return { hostId: target.hostId, participantSessionId: target.agentSessionId, direction: query.direction ?? 'incoming', messages: [], nextBeforeSequence: null }
}
api.sessions.onEvent = () => () => {}
api.sessions.inputMailbox = async (target, query) => {
  reads.push({ method: 'inputMailbox', target, query })
  if (target.hostId !== hostId || target.agentSessionId !== agentSessionId) throw Error('The preview reads only its exact original journal.')
  const item: AgentInputMailboxItem = { kind: 'controlled', sequence: 1, recordedAt: at,
    intent: { key, admissionIntent: { kind: 'manual-actor', expectedRun: run }, execution: 'immediate',
      source: { kind: 'message', messageId: key.messageId, originalControlOperationId } }, message, receipt }
  return { agentSessionId, queueId: 'original-input-journal', cut: { incarnation: 'original-incarnation', throughSequence: 1 },
    budgetBytes: 128 * 1024, items: [{ kind: 'item', item }], nextCursor: null,
    coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } } satisfies AgentInputMailboxPage
}
api.sessions.inspectInput = async (target, input) => { reads.push({ method: 'inspectInput', target, input }); return structuredClone(receipt) }
api.sessions.stopInputWaiting = async (target, input, cancelOperationId) => {
  actions.push({ method: 'stopInputWaiting', target, ref: structuredClone(input), cancelOperationId, outcome })
  if (JSON.stringify(input) !== JSON.stringify(ref) || target.hostId !== hostId || target.run.runId !== run.runId) throw Error('The preview action changed its original target.')
  if (outcome === 'stopped-before-dispatch') receipt = { ...original, control: { ref, state: 'stopped-before-dispatch', at }, status: 'stopped', observation: 'closed' }
  else if (outcome === 'observation-stopped') receipt = { ...original, control: { ref, state: 'dispatch-authorized', gateId: 'original-gate', at }, status: 'unknown', observation: 'closed' }
  else if (outcome === 'stale-generation') { const next = { key, waitGeneration: 2 }; receipt = { ...original, ref: next, control: { ...original.control, ref: next } } }
  return { ref: structuredClone(input), cancelOperationId, outcome, at }
}
for (const name of ['write', 'paste', 'submitPrompt', 'rejoinInputWaiting', 'recover', 'restart', 'stop', 'launchAgent', 'launchTerminal'] as const) {
  Object.assign(api.sessions, { [name]: async () => { forbidden.push(name); throw Error('This private read/Stop fixture cannot perform ' + name) } })
}
const root = createRoot(document.getElementById('root')!)
let revision = 0
function Scene() {
  const [draft, setDraft] = useState('Keep this independent unsent draft.')
  return <DesktopClientUiProvider><main data-workbench-region-id="original-input-preview">
    <div className="preview-space" />
    <SessionMailbox control={{ kind: 'agent', hostId, agentSessionId, run }} system={{ available: true, notices: [], unread: [], acknowledge() {} }} queued={[]}>
      {(mailbox, pending, composerRef) => <AgentComposer surfaceRef={composerRef} value={draft} disabled={false} placeholder="Message Agent"
        onChange={setDraft} mailbox={mailbox} aboveInput={pending} onSubmit={() => forbidden.push('composer-submit')} />}
    </SessionMailbox>
  </main></DesktopClientUiProvider>
}
const render = () => flushSync(() => root.render(<Scene key={revision} />))
Object.assign(window, { originalWaitingPreview: {
  seed(value: AgentInputWaitStopReceipt['outcome']) { outcome = value; receipt = structuredClone(original); ++revision; render() },
  facts() { return { hostId, key, ref, receipt: structuredClone(receipt), reads: structuredClone(reads), actions: structuredClone(actions), forbidden: [...forbidden] } },
  dispose() { root.unmount() }
} })
render()
