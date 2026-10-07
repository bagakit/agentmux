import { AgentMuxError } from './errors.js'
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
