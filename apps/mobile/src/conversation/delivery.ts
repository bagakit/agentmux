/** Only explicit Core rejection facts can unlock a write after its RPC was dispatched. */
export function deliveryOutcome(error: unknown, operation: 'prompt' | 'interaction'): 'rejected' | 'unknown' {
  if (!error || typeof error !== 'object') return 'unknown'
  const { code, detail } = error as { code?: unknown; detail?: unknown }
  if (detail === 'unknown') return 'unknown'
  // A Prompt can have an accepted payload and a rejected submit phase. A phase-level
  // Native rejection alone does not permit sending the complete Prompt again.
  if (detail === 'not_applied' && operation === 'interaction') return 'rejected'
  // These validations occur before Provider input. STALE_AGENT_SESSION also occurs after
  // admission during receipt settlement. AGENT_INTERACTION_PENDING can appear between
  // payload and submit too; neither proves that the whole Prompt was unapplied.
  const beforeInput = operation === 'prompt'
    ? ['INVALID_AGENT_PROMPT', 'AGENT_PROMPT_CANCELLED', 'AGENT_PROMPT_SUBMISSION_BUSY']
    : ['UNKNOWN_AGENT_INTERACTION', 'INVALID_AGENT_INTERACTION_RESPONSE', 'AGENT_INTERACTION_UNSUPPORTED']
  return typeof code === 'string' && [
    ...beforeInput, 'INVALID_CONTROL_REQUEST',
    'CONTROL_UNAUTHORIZED', 'CONTROL_FORBIDDEN'
  ].includes(code) ? 'rejected' : 'unknown'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
