import { guideText } from './guide-text.js'
import { AgentMuxError } from './errors.js'

export const GLOBAL_GOAL_PATROL_GUIDANCE = guideText("shared/goal/patrol")

export function globalGoalPatrolPrompt(totalCount: number, inventoryIssue?: string): string {
  return ['全局 Demand 巡查', 'Read "$AGENTMUX_CLI" goal --skill before inspecting the original Goals.',
    GLOBAL_GOAL_PATROL_GUIDANCE,
    'Original-owner scope reference (all statuses, no UI filters; identities are not copied into this prompt):',
    JSON.stringify({ schema: 'agentmux.goal-global-patrol-scope.v1', ...(inventoryIssue ? { state: 'unavailable', reason: inventoryIssue }
      : { state: 'observed', totalCount, inventory: 'not-inlined; discover every original Goal with goal ls, without filters or a limiting sample' }) }),
    'Use goal ls without filters or a limiting sample, then goal inspect / delegations / activity for every original Goal. Begin the actual inspection now and return the overview, actionable confirmation proposals and structured questions here.'
  ].join('\n\n')
}
export type GoalPatrolObservation = { operationId: string; state: 'prepared' | 'delivered' | 'unknown' | 'missing' | 'stale' | 'reported'; reason: string }
export function parseGoalPatrolObservations(value: unknown, operationIds: readonly string[]): GoalPatrolObservation[] {
  if (!Array.isArray(value)) throw new AgentMuxError('Original patrol observations must be an array.', 'CONTROL_PROTOCOL_ERROR')
  const seen = new Set<string>()
  return value.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Invalid patrol observation.', 'CONTROL_PROTOCOL_ERROR')
    const p = value as Record<string, unknown>
    if (Object.keys(p).some(k => !['operationId', 'state', 'reason'].includes(k)) || typeof p.operationId !== 'string' || !operationIds.includes(p.operationId) || seen.has(p.operationId) ||
      !['prepared', 'delivered', 'unknown', 'missing', 'stale', 'reported'].includes(String(p.state)) || typeof p.reason !== 'string' || !p.reason.trim()) throw new AgentMuxError('Patrol observation differs from its original request.', 'CONTROL_PROTOCOL_ERROR')
    seen.add(p.operationId)
    return { operationId: p.operationId, state: p.state as GoalPatrolObservation['state'], reason: p.reason }
  })
}
