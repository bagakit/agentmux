import '../mote-companion-workflows/persona-entry'
import { MOTE_CHAT_DEFAULT_VALUES, moteChatDiagnosisKey, type MoteChatConfiguration, type MoteChatDiagnosis } from '@agentmux/core/mote-chat'
import type { AgentInputMailboxPage } from '@agentmux/core/agent-input-mailbox'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'

const at = fixtureEpoch(1, 120), owner = { hostId: 'chat-host', runtimeId: 'chat-runtime' }
const application = { domain: 'open.feishu.cn', appId: 'private-bot' }, actor = { application, idType: 'open_id', userId: 'original-person' }
const connection = { connectionId: 'private-connection', application }, agentSessionId = 'original-private-agent'
const peopleOnly = new URLSearchParams(location.search).has('people-only')
const guest = { ...actor, userId: 'original-guest-research-and-engineering-collaboration' }
const run = { runId: 'original-private-run' }, key = { kind: 'message' as const, agentSessionId, expectedRun: run, messageId: 'original-message' }, ref = { key, waitGeneration: 1 }
const receipt: AgentInputSubmissionReceipt = { key, ref, originalControlOperationId: 'original-control', persistence: 'confirmed',
  control: { ref, state: 'enabled', at, waiting: { phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored' } },
  admission: null, status: 'waiting', observation: 'rejoin-needed' }
const reads: unknown[] = [], forbidden: string[] = []
let historyState: 'ready' | 'unavailable' | 'loading' = 'ready', finishHistory: (() => void) | undefined
let inputStatus: 'waiting' | 'admitted' = 'waiting'
api.connections.hostingTarget = async () => owner
api.connections.onMetadataChanged = (_listener, observation) => { observation?.('ready'); return () => {} }
api.connections.call = async (method, input, target) => {
  reads.push({ method, input, target })
  if (method === 'connection.ls') return { connections: [{ revision: 1, config: { ...connection, adapterId: 'lark', label: 'Mote companion', enabled: true, credentialRef: 'preview-secret' }, initialSetup: { state: 'complete' } }] } as never
  if (method === 'connection.service.get') return { enabled: true, revision: 1 } as never
  if (method === 'connection.metadata.get' && 'subject' in input) {
    if (JSON.stringify(target) !== JSON.stringify(owner) || input.connectionId !== connection.connectionId || input.subject.kind !== 'actor') throw Error('Read one exact original person profile')
    const original = input.subject.actor.userId === actor.userId
    return { ...connection, connectionRevision: 1, entry: { subject: input.subject, cacheRevision: original ? 'original-profile' : null,
      observation: { actor: input.subject.actor, state: original ? 'observed' : 'unknown', freshness: original ? 'current' : 'unknown',
        profile: original ? { name: 'Ava Chen', observedAt: at } : null, checkedAt: at } } } as never
  }
  throw Error('This private renderer does not perform ' + method)
}
api.moteChat.call = async (method, input, target) => {
  reads.push({ method, input, target })
  if (JSON.stringify(target) !== JSON.stringify(owner)) throw Error('Private chat must read its original owner')
  const chatTarget = 'target' in input ? input.target! : null
  const configuration: MoteChatConfiguration = { target: chatTarget!, revision: 1, creator: actor,
    values: { ...MOTE_CHAT_DEFAULT_VALUES, enabled: true, connection } }
  if (method === 'space.mote.chat.inspect') return { configuration, operation: null } as never
  if (method === 'space.mote.chat.diagnose') return { targetKey: moteChatDiagnosisKey(chatTarget!), limit: 5,
    configuration: { revision: 1, enabled: true, connection }, readiness: { state: 'ready', code: null }, service: { enabled: true, revision: 1 }, adapterService: { enabled: true, revision: 1 }, connection: null, publications: [], issues: [],
    incoming: { more: false, rows: [{ key: 'a'.repeat(64), state: 'claimed', code: null, codeRecorded: false, preparation: 'ready', input: {
      status: inputStatus, observation: 'observed', controlState: inputStatus === 'waiting' ? 'enabled' : 'dispatch-authorized', receiptObservation: inputStatus === 'waiting' ? 'rejoin-needed' : 'closed',
      waiting: inputStatus === 'waiting' ? { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin' } : null,
      preparationReason: null, failureCode: inputStatus === 'waiting' ? 'STALE_AGENT_SESSION' : null,
      runtime: inputStatus === 'waiting' ? { target: 'original', state: 'interrupted', exitCode: null } : null } }] } } satisfies MoteChatDiagnosis as never
  if (method === 'space.mote.chat.audience') return { people: [{ actor, name: 'Ava Chen', creator: true, revision: 1, total: null, used: 3, remaining: null },
    ...(peopleOnly ? [{ actor: guest, name: null, creator: false, revision: 1, total: 8, used: 3, remaining: 5 }] : [])], next: null } as never
  if (method === 'space.mote.chat.history') {
    if (!('actor' in input) || JSON.stringify(input.actor) !== JSON.stringify(actor)) throw Error('Read one exact person')
    if (historyState === 'unavailable') throw Error('The original hosting connection is temporarily unavailable.')
    if (historyState === 'loading') await new Promise<void>(resolve => { finishHistory = resolve })
    return { generations: [0, 1].map(index => ({ generationId: 'conversation-' + index, target: chatTarget, application,
      actor, externalConversationId: 'original-private-chat', executionHostId: 'execution-host', agentSessionId: index ? 'earlier-private-agent' : agentSessionId,
      createOperationId: 'create-private-' + index, phase: 'ready', createdAt: at - index * 60000, lastActivityAt: at - index * 30000 })), next: null } as never
  }
  forbidden.push(method); throw Error('Read-only Profile fixture cannot perform ' + method)
}
api.sessions.inputMailbox = async (target, input) => {
  reads.push({ method: 'inputMailbox', target, input })
  if (target.hostId !== 'execution-host' || target.agentSessionId !== agentSessionId) throw Error('Exact original Session required')
  return { agentSessionId, queueId: 'original-journal', cut: { incarnation: 'original-cut', throughSequence: 1 }, budgetBytes: input!.maxBytes!,
    items: [{ kind: 'item', item: { kind: 'controlled', sequence: 1, recordedAt: at,
      intent: { key, admissionIntent: { kind: 'manual-actor', expectedRun: run }, execution: 'immediate', source: { kind: 'message', messageId: key.messageId, originalControlOperationId: 'original-control' } },
      receipt, message: { schema: 'agentmux.a2a.v1', messageId: key.messageId, operationId: 'original-control', createdAt: at,
        sender: { kind: 'external', connectionId: connection.connectionId, actor, externalConversationId: 'original-private-chat', externalMessageId: 'original-native-message', bindingId: 'original-binding', bindingRevision: 1, grantId: 'original-grant', grantRevision: 1 },
        recipient: { kind: 'agent-session', agentSessionId }, threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null,
        senderSessionId: null, senderRunId: null, recipientSessionId: agentSessionId, recipientRunId: run.runId,
        body: 'Help me review the release plan. Keep the original conversation and my earlier notes.',
        channelProfile: { actor, state: 'observed', profile: { name: 'Ava Chen', observedAt: at }, checkedAt: at, freshness: 'current' } } } }],
    nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } } satisfies AgentInputMailboxPage
}
for (const name of ['submitPrompt', 'rejoinInputWaiting', 'recover', 'restart', 'stop', 'launchAgent', 'stopInputWaiting'] as const) Object.assign(api.sessions, {
  [name]: async () => { forbidden.push(name); throw Error('Read-only history cannot perform ' + name) }
})
const current = useAppStore.getState()
const config = { ...current.config!, executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } } }
for (const snapshot of Object.values(current.scratchTopicSnapshots)) for (const topic of snapshot.topics ?? []) topic.quickMode = { status: 'saved', defaults: { executorId: 'codex' }, version: 'original-quick-mode' }
useAppStore.setState({ config, manualConnectionSelections: { lark: owner }, moteChatIntents: {} })
mountThemeRuntime(window, config.appearance)
Object.assign(window, { privateChatPreview: {
  theme(light: boolean) { updateThemeSelection({ ...config.appearance, appAppearance: light ? 'light' : 'dark' }) },
  history(state: typeof historyState) { historyState = state }, finish() { finishHistory?.(); finishHistory = undefined; historyState = 'ready' },
  accepted() { inputStatus = 'admitted' },
  facts() { const state = useAppStore.getState(); return { reads, forbidden, drafts: state.agentComposerDrafts, focus: state.focusAgentReveal, sessions: state.sessions.length } }
} })
