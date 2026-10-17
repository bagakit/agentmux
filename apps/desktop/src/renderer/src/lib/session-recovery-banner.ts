import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'

/** A live Run and its terminal frontend have distinct, source-owned lifetimes. */
export function sessionFrontendPresentation(session: SessionSnapshot | undefined): { kind: 'detached' | 'unknown'; phase?: 'failed'; title: string; detail: string; diagnostic?: string } | null {
  if (session?.kind !== 'agent' || session.processState !== 'running') return null
  const frontend = session.terminalFrontend
  if (!frontend || frontend.run.runId !== session.control.run.runId) return null
  if (frontend.state === 'detached' && typeof frontend.exitCode === 'number' && frontend.exitCode !== 0) return {
    kind: 'detached', phase: 'failed', title: 'Terminal process exited',
    detail: `The terminal process exited with code ${frontend.exitCode}. ${frontend.backendState === 'running'
      ? 'The backend is still running.' : frontend.backendState === 'stopping'
        ? 'The backend is finishing its shutdown.' : frontend.backendState === 'exited'
          ? 'The backend is also reported exited.' : 'The backend state is unconfirmed.'}${session.nativeHandle?.kind === 'provider'
      ? '' : ' The native conversation identity is not yet confirmed.'} Your Session, draft and available input are kept. Check the CLI startup environment, then choose Resume or restart AgentMux.`,
    diagnostic: frontend.message?.trim() || 'The terminal process did not report a diagnostic. The cause is unknown; read the original output for details.'
  }
  if (frontend.state === 'detached') return {
    kind: 'detached',
    title: 'Terminal disconnected',
    detail: frontend.backendState === 'running'
      ? 'The backend is still running. Resume reconnects this terminal to the same conversation.'
      : frontend.backendState === 'stopping'
        ? 'The backend is finishing its shutdown. Resume checks the original Session and its recovery.'
        : frontend.backendState === 'exited'
          ? 'The backend process ended. Resume checks recovery of the original conversation.'
          : 'The terminal exited. The backend state is not yet confirmed; Resume checks the original Session.'
  }
  if (frontend.state === 'unknown') return {
    kind: 'unknown',
    title: 'Terminal connection unconfirmed',
    detail: 'The frontend observation could not be confirmed. Refresh checks this original Session without restarting it or resending input.'
  }
  return null
}

/** A later restore refusal cannot replace the exact Run's confirmed exit facts. */
export function sessionExitPresentation(session: Pick<SessionSnapshot, 'kind' | 'processState' | 'status'>): { title: string; detail: string } | null {
  if (session.processState !== 'exited') return null
  const reason = session.status.exitReason
  const detail = reason === 'user-stopped' ? 'You stopped this session.'
    : reason === 'crashed' ? 'The process exited on its own.'
      : 'The process is no longer running; the reason could not be determined.'
  return {
    title: `${session.kind === 'agent' ? 'Agent' : 'Terminal'} process exited`,
    detail: detail + (session.status.exitCode === undefined ? '' : ` Exit code ${session.status.exitCode}.`)
  }
}

/**
 * 恢复横幅代表的是哪个状态。
 *
 * 只有一处判定，因为这个取值要同时决定两件事：横幅自己的修饰类（`terminal-recovery--<state>`，
 * 决定版式）与状态语汇的赋值类（`status--<state>`，决定颜色）。分两处各算一次必然漂移，而漂移的
 * 症状是"版式说掉线、颜色说崩了"——两个都对得上自己那半边，合起来在说两件事。
 *
 * 返回值刻意收在 {@link AgentDisplayState} 里：颜色必须来自 chrome.css 那张唯一的状态色表
 * （`--status-ink`），而那张表的键就是这个联合类型。取一个不在联合里的名字，就等于又铸了一份
 * 状态色表——这正是横幅此前的形状：它把 `disconnected` 写死成 `var(--amber)`，而色表明确判它是
 * `--text-3`，并在注释里写明"琥珀只表示等你"。于是一条掉线的链路被画成了"你是瓶颈"。
 *
 * 进程投影明确报错才使用 error；结束是中性生命周期事实，其余不可用按断开呈现。
 */
export function sessionRecoveryState(input: {
  disconnected: boolean
  exited: boolean
  failed: boolean
}): AgentDisplayState {
  if (input.failed) return 'error'
  if (input.disconnected) return 'disconnected'
  if (input.exited) return 'exited'
  return 'disconnected'
}

/**
 * 横幅根元素的 class。
 *
 * 两个类一起返回，是为了让"版式类与颜色类同源"成为结构事实而不是靠人盯。
 *
 * 只带 `status--<state>` 而**不带 `.status` 本体**：`.status` 是给状态点那种行内小构件用的
 * （`display:inline-flex` + `capitalize`），套到横幅上会掀翻它的 grid 版式并把正文措辞大写化。
 * 需要的只是 `--status-ink` 那一次赋值，而赋值全在 `.status--<state>` 这一族上。
 */
export function sessionRecoveryClassName(state: AgentDisplayState): string {
  return `terminal-recovery terminal-recovery--${state} status--${state}`
}
