import { api } from '../../../src/renderer/src/lib/api'
import { parseConversationReadPage, projectConversationTimeline } from '@agentmux/core/conversation'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'

api.sessions.inputMailbox = async (source, options) => ({ agentSessionId: source.agentSessionId, queueId: 'original-private-inputs', cut: { incarnation: 'original-private-incarnation', throughSequence: 0 },
  budgetBytes: options?.maxBytes ?? 65536, items: [], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } })
function conversation(input) {
  const timeline = { agentSessionId: input.agentSessionId, sourceHostId: input.hostId, revision: 0, items: [], stream: { epoch: 'private-original-empty', revision: 0, sequence: 0, origin: 'beginning', gaps: [], positions: [] } }
  const projected = projectConversationTimeline({ agentSessionId: input.agentSessionId, executionHostId: input.hostId, timeline })
  const checkpoint = { hostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: input.hostId,
    frontier: { hostId: input.hostId, agentSessionId: input.agentSessionId, scope: projected.scope, cuts: [{ kind: 'captured', epoch: timeline.stream.epoch, sequence: 0 }] } }
  return parseConversationReadPage({ hostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: input.hostId, scope: projected.scope, coverage: projected.coverage,
    order: { ...projected.order, direction: 'newest-first' }, items: [], nextCursor: null, budgetBytes: input.maxBytes ?? 65536, ...(input.processDetails ? { processDetails: input.processDetails } : {}),
    window: { id: 'private-original-window', revision: 1, itemCount: 0, complete: true, view: 'private-original-view', replay: 'private-original-replay', checkpoint,
      outside: { older: null, newer: null }, navigation: { older: null, newer: null } } }, input)
}
api.conversation.readAgentConversation = async input => conversation(input)
api.conversation.readConversationChanges = async input => { const page = conversation(input); return { ...page, checkpoint: page.window.checkpoint, more: false } }
api.conversation.observeConversation = async input => { const page = conversation(input), controller = new AbortController(); return { hostId: input.hostId, agentSessionId: input.agentSessionId,
  sourceHostId: input.hostId, scope: page.scope, coverage: page.coverage, closed: controller.signal, dispose() { controller.abort() } } }
api.conversation.releaseConversationView = async input => ({ hostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: input.hostId, viewId: input.view, released: true })

const recovery = async request => ({ operation: { operationId: request.operationId, agentSessionId: request.reference.sessionId, trigger: 'manual', previousRun: request.expectedRun,
  policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, admittedAt: Date.now(), observedAt: Date.now(), rechecks: 0, kind: 'reattachable', reason: 'reattachable',
  evidence: { kind: 'run-running', observedAt: Date.now() }, moteMainEntry: { target: request.target, expectedRoleRevision: request.expectedRoleRevision, reference: request.reference } } })
api.moteDialogue.inspectRecovery = recovery
api.moteDialogue.ensureRecovery = recovery
