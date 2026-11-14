/** A finite PMO request; creation source is separate from execution or dispatch. */
export type GoalPmoIntent = { goalId: string; creationOperationId?: string; inputEpoch?: string }
export type GoalPmoReceipt = { route: 'discussion'; tabId: string; agentSessionId: string | null }
  | { route: 'supervisor'; agentSessionId: string; hostId: string | null; requestOperationId: string }

export async function goalPmoOperation(intent: GoalPmoIntent, kind: 'create' | 'discussion' | 'discussion-create'): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([kind, intent.goalId, intent.creationOperationId])))
  // A later explicit discussion uses the same Core business-source entry, but
  // can never attest the original Goal creation, even with the same request ID.
  return `goal_pmo_${kind === 'discussion-create' ? 'create' : kind}_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
export function assertGoalPmoIntent(value: GoalPmoIntent): void {
  if (!value || Object.keys(value).some(key => !['goalId', 'creationOperationId', 'inputEpoch'].includes(key)) ||
    typeof value.goalId !== 'string' || !value.goalId.trim() || /[\0\r\n]/u.test(value.goalId) ||
    value.creationOperationId !== undefined && (typeof value.creationOperationId !== 'string' || !value.creationOperationId.trim() || /[\0\r\n]/u.test(value.creationOperationId)) ||
    value.inputEpoch !== undefined && (typeof value.inputEpoch !== 'string' || !value.inputEpoch.trim() || new TextEncoder().encode(value.inputEpoch).byteLength > 512 || /[\0\r\n]/u.test(value.inputEpoch)))
    throw new Error('The original PMO Goal reference is unconfirmed. Keep the Goal and original request.')
}
