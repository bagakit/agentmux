import { describeError } from '@agentmux/client-ui/error-presentation'
/** Only explicit Core rejection facts can unlock a write after its RPC was dispatched. */
export function deliveryOutcome(error: unknown, operation: 'prompt' | 'interaction'): 'rejected' | 'unknown' {
  if (!error || typeof error !== 'object') return 'unknown'
  const { code, detail, controlFailure } = error as { code?: unknown; detail?: unknown; controlFailure?: { disposition?: unknown; confirmedInputBytes?: unknown } }
  if (detail === 'unknown') return 'unknown'
  // defineAgentProvider rejects an unsupported immediate plan before any input.
  // A transported unknown/partial-input fact takes precedence over that typed boundary.
  if (operation === 'prompt' && code === 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED') {
    return controlFailure === undefined || (controlFailure?.disposition === 'not_applied'
      && controlFailure.confirmedInputBytes === 0) ? 'rejected' : 'unknown'
  }
  // This specific Core boundary is read-only preparation before any input in this call.
  // Mobile dispatches a fresh operation once; it never uses this fact to replay an older unknown operation.
  if (operation === 'prompt' && code === 'AGENT_PROMPT_PREPARATION_FAILED'
    && controlFailure?.disposition === 'not_applied' && controlFailure.confirmedInputBytes === 0) return 'rejected'
  // A Prompt can have an accepted payload and a rejected submit phase. A phase-level
  // Native rejection alone does not permit sending the complete Prompt again.
  if (detail === 'not_applied' && operation === 'interaction') return 'rejected'
  // These validations occur before Provider input. STALE_AGENT_SESSION also occurs after
  // admission during receipt settlement. AGENT_INTERACTION_PENDING can appear between
  // payload and submit too; neither proves that the whole Prompt was unapplied.
  const beforeInput = operation === 'prompt'
    ? ['INVALID_AGENT_PROMPT', 'AGENT_PROMPT_CANCELLED', 'AGENT_PROMPT_SUBMISSION_BUSY', 'AGENT_TURN_END_UNCONFIRMED']
    : ['UNKNOWN_AGENT_INTERACTION', 'INVALID_AGENT_INTERACTION_RESPONSE', 'AGENT_INTERACTION_UNSUPPORTED']
  return typeof code === 'string' && [
    ...beforeInput, 'INVALID_CONTROL_REQUEST',
    'CONTROL_UNAUTHORIZED', 'CONTROL_FORBIDDEN'
  ].includes(code) ? 'rejected' : 'unknown'
}

export function errorMessage(error: unknown): string {
  const value = describeError(error)
  return `${value.message}${value.code ? ` [${value.code}]` : ''}${value.detail ? `\n${value.detail}` : ''}`
}
