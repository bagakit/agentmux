/** A finite PMO request; creation source is separate from execution or dispatch. */
export type GoalPmoIntent = { goalId: string; creationOperationId?: string }
export type GoalPmoReceipt = { tabId: string; agentSessionId: string | null }

export async function goalPmoOperation(intent: GoalPmoIntent, kind: 'create' | 'discussion'): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([kind, intent.goalId, intent.creationOperationId])))
  return `goal_pmo_${kind}_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
export function assertGoalPmoIntent(value: GoalPmoIntent): void {
  if (!value || Object.keys(value).some(key => key !== 'goalId' && key !== 'creationOperationId') ||
    typeof value.goalId !== 'string' || !value.goalId.trim() || /[\0\r\n]/u.test(value.goalId) ||
    value.creationOperationId !== undefined && (typeof value.creationOperationId !== 'string' || !value.creationOperationId.trim() || /[\0\r\n]/u.test(value.creationOperationId)))
    throw new Error('The original PMO Goal reference is unconfirmed. Keep the Goal and original request.')
}
