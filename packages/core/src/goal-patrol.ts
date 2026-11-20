import { renderAmuxProtocol } from './amux-protocol.js'
import { guideSharedGoalPatrol } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'
import { AgentMuxError } from './errors.js'

export const GLOBAL_GOAL_PATROL_GUIDANCE = /* @__PURE__ */ guideText(guideSharedGoalPatrol)

export function globalGoalPatrolPrompt(totalCount?: number, inventoryIssue?: string): string {
  return renderAmuxProtocol('goal-task', 'global-patrol', {
    guide: GLOBAL_GOAL_PATROL_GUIDANCE,
    scope: JSON.stringify({ schema: 'agentmux.goal-global-patrol-scope.v1', ...(inventoryIssue ? { state: 'unavailable', reason: inventoryIssue }
      : { state: totalCount === undefined ? 'read-original-owner' : 'observed', ...(totalCount === undefined ? {} : { totalCount }) }) })
  })
}
export type GoalPatrolObservation = { operationId: string; state: 'prepared' | 'delivered' | 'unknown' | 'missing' | 'stale' | 'reported' | 'planned'; planRevision?: number; reason: string }
export function parseGoalPatrolObservations(value: unknown, operationIds: readonly string[]): GoalPatrolObservation[] {
  if (!Array.isArray(value)) throw new AgentMuxError('Original patrol observations must be an array.', 'CONTROL_PROTOCOL_ERROR')
  const seen = new Set<string>()
  return value.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Invalid patrol observation.', 'CONTROL_PROTOCOL_ERROR')
    const p = value as Record<string, unknown>
    if (Object.keys(p).some(k => !['operationId', 'state', 'reason', 'planRevision'].includes(k)) || typeof p.operationId !== 'string' || !operationIds.includes(p.operationId) || seen.has(p.operationId) ||
      !['prepared', 'delivered', 'unknown', 'missing', 'stale', 'reported', 'planned'].includes(String(p.state)) || typeof p.reason !== 'string' || !p.reason.trim()) throw new AgentMuxError('Patrol observation differs from its original request.', 'CONTROL_PROTOCOL_ERROR')
    if (p.state === 'planned' ? !Number.isSafeInteger(p.planRevision) || Number(p.planRevision) < 1 : p.planRevision !== undefined) throw new AgentMuxError('Planning completion requires its saved plan revision.', 'CONTROL_PROTOCOL_ERROR')
    seen.add(p.operationId)
    return { operationId: p.operationId, state: p.state as GoalPatrolObservation['state'], reason: p.reason, ...(p.state === 'planned' ? { planRevision: p.planRevision as number } : {}) }
  })
}
