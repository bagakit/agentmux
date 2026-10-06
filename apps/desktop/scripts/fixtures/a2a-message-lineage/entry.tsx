import { flushSync } from 'react-dom'
import type { AgentMuxRpcResult, DurableAgentMuxMessage } from '@agentmux/core'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import { fixturePath } from '../../lib/fixture-values.mjs'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
const getConfig = api.config.get, getSnapshot = api.sessions.snapshot
const previewDirectory = fixturePath('workspace/collaboration-preview')
api.config.get = async () => { const config = await getConfig(); return { ...config, workspaces: config.workspaces.map((workspace, index) => index === 0 ? { ...workspace, path: previewDirectory } : workspace) } }
api.sessions.snapshot = async () => { const snapshot = await getSnapshot(); return { ...snapshot, sessions: snapshot.sessions.map(session => session.kind === 'agent' ? { ...session, workspacePath: previewDirectory } : session) } }
mountThemeRuntime(window, { appAppearance: 'dark' })
await import('../result-ready-input-continuity/entry')
const original = (window as any).resultReady, owner: string = original.sessionId
const worker = useAppStore.getState().sessions.find(session => session.id !== owner)!.id
const originalTab = useAppStore.getState().tabs[original.tabId]!
flushSync(() => useAppStore.setState({ tabs: { [original.tabId]: createWorkbenchTab(original.tabId, originalTab.regions[original.regionId]!) } }))
const reads: unknown[] = [], navigations: string[] = []
let failDetail = false, failPage = false, reported = false, sourceCount = 25
function message(id: string, sender = owner, recipient = worker, replyTo: string | null = null): DurableAgentMuxMessage {
  return { sequence: 1, envelope: { schema: 'agentmux.a2a.v1', messageId: id, operationId: 'operation-' + id, createdAt: fixtureEpoch(1),
    sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: sender, senderRunId: sender === owner ? 'recorded-owner-run' : 'recorded-worker-run', recipientSessionId: recipient, recipientRunId: recipient === owner ? 'recorded-owner-run' : 'recorded-worker-run',
    threadId: 'original-collaboration-thread', correlationId: 'correlation-' + id, replyTo, workspaceId: null,
    body: id.startsWith('original-source') ? 'Review the original result and preserve the current draft.\n\nThe evidence still needs independent review. Keep this exact request available while reading the replies.' : 'Original worker evidence: the result is ready for review; no Goal acceptance is recorded.' },
    delivery: { state: id.startsWith('original-source') ? 'delivered' : 'queued', at: fixtureEpoch(1) } }
}
function observation(id: string): AgentMuxRpcResult<'message.dispatch.read'> {
  const source = message(id), replies = [message('original-question', worker, owner, id), ...(reported ? [message('original-report', worker, owner, id)] : [])]
  return { hostId: 'local', source, replies, dispatch: { sourceMessageId: id, ownerAgentSessionId: owner, workerAgentSessionId: worker, threadId: source.envelope.threadId,
    openedAt: fixtureEpoch(1), originAwaits: !reported, events: [{ kind: 'question', replyMessageId: 'original-question', at: fixtureEpoch(1) },
      ...(reported ? [{ kind: 'worker_done' as const, replyMessageId: 'original-report', at: fixtureEpoch(1) }] : [])] },
    identityDiagnostics: [{ agentSessionId: worker, runId: 'recorded-worker-run', code: 'DISPATCH_IDENTITY_UNAVAILABLE', message: 'Current Run observation is unavailable. Original messages remain readable.' }] }
}
api.sessions.dispatches = async (reference, options) => {
  reads.push({ kind: 'list', reference, options }); if (failPage && options?.afterSourceMessageId) { failPage = false; throw new Error('The original later-page read is unavailable. Existing sources remain available.') }
  const ids = Array.from({ length: sourceCount }, (_, index) => 'original-source-' + (index + 1)), offset = options?.afterSourceMessageId ? ids.indexOf(options.afterSourceMessageId) + 1 : 0
  const page = ids.slice(offset, offset + (options?.limit ?? 20))
  return { hostId: reference.hostId, participantSessionId: reference.agentSessionId, dispatches: page.map(id => observation(id).dispatch), nextSourceMessageId: offset + page.length < ids.length ? page.at(-1)! : null }
}
api.sessions.dispatch = async (reference, source) => { reads.push({ kind: 'detail', reference, source }); if (failDetail) { failDetail = false; throw new Error('The original message read is unavailable. Keep the existing request and try this same source again.') }; return observation(source) }
api.ui.openObjectLink = async link => { navigations.push(link); return { kind: 'external' } as never }
Object.assign(window, { collaborationFixture: {
  owner, worker, reads, navigations,
  theme(mode: 'dark' | 'light') { updateThemeSelection({ appAppearance: mode }) },
  failNextDetail() { failDetail = true }, failNextPage() { failPage = true }, report() { reported = true },
  empty() { sourceCount = 0 }, facts() { return original.facts() }
} })
