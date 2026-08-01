import { AgentMuxError } from '@agentmux/core'

// A render-then-submit Provider (codex) applies a prompt only against a ready composer epoch, which exists
// between turns — never mid-generation. Core keeps that gate fail-closed and emits four distinct refusal
// codes. Electron's ipcRenderer.invoke strips custom Error fields, so this is the one boundary where the
// stable code becomes an actionable human message. Keep the detail untouched for logs and append it to the
// message so the renderer still receives the non-sensitive Run/epoch/submission facts after IPC framing.
export type PromptReadinessErrorCode =
  | 'AGENT_PROMPT_NOT_READY'
  | 'AGENT_PROMPT_READINESS_CONSUMED'
  | 'AGENT_PROMPT_SUBMISSION_BUSY'
  | 'AGENT_PROMPT_READINESS_CONFLICT'

const PROMPT_READINESS_MESSAGES: Readonly<Record<PromptReadinessErrorCode, string>> = {
  AGENT_PROMPT_NOT_READY:
    'The prompt was not sent because this Run has no consumable composer readiness yet. The Agent Run is still running; wait for the Stop/screen readiness observation to finish, then send again. If it stays not ready, check the Provider readiness marker or Hook ingress.',
  AGENT_PROMPT_READINESS_CONSUMED:
    'The prompt was not sent because the current composer readiness epoch was already consumed by another submission. The Agent Run is still running; wait for that delivery to finish and send a new message after the next readiness epoch. Do not resend the same operation.',
  AGENT_PROMPT_SUBMISSION_BUSY:
    'The prompt was not sent because another submission for this Run is still completing. The Agent Run is still running; keep this draft and wait for the existing delivery acknowledgement before trying again.',
  AGENT_PROMPT_READINESS_CONFLICT:
    'The prompt was not sent because Session readiness changed while the submission was committing. The previous Run status is no longer authoritative; refresh the canonical Session and retry only with its current Run. Do not write directly to the PTY.'
}

export function humanizePromptDeliveryError(error: unknown): unknown {
  if (!(error instanceof AgentMuxError)) return error
  const message = PROMPT_READINESS_MESSAGES[error.code as PromptReadinessErrorCode]
  if (!message) return error
  const diagnostic = error.detail?.trim()
  return new AgentMuxError(
    diagnostic ? `${message} Diagnostic: ${diagnostic}` : message,
    error.code,
    error.detail
  )
}
