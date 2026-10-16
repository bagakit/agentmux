import { AgentMuxError } from './errors.js'
import { stripVTControlCharacters } from 'node:util'
import type { CtxmuxAdapterRun } from './ctxmux-run-adapter.js'

/** Auxiliary terminal observation never proves that an otherwise healthy Run is unusable.
 * Timeout and a retained reply's changed input boundary have explicit degraded outcomes.
 * Other errors still reject that exact probe.
 */
export const AGENT_TERMINAL_HANDSHAKE_TIMEOUT = 'AGENT_TERMINAL_HANDSHAKE_TIMEOUT'

/** The original optional reply has no confirmed receipt at its retained input boundary. */
export const AGENT_TERMINAL_HANDSHAKE_UNCONFIRMED = 'AGENT_TERMINAL_HANDSHAKE_UNCONFIRMED'

/**
 * run 在被观察到能力查询之前就退出了。Agent 真的没了——第 1 类：中止是诚实的。
 *
 * 这一条**必须**与超时分开：它不是「我们没等到」，是「没有东西可等了」。放行它等于让上层以为
 * 还有一个能干活的 Agent。
 */
export const AGENT_TERMINAL_HANDSHAKE_FAILED = 'AGENT_TERMINAL_HANDSHAKE_FAILED'

/** An exited Run's bounded startup output, carried in message because IPC drops custom fields. */
export function terminalHandshakeExitError(run: CtxmuxAdapterRun, output: string): AgentMuxError {
  // Node's stripper leaves OSC payloads containing spaces; remove those complete non-text
  // control strings before using the standard stripper for the remaining VT sequences.
  const text = stripVTControlCharacters(output.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
    .trim().slice(-4096)
  const state = run.state
  const reason = state.type === 'exited'
    ? `exit code ${state.code ?? 'unknown'}${state.signal ? `, signal ${state.signal}` : ''}`
    : state.type
  return new AgentMuxError(
    `Agent Run exited before its terminal capability query was observed (${reason}). ${
      text ? `Startup output:\n${text}` : 'No startup output was observed.'
    }`,
    AGENT_TERMINAL_HANDSHAKE_FAILED
  )
}

/**
 * The capability probe was degradable, but recording that fact in the Session Store failed.  This
 * is deliberately a diagnostic code rather than a Run/Agent failure: the live Agent can continue to
 * accept input, while the caller must know that the warning will not survive a restart.
 */
export const AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED = 'AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED'

/** A degraded observation still requires fresh exact-Run status and its authoritative input cursor. */
export type AgentTerminalHandshakeOutcome =
  | { kind: 'degrade'; code: typeof AGENT_TERMINAL_HANDSHAKE_TIMEOUT; reason: 'capability-query-timeout' }
  | { kind: 'degrade'; code: typeof AGENT_TERMINAL_HANDSHAKE_UNCONFIRMED; reason: 'handshake-unconfirmed' }
  | { kind: 'abort' }

/** Classify protocol error codes, never display text or cumulative input as an old receipt. */
export function classifyTerminalHandshakeFailure(error: unknown): AgentTerminalHandshakeOutcome {
  if (error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_TIMEOUT) {
    return { kind: 'degrade', code: AGENT_TERMINAL_HANDSHAKE_TIMEOUT, reason: 'capability-query-timeout' }
  }
  if (error instanceof AgentMuxError && [AGENT_TERMINAL_HANDSHAKE_UNCONFIRMED, 'CTXMUX_input_cursor_mismatch'].includes(error.code)) {
    return { kind: 'degrade', code: AGENT_TERMINAL_HANDSHAKE_UNCONFIRMED, reason: 'handshake-unconfirmed' }
  }
  return { kind: 'abort' }
}

/**
 * 降级时该把输入游标设成什么。
 *
 * 照抄无握手分支的做法：daemon 的 `run.acceptedInputBytes` 是权威游标。取不到（null/undefined）
 * 就返回 undefined——**不猜 0**。猜 0 会让首条 prompt 带着一个错误的 `expectedByte` 去撞栅栏，
 * 要么被拒，要么写到错误的位置；如实不设，让 prompt 路径自己去问 daemon（那条兜底本来就在）。
 */
export function degradedInputCursor(acceptedInputBytes: number | null | undefined): number | undefined {
  // typeof 先收窄类型，再验值域。`Number.isSafeInteger` 单独用不收窄（签名是 value: unknown），
  // 于是 `>= 0` 那一侧仍带着 null/undefined，编译不过——但值域检查本身是对的，保留：负数或非整数
  // 的游标只可能来自坏数据，拿它当栅栏起点比不设更糟。
  if (typeof acceptedInputBytes !== 'number') return undefined
  return Number.isSafeInteger(acceptedInputBytes) && acceptedInputBytes >= 0 ? acceptedInputBytes : undefined
}
