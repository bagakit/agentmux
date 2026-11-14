import type { AgentMuxInteractionOperationReceipt } from '@agentmux/core'

/** Presentation of a receipt already matched to the original operation by its consumer. */
export function interactionReceiptPhase(receipt: AgentMuxInteractionOperationReceipt | null | undefined) {
  if (!receipt || receipt.delivery === 'unknown') return 'unknown'
  if (receipt.delivery === 'saved') return 'saved'
  return receipt.nativeCompleted?.source === 'native-hook' && receipt.nativeCompleted.run?.runId === receipt.run.runId
    ? 'completed' : 'submitted'
}
