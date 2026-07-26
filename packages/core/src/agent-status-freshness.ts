import type { AgentSemanticState, AgentStatus } from './types.js'

/**
 * 语义状态的新鲜度判定：给定最后一次观察时刻与现在，这个状态还算不算数。
 *
 * 拎成纯函数，是因为要害不在渲染而在**判定**——「一个 `working` 转了很久还该不该信」这件事必须
 * 能被直接断言，而不是埋在一个定时器回调里没人够得着。client 的定时器只负责「到点了」，「到点该
 * 不该衰减」全在这里。
 */

/**
 * 只有 `working` 会衰减。
 *
 * `working` 是「此刻正在干活」的**易失声明**：真正在干活的 Agent 会不断吐 hook 回执（每次工具调用
 * 一对 Pre/Post）把它刷新，于是**持续的静默恰好证伪它**——要么 Agent 崩了、要么 hook 中继被杀、
 * 要么超时没发出 Stop。
 *
 * 其余状态都不该被静默证伪，删它们反而是撒谎：
 * - `waiting`/`blocked` 是「我停下了、在等你」的**静止声明**，静默与它相容，不构成证伪；它们还驱动
 *   界面的「需要你」提醒，衰减掉等于把一个真实、可操作的信号悄悄抹了。
 * - `done`/`error` 是**结论**，删掉就是抹掉真实发生过的结果。
 * - `starting`/`running`/`disconnected`/`exited` 本就不是「在干活」的声明，无所谓衰减。
 *
 * 不导出：唯二的判定入口（{@link semanticStatusStale} / {@link msUntilSemanticStatusStale}）在本文件
 * 内用它，产品侧只经那两个入口，不该自己再判一遍「哪种状态会衰减」。
 */
function semanticStatusCanDecay(state: AgentStatus['state']): boolean {
  return state === 'working'
}

/**
 * 衰减阈值：`working` 无新证据多久之后不再算数。
 *
 * 定值的理由不是拍脑袋，而是「`working` 靠什么刷新」：唯一的刷新源是 hook 事件，全仓没有心跳
 * （grep 过 heartbeat/keepalive/ping/setInterval，core 侧一个都没有；终端字节按设计**不作**语义活动
 * 证据，见 types.ts 的 AgentMuxEvidenceSource 注释）。于是真正在干活的 Agent 的最长静默 = 一次工具
 * 调用的最长耗时——一条跑满的测试套件或一次构建，执行期间不产出任何 hook 事件（Pre 在工具开始时落，
 * Post 要等它结束），几分钟很常见。阈值必须**明确高过**这个上界，否则会把一个正跑长命令的健康 Agent
 * 误降级（这比慢一点更糟，见 AGENTS.md 原则 11：绝不许我们的流程挤掉健康 Agent）。取 15 分钟：稳稳
 * 盖过一次长构建/长测试，又把「永远转的圈」收敛成「最多在最后一次真实活动后 15 分钟」。
 *
 * 不导出：它只是下面两个函数据以判定的内部阈值，产品侧从不直接读它——按 SSOT/零调用者原则，没有
 * 产品调用方的符号不外露。
 */
const SEMANTIC_STATUS_STALE_AFTER_MS = 15 * 60_000

/**
 * 衰减的落点：中性的「不知道」。
 *
 * 不是 `done`（那是谎称它干完了），不是 `error`（那是谎称它崩了）——我们确实**不知道**它现在怎么样。
 * `unknown` 经 renderer 归一为 `running`（进程还在、但此刻没有在干活的声明），转的圈就此停下，
 * 而不伪造任何我们没观察到的结论。
 */
export const DECAYED_SEMANTIC_STATE: AgentSemanticState = 'unknown'

/**
 * 距离这个状态变陈旧还有多少毫秒；已经陈旧或不可衰减则为 0。
 *
 * client 用它算定时器的延时：`working` 刚落地就排一个满额 TTL 的定时器，一条比 TTL 更早到达的新证据
 * 会重排，于是活着的 Agent 永远被刷新、够不到衰减。
 */
export function msUntilSemanticStatusStale(
  status: Pick<AgentStatus, 'state' | 'observedAt'>,
  now: number
): number {
  if (!semanticStatusCanDecay(status.state)) return 0
  return Math.max(0, status.observedAt + SEMANTIC_STATUS_STALE_AFTER_MS - now)
}

/**
 * 这个状态现在还算不算数——`false` 表示应当衰减为「不知道」。
 *
 * 只有可衰减且静默已超过阈值时才判 stale。注意用 `>=`：正好到点即算陈旧，避免定时器因取整刚好落在
 * 阈值线上时反复空转。
 */
export function semanticStatusStale(
  status: Pick<AgentStatus, 'state' | 'observedAt'>,
  now: number
): boolean {
  return semanticStatusCanDecay(status.state) && now - status.observedAt >= SEMANTIC_STATUS_STALE_AFTER_MS
}
