/** A retained human request, not a second source of delivery or plan facts. */
export type GoalDiscussionTaskMode = 'grill' | 'grounding' | 'plan'
export type GoalDiscussionRequest = {
  goalId: string
  mode: GoalDiscussionTaskMode
  requestId: string
  executorId?: string
}
export const goalDiscussionRequestKey = (goalId: string, mode: GoalDiscussionTaskMode): string => JSON.stringify([goalId, mode])

/** Keep unreadable references in their original persistence owner; never replace one with a new send. */
export function originalGoalDiscussionRequest(value: unknown, goalId: string, mode: GoalDiscussionTaskMode): GoalDiscussionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The original discussion request is unconfirmed. Its saved reference and Agent are retained.')
  const request = value as GoalDiscussionRequest
  if (request.goalId !== goalId || request.mode !== mode || typeof request.requestId !== 'string' || !request.requestId.trim() ||
      request.executorId !== undefined && (typeof request.executorId !== 'string' || !request.executorId.trim()))
    throw new Error('The original discussion request identity is unconfirmed. Keep its saved reference and inspect the original discussion.')
  return request
}
