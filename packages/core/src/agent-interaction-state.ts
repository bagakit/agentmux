import type { AgentMuxInteractionRequest, AgentMuxPendingInteraction } from './types.js'

/** The original Hook owner correlated completion to this request's native invocation. */
function hasNativeCompletion(pending: AgentMuxPendingInteraction): boolean {
  return pending.nativeCompleted?.source === 'native-hook' &&
    pending.request.evidence.source === 'native-hook' && Boolean(pending.request.nativeToolCallId) &&
    Boolean(pending.request.evidence.run?.runId) &&
    pending.nativeCompleted.run?.runId === pending.request.evidence.run?.runId
}

/** Current unanswered request; an ended request may still retain its earlier response receipt. */
export function agentInteractionActiveRequest(pending: AgentMuxPendingInteraction | undefined): AgentMuxInteractionRequest | undefined {
  if (!pending) return undefined
  return hasNativeCompletion(pending) ? pending.additionalRequests?.[0] : pending.request
}

/** Explain why an observed request cannot currently be answered through typed terminal input. */
export function agentInteractionResponseUnavailableReason(pending: AgentMuxPendingInteraction): string | undefined {
  if (hasNativeCompletion(pending)) return pending.response?.acknowledged
    ? 'The original typed response was acknowledged and the original native request completed; settlement is pending.'
    : pending.response ? 'The original native request has ended. Its earlier typed response has not been settled.'
      : 'The original native request has ended.'
  if (pending.response?.acknowledged) return 'The typed response was acknowledged. Waiting for the exact native request to complete; input will not be resent.'
  if (pending.nativeInput) return pending.nativeInput.delivery === 'accepted'
    ? 'Native input was accepted. Whether this request is still pending is unconfirmed.'
    : 'Native input delivery is unknown. Check the terminal before answering; input will not be resent.'
  if (pending.additionalRequests?.length) return 'More than one native request is outstanding. Use the terminal until the current request is confirmed.'
  if (pending.response) return 'The original typed response receipt is unconfirmed. Reconcile its exact response; automatic input is paused.'
  return pending.request.kind === 'question' ? pending.request.responseUnavailableReason : undefined
}

/** The native Hook owner has correlated this completion to the active invocation. */
export function agentInteractionResponseSettled(pending: AgentMuxPendingInteraction): boolean {
  return pending.response?.acknowledged === true && hasNativeCompletion(pending)
}
