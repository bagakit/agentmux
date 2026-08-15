import { AgentMuxError } from '@agentmux/core'
import type { AgentDisplayState } from '@agentmux/core'

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

export type PromptReadinessRunState = 'running' | 'ended'
// Only these semantic outcomes alter the readiness wording. `working` keeps the original
// fail-closed guidance, while lifecycle/process states are not semantic evidence at all.
export type PromptReadinessSemanticState = 'waiting' | 'blocked' | 'done' | 'error'

// Which `AgentDisplayState`s carry readiness-wording evidence, as a TOTAL map over the union — so a new
// state must be classified here rather than silently falling through an inline literal list. This is the
// SSOT for the membership; `isPromptReadinessSemanticState` reads it instead of any caller re-deriving
// `state === 'waiting' || state === 'blocked' || …`.
const PROMPT_READINESS_SEMANTIC_STATES: Readonly<Record<AgentDisplayState, boolean>> = {
  waiting: true,
  blocked: true,
  done: true,
  error: true,
  working: false,
  starting: false,
  running: false,
  exited: false,
  disconnected: false
}

export function isPromptReadinessSemanticState(
  state: AgentDisplayState
): state is PromptReadinessSemanticState {
  return PROMPT_READINESS_SEMANTIC_STATES[state]
}

const PROMPT_READINESS_MESSAGES: Readonly<Record<PromptReadinessErrorCode, string>> = {
  AGENT_PROMPT_NOT_READY:
    'The prompt was not sent because this Run has no consumable composer readiness yet. The Agent Run is still running; wait for the Stop/screen readiness observation to finish, then send again. If it stays not ready, check the Provider readiness marker or Hook ingress.',
  AGENT_PROMPT_READINESS_CONSUMED:
    'The prompt was not sent because the current composer readiness epoch was already consumed by another submission. The Agent Run is still running; if another delivery is in flight this clears after the next readiness epoch, but if the turn ended without a Stop signal no new epoch is coming — resume or restart the Agent if it does not clear.',
  AGENT_PROMPT_SUBMISSION_BUSY:
    'The prompt was not sent because another submission for this Run is still completing. The Agent Run is still running; keep this draft and wait for the existing delivery acknowledgement before trying again.',
  AGENT_PROMPT_READINESS_CONFLICT:
    'The prompt was not sent because Session readiness changed while the submission was committing. The previous Run status is no longer authoritative; refresh the canonical Session and retry only with its current Run. Do not write directly to the PTY.'
}

export function humanizePromptDeliveryError(
  error: unknown,
  options: {
    runState?: PromptReadinessRunState
    semanticState?: PromptReadinessSemanticState
  } = {}
): unknown {
  if (!(error instanceof AgentMuxError)) return error
  let message = PROMPT_READINESS_MESSAGES[error.code as PromptReadinessErrorCode]
  if (!message) return error
  if (options.runState === 'ended') {
    message = message
      .replace(/The Agent Run is still running;[^.]*\./, 'The Agent Run has ended; resume or restart it before sending again.')
      .replace(/The previous Run status is no longer authoritative; refresh the canonical Session and retry only with its current Run\./, 'The Run has ended; resume or restart the Agent, then retry with its new Run.')
  } else if (options.semanticState) {
    const semanticMessage = options.semanticState === 'done'
      ? 'The Agent turn is complete, but composer readiness has not been verified yet; keep the draft and retry when the readiness check finishes.'
      : options.semanticState === 'waiting'
        ? 'The Agent is waiting for your reply, but composer readiness has not been verified yet; keep the draft and retry after the readiness check.'
        : options.semanticState === 'blocked'
          ? 'The Agent is blocked and its composer readiness has not been verified yet; resolve the blocker or resume it before sending again.'
          : 'The Agent reported an error; inspect or resume it before sending again.'
    message = message
      .replace(/The Agent Run is still running;[^.]*\./, semanticMessage)
      .replace(/The previous Run status is no longer authoritative; refresh the canonical Session and retry only with its current Run\./, semanticMessage)
  }
  const diagnostic = error.detail?.trim()
  return new AgentMuxError(
    diagnostic ? `${message} Diagnostic: ${diagnostic}` : message,
    error.code,
    error.detail
  )
}
