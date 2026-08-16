import { AgentMuxError } from '@agentmux/core'

// Translate real transaction conflicts at the IPC boundary, where custom Error fields
// are stripped. Readiness observations no longer refuse healthy prompt submission.
export type PromptReadinessErrorCode = 'AGENT_PROMPT_SUBMISSION_BUSY' | 'AGENT_PROMPT_READINESS_CONFLICT'
export type PromptReadinessRunState = 'running' | 'ended'

const MESSAGES: Readonly<Record<PromptReadinessErrorCode, string>> = {
  AGENT_PROMPT_SUBMISSION_BUSY: 'Another message is still being delivered. Your message has not been sent; retry after that delivery completes.',
  AGENT_PROMPT_READINESS_CONFLICT: 'The Session changed during delivery. Your message has not been sent; refresh the Session before retrying.'
}

export function humanizePromptDeliveryError(error: unknown, options: { runState?: PromptReadinessRunState } = {}): unknown {
  if (!(error instanceof AgentMuxError)) return error
  const known = MESSAGES[error.code as PromptReadinessErrorCode]
  if (!known) return error
  const message = options.runState === 'ended'
    ? 'The Agent Run has ended. Your message has not been sent; resume the Agent before retrying.'
    : known
  const diagnostic = error.detail?.trim()
  return new AgentMuxError(diagnostic ? `${message} Diagnostic: ${diagnostic}` : message, error.code, error.detail)
}
