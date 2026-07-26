import { AgentMuxError } from './errors.js'

/**
 * 握手探测失败之后怎么办——判定层（AGENTS.md 原则 11 在 Core 侧的落点）。
 *
 * `ensureTerminalHandshake` 今天的四个调用点全部 fatal，其中 client.ts 的 connect 循环最狠：
 * 任何一个 session 探测超时，外层 catch 就 `kernel.disconnect()` 并 rethrow——**一条慢探测拆掉
 * 整条连接，所有健康的 Agent 陪葬**。这正是原则禁止的「我们的流程坏了，却让能干活的 Agent 受阻」。
 *
 * 但「别 throw」不能一刀切：同样从握手里抛出来的错误，有的说明 Agent 真没了（run 已退出），
 * 有的说明数据坏了（受据不匹配、状态非法），只有超时才是「Agent 好好的，是我们没等到」。
 * 把三者折叠成一种处置，就是把第 1 类当第 2 类放行（骗用户 Agent 还在）或把第 2 类当第 1 类中止
 * （杀掉健康 Agent）——两个方向都违例。所以分流写成纯函数放在这里，让每一条都能被直接断言，
 * 而不是散在 client.ts 四个 catch 里各写一遍、各漏一点。
 */

/**
 * 探测超时。Agent 还在跑，只是我们没等到它的能力查询——第 2 类：放行 + 告示。
 *
 * `[?u` 是 codex 启动时的一次性输出，对一个几分钟前启动的 run 早已不可达，重连时只能靠 replay
 * 扫到；一旦滚出保留区就再也不会重来。所以这里「等更久」是错误的杠杆，正确行为是立刻降级。
 */
export const AGENT_TERMINAL_HANDSHAKE_TIMEOUT = 'AGENT_TERMINAL_HANDSHAKE_TIMEOUT'

/**
 * run 在被观察到能力查询之前就退出了。Agent 真的没了——第 1 类：中止是诚实的。
 *
 * 这一条**必须**与超时分开：它不是「我们没等到」，是「没有东西可等了」。放行它等于让上层以为
 * 还有一个能干活的 Agent。
 */
export const AGENT_TERMINAL_HANDSHAKE_FAILED = 'AGENT_TERMINAL_HANDSHAKE_FAILED'

/**
 * The capability probe was degradable, but recording that fact in the Session Store failed.  This
 * is deliberately a diagnostic code rather than a Run/Agent failure: the live Agent can continue to
 * accept input, while the caller must know that the warning will not survive a restart.
 */
export const AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED = 'AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED'

/**
 * 一次握手失败的处置。
 *
 * `degrade` 只由超时产生，且必须带上从 daemon 读到的输入游标：降级之后我们没有写 `[?0u`，
 * 但后续 prompt 仍要有正确的栅栏起点，靠的就是 daemon 自己的 `run.acceptedInputBytes`
 * （与无握手 provider 走的是同一条兜底）。`abort` 表示这个错误必须原样抛出。
 */
export type AgentTerminalHandshakeOutcome =
  | { kind: 'degrade'; code: typeof AGENT_TERMINAL_HANDSHAKE_TIMEOUT; reason: 'capability-query-timeout' }
  | { kind: 'abort' }

/**
 * 把握手抛出的错误分成「降级」与「中止」。
 *
 * 只有超时降级。run 退出（第 1 类）、状态非法、受据不匹配（数据损坏，不是慢探测）、以及任何
 * 非 AgentMuxError 的意外，一律中止——**默认是中止**，因为把一个不认识的错误当成「大概能接着
 * 跑吧」正是原则第二条边界禁止的「把未知当成好的」。新增一个错误码时它自动落在 abort 这边，
 * 要放行必须显式加进来，而不是反过来。
 */
export function classifyTerminalHandshakeFailure(error: unknown): AgentTerminalHandshakeOutcome {
  if (error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_TIMEOUT) {
    return { kind: 'degrade', code: AGENT_TERMINAL_HANDSHAKE_TIMEOUT, reason: 'capability-query-timeout' }
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
