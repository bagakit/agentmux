import type { AgentMuxInteractionRequest, AgentMuxPendingInteraction } from './types.js'

/** Mutable dispatch observations never change the original request's semantic identity. */
export function agentInteractionRequestTarget(request: AgentMuxInteractionRequest): AgentMuxInteractionRequest {
  const { responseUnavailableReason: _reason, ...target } = request
  if (target.kind !== 'permission' || !target.permissionHook) return target
  const { response: _response, closed: _closed, nativeTurnEnded: _ended, ...hook } = target.permissionHook
  return { ...target, permissionHook: hook }
}

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
  const requests = [pending.request, ...(pending.additionalRequests ?? [])]
  const openHook = requests.find(request => request.kind === 'permission' && request.permissionHook &&
    !request.permissionHook.closed && !request.permissionHook.response && !request.permissionHook.nativeTurnEnded && !request.responseUnavailableReason)
  if (openHook) return openHook
  if (pending.request.kind === 'permission' && pending.request.permissionHook?.nativeTurnEnded) {
    return pending.additionalRequests?.find(request => request.kind !== 'permission' || !request.permissionHook?.nativeTurnEnded)
  }
  return hasNativeCompletion(pending) ? pending.additionalRequests?.find(request =>
    request.kind !== 'permission' || !request.permissionHook?.nativeTurnEnded) : pending.request
}

/** Explain the original request reply route; terminal presentation never grants a typed target. */
export function agentInteractionResponseUnavailableReason(pending: AgentMuxPendingInteraction): string | undefined {
  const request = agentInteractionActiveRequest(pending)
  if (!request) return undefined
  if (request.kind === 'permission' && request.permissionHook) {
    const hook = request.permissionHook
    if (hook.closed === 'abstained' && hook.response?.delivery === 'saved') return 'The choice was saved but was not dispatched. No permission decision was returned; continue in the original terminal.'
    if (hook.response?.value.decision.outcome === 'cancelled') return hook.response.delivery === 'connection-written'
      ? 'No permission decision was returned to the original Hook connection. Continue in the original terminal; no approval or denial is confirmed.'
      : 'The request to abstain is saved or its delivery is unknown. Continue in the original terminal; it will not be replayed.'
    if (hook.response) return hook.response.delivery === 'connection-written'
      ? 'The decision was returned to the original Hook connection. Native adoption and tool completion are not yet confirmed; it will not be resent.'
      : 'The original Hook decision is saved or its delivery is unknown; it will not be replayed on another callback.'
    if (hook.closed || request.responseUnavailableReason) return request.responseUnavailableReason ??
      'The original permission callback ended without a decision. Use the original terminal.'
    return undefined
  }
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
  return request.evidence.source === 'acp' ? request.responseUnavailableReason : request.responseUnavailableReason ??
    'This request has no addressable reply channel. Answer it in the original terminal.'
}

/** The native Hook owner has correlated this completion to the active invocation. */
export function agentInteractionResponseSettled(pending: AgentMuxPendingInteraction): boolean {
  return pending.response?.acknowledged === true && hasNativeCompletion(pending)
}
