/** A typed reference to the original Demand-owned Start; it carries no input authority itself. */
export type GoalDispatchReference = { goalId: string; operationId: string }
export function assertGoalDispatchReference(value: unknown): asserts value is GoalDispatchReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('The original Goal dispatch reference must be an object.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => key !== 'goalId' && key !== 'operationId') ||
      typeof input.goalId !== 'string' || !input.goalId.trim() || input.goalId.includes('\0') ||
      typeof input.operationId !== 'string' || !input.operationId.trim() || input.operationId.includes('\0'))
    throw new Error('The exact original Goal dispatch reference is required.')
}
