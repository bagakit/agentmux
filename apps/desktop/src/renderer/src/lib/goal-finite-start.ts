/** Retained user intent only. Delivery and execution remain with Demand/Core. */
export type GoalFiniteStartIntent = {
  goalId: string
  operationId: string
  sessionId: string
  expectedUpdatedAt: number
  phase: 'not-attempted' | 'may-have-dispatched'
}
export function restoredGoalFiniteStartIntents(value: unknown): Record<string, GoalFiniteStartIntent> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, GoalFiniteStartIntent> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as GoalFiniteStartIntent
    if (entry.goalId !== key || !key || typeof entry.operationId !== 'string' || !entry.operationId ||
      typeof entry.sessionId !== 'string' || !entry.sessionId || !Number.isSafeInteger(entry.expectedUpdatedAt) || entry.expectedUpdatedAt < 0) continue
    result[key] = { goalId: key, operationId: entry.operationId, sessionId: entry.sessionId, expectedUpdatedAt: entry.expectedUpdatedAt,
      phase: entry.phase === 'not-attempted' ? 'not-attempted' : 'may-have-dispatched' }
  }
  return result
}
