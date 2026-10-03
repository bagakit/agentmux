import type { AgentMuxPendingInteraction } from './types.js'

/** Explain why an observed request cannot currently be answered through typed terminal input. */
export function agentInteractionResponseUnavailableReason(pending: AgentMuxPendingInteraction): string | undefined {
  if (pending.response?.acknowledged) return pending.nativeCompleted
    ? 'The typed response was acknowledged and this native request completed; settlement is pending.'
    : 'The typed response was acknowledged. Waiting for the exact native request to complete; input will not be resent.'
  if (pending.nativeInput) return pending.nativeInput.delivery === 'accepted'
    ? 'Native input was accepted. Whether this request is still pending is unconfirmed.'
    : 'Native input delivery is unknown. Check the terminal before answering; input will not be resent.'
  if (pending.nativeCompleted) return 'This native request has ended. Its earlier typed response has not been settled.'
  if (pending.additionalRequests?.length) return 'More than one native request is outstanding. Use the terminal until the current request is confirmed.'
  if (pending.response) return 'The original typed response receipt is unconfirmed. Reconcile its exact response; automatic input is paused.'
  return pending.request.kind === 'question' ? pending.request.responseUnavailableReason : undefined
}

/** The native Hook owner has correlated this completion to the active invocation. */
export function agentInteractionResponseSettled(pending: AgentMuxPendingInteraction): boolean {
  return pending.response?.acknowledged === true && pending.nativeCompleted?.source === 'native-hook' &&
    pending.request.evidence.source === 'native-hook' && Boolean(pending.request.nativeToolCallId) &&
    pending.nativeCompleted.run?.runId === pending.request.evidence.run?.runId
}
