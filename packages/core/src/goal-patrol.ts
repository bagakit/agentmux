import { AgentMuxError } from './errors.js'

export const GLOBAL_GOAL_PATROL_GUIDANCE = `Global inspection is an inspection and discussion request, not permission to change Goals.
Read the original complete Goal inventory, then inspect every Goal's current content,
execution/delegation/patrol responsibility, activity, reports and locatable evidence.
Include finished Goals and Goals outside the current Project, search or UI filters.
The observed inventory count is a scope reference, not an inspection result or a frozen list.
Discover the complete identities from the original Goal owner. Identify newly found
Goals and distinguish checked facts, stale evidence, failed reads and unknowns; never
silently omit an unread Goal or claim an empty/partial read is a complete inspection.
Return the overview and findings in this same discussion. Structure each actionable item
by exact Goal ID, observed version/source, issue, evidence/unknown, next responsible party
and suggested next action. For directly actionable suggestions, show the exact targets,
operations and effects, then ask the person to confirm selected actions or a named group.
Only after that actual confirmation use the original business owners, recheck targets
and versions, and report success/failure/unknown receipts separately. Keep unknown
operations without blind replay. Other issues remain structured discussion questions
with evidence, missing information, decisions needed and a concrete next step.
Do not replace original management, report as another Goal's PMO, confirm alignment,
accept results for a person, restart/replace Sessions, install or perform external actions
on the strength of this inspection request. Keep the original work and healthy Agents.`

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
