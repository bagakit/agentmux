import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { FocusContext } from './focus-context'
import type { SessionSnapshot } from '../../../shared/contracts'
import { focusActivityEntryTime, focusBucketForSession } from './focus-context'
import { observeAgentSession } from './agent-observation'
import type { CollaborationAgent } from './agent-collaboration'

/** Original activity facts choose visual weight; no activity is inferred from map use or output. */
export function collaborationAgentPresentation(session: Extract<SessionSnapshot, { kind: 'agent' }>, name?: string): Pick<CollaborationAgent, 'name' | 'tier' | 'lastActivityAt'> {
  const bucket = focusBucketForSession(session, false)
  const tier = session.processState === 'exited' && !session.runUnobserved ? 'closed'
    : bucket === 'working' || bucket === 'attention' ? 'active'
      : session.processState === 'running' && observeAgentSession(session, Date.now()).semantic === 'idle' ? 'idle' : 'unknown'
  return { name: name ?? session.label, tier, lastActivityAt: focusActivityEntryTime(session) ?? null }
}
export function collaborationNodeSize(tier: CollaborationAgent['tier']) {
  return tier === 'closed' ? { width: 24, height: 24 } : tier === 'idle' || tier === 'unknown' ? { width: 154, height: 38 } : { width: 250, height: 94 }
}
/** Recency changes ink and the point inside its stable hit box, never layout geometry. */
export function collaborationRecency(at: number | null | undefined, now = Date.now()) {
  if (at == null || !Number.isFinite(at) || at <= 0 || at > now) return { radius: 5, depth: .45, label: 'Activity time unknown' }
  const days = (now - at) / 86_400_000, weight = 1 / (1 + Math.log2(1 + days))
  return { radius: 4 + 7 * weight, depth: .35 + .65 * weight, label: `Last activity ${new Date(at).toLocaleString()}` }
}

export const collaborationAgentName = (agent: CollaborationAgent | undefined) => agent?.name ?? agent?.context?.name ?? agent?.sessionId ?? ''

/** A retained descriptor supplies reading metadata, never a synthetic Session or current Run. */
export function collaborationHistoryContext(source: AgentSessionHistoryDescriptor, name?: string): FocusContext {
  return { id: source.agentSessionId, hostId: source.hostId, name: name ?? source.agentSessionId,
    kind: 'agent', providerId: source.history?.providerId ?? null, ...(source.history?.executorId ? { executorId: source.history.executorId } : {}),
    workspacePath: source.history?.workspacePath ?? '', workspace: undefined, workspaceId: '', workspaceName: 'Retained Session', topicId: null,
    runId: '', runUnobserved: true, processState: 'interrupted', state: 'disconnected', stateLabel: source.state === 'retired' ? 'Retired' : 'Unobserved', bucket: 'idle',
    liveAgent: false, actionable: false, lastActivityAt: null, workingEnteredAt: null,
    detail: `${source.state === 'retired' ? 'Retired' : 'Retained'} Session · Current Run is unconfirmed`, detailIsRecap: false, detailKind: 'service', recap: null }
}
