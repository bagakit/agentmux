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
  // 这条文案两次点名了「在该状态下根本执行不了的动作」，两次都由审计抓出来，所以判据写在这里：
  // **只准点名从这个状态真能走通的动作**，而不是在源码里读着像能走通的那条。
  //   第一版说「resume」——resumeAgentRun 对 running 的 Run 直接抛 AGENT_SESSION_STILL_RUNNING
  //     （client.ts:1866-1868），而且 Resume 按钮在这个状态压根不渲染（SessionPane.tsx:254 要求
  //     disconnected || missing || exited）。
  //   第二版说「先 stop 再 resume」——更糟，因为它读起来可行：stopAgent 走
  //     commitLifecycle(reservation, null)，store 那一侧是 sessions.delete（agent-session-store.ts:1475）
  //     并记一条 retirement；此后 ensureAgentContinuity 判成 'retired'（agent-session-continuity.ts:139），
  //     resumeAgentRun 根本不会被调用，renderer 直接把这一格摘掉（store.ts:4491）。也就是说 stop 之后
  //     没有「resume」这个东西，只有新开一个 Agent。
  // 所以这一版不再许诺任何一条恢复链，只说两件**确定为真**的事：什么条件下它会自己好，以及
  // stop 的真实代价。宁可告诉用户「这里没有便宜的出路」，也不要给一条走到一半才发现是死的路。
  AGENT_PROMPT_READINESS_CONSUMED:
    'The prompt was not sent because the current composer readiness epoch was already consumed by another submission. The Agent Run is still running; if another delivery is in flight this clears after the next readiness epoch, but if the turn ended without a Stop signal no new epoch is coming — stopping this Agent retires the session rather than reviving it, so recovering that way means starting a new Agent and losing this one’s continuity.',
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
    // 这四句都只在 **Run 仍 running** 时出现（runtime-controller.ts:815-819：`runState='ended'`
    // 走的是上面那条 `if`，semanticState 只在它的 `else` 里赋值）。于是和 CONSUMED 那条同理，
    // 它们一样不准点名 resume/restart——对 running 的 Run，resumeAgentRun 直接抛
    // AGENT_SESSION_STILL_RUNNING（client.ts:1866-1868），Resume 按钮也只在
    // disconnected/missing/exited 时渲染（SessionPane.tsx:254）。blocked/error 两条原先各带一个
    // "or resume it"，是同一个缺陷的第四、第五例，被 CONSUMED 那条的禁止清单式守卫整整放过。
    const semanticMessage = options.semanticState === 'done'
      ? 'The Agent turn is complete, but composer readiness has not been verified yet; keep the draft and retry when the readiness check finishes.'
      : options.semanticState === 'waiting'
        ? 'The Agent is waiting for your reply, but composer readiness has not been verified yet; keep the draft and retry after the readiness check.'
        : options.semanticState === 'blocked'
          ? 'The Agent is blocked and its composer readiness has not been verified yet; clear what it is blocked on in its terminal, then send again.'
          : 'The Agent reported an error but its Run is still alive; read its latest output to see what failed, then send again once readiness is observed.'
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
