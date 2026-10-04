import type { AgentMuxPendingInteraction } from './types.js'

/** Explain why an observed request cannot currently be answered through typed terminal input. */
export function agentInteractionResponseUnavailableReason(pending: AgentMuxPendingInteraction): string | undefined {
  if (pending.nativeInput) return pending.nativeInput.delivery === 'accepted'
    ? 'Native input was accepted. Whether this request is still pending is unconfirmed.'
    : 'Native input delivery is unknown. Check the terminal before answering; input will not be resent.'
  if (pending.nativeCompleted) return 'This native request has ended. Its earlier typed response has not been settled.'
  if (pending.additionalRequests?.length) return 'More than one native request is outstanding. Use the terminal until the current request is confirmed.'
  return pending.request.kind === 'question' ? pending.request.responseUnavailableReason : undefined
}
