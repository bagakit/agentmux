import type { AgentDisplayState, AgentMuxEvidenceSource, AgentSemanticState, AgentStatus } from './types.js'

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
 * 定值的理由不是拍脑袋，而是「`working` 靠什么刷新」：刷新只来自离散的活动事件——原生 hook 回执，或
 * ACP 提供方的 status 事件（见 client.ts 里 acp 回调把 status 落成 semanticStatus）。全仓没有心跳
 * （grep 过 heartbeat/keepalive/ping/setInterval，core 侧一个都没有；终端字节按设计**不作**语义活动
 * 证据，见 types.ts 的 AgentMuxEvidenceSource 注释）。于是真正在干活的 Agent 的最长静默 = 相邻两次
 * 活动事件的最大间隔——一条跑满的测试套件或一次构建，执行期间不产出任何事件（hook 的 Pre 在工具开始
 * 时落、Post 要等它结束；ACP 同理只在有可汇报的进展时才发 status），几分钟很常见。阈值必须**明确高过**
 * 这个上界，否则会把一个正跑长命令的健康 Agent 误降级（这比慢一点更糟，见 AGENTS.md 原则 11：绝不许
 * 我们的流程挤掉健康 Agent）。取 15 分钟：稳稳盖过一次长构建/长测试，又把「永远转的圈」收敛成「最多
 * 在最后一次真实活动后 15 分钟」。衰减落 `unknown`（诚实的不知道，不伪造 done/error），且下一条 observedAt
 * 更大的证据——无论来自 hook 还是 acp——会经 session-state 的门禁把它重新点亮，故对两种刷新源都自愈。
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
 * 语义态 → 显示态。**唯一一处**。
 *
 * 两个联合只差在两端：语义态独有 `unknown`（我们不知道），显示态独有 `starting` / `running` /
 * `disconnected` / `exited`（进程层面的事，不是活动声明）。重叠的五个（working/waiting/blocked/
 * done/error）原样通过——它们是同一件事的同一种说法，改名或改写任何一个都是撒谎。
 *
 * 只有 `unknown` 需要决定落点，落 `running`：进程还在，但此刻没有「在干活」的声明。
 *
 * **为什么必须是一处而不是三处 `state === 'unknown' ? 'running' : state`：**
 * 手抄那一行时 tsc 只守住「你没漏掉 unknown」（漏了就是 `AgentSemanticState` 赋给
 * `AgentDisplayState`，编译不过），守不住**你映射到了哪**——`unknown → 'done'` 类型完全合法，
 * 而它谎称 Agent 干完了；`unknown → 'error'` 同样合法，谎称它崩了。三处各写一遍，就是三次
 * 各自可以独立写错的机会，且写错的那一处只在它自己那条路径上撒谎（一条路显示"运行中"、
 * 另一条显示"已完成"，同一个 Agent），没有任何编译器或测试会因此变红。
 *
 * 三处的来路各不相同，这恰恰是它们必须共用一处的理由——同一个 Agent 的同一个状态，
 * 经不同的路到达界面时必须长得一样：
 *   - hook-normalizer：原生 hook 事件落地时（Provider 的 rules 认不出事件 → unknown）
 *   - session-state 的 agent-status 分支：Core 事件进 renderer 状态时（含 ACP 的 status）
 *   - agent-status-decay：15 分钟静默衰减时（DECAYED_SEMANTIC_STATE 就是 unknown）
 */
export function agentDisplayState(semantic: AgentSemanticState): AgentDisplayState {
  return semantic === 'unknown' ? 'running' : semantic
}

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

/**
 * 这个来源报出来的状态，是不是一条**活动声明**——即它是否应当压过裸的进程投影。
 *
 * 为什么要有这个判据，而不是让每处各写一遍 `source === 'native-hook' || source === 'acp'`：
 * 这条规则此前有**两份拼法**，且两份形状不同。
 *
 * - 实时路径（renderer 的 session-state.ts）写的是显式白名单：`source === 'native-hook' || 'acp'`。
 * - 快照/重载路径（main 的 runtime-controller.ts）写的是在场判定：`semanticStatus` 非空即保留。
 *
 * 它们今天一致，纯属巧合——`semanticStatus` 的唯二写入方恰好就是这两个来源，于是「字段在场」
 * 恰好等价于「来源属于那两个」。一旦有第三个活动来源被持久化（本仓已经做过一次同形的事：ACP 是
 * 后来补进那条白名单的），在场判定会自动接纳它，而白名单会**静默把它覆盖成裸 running**：实时看
 * 转圈的 Agent 丢掉「等你」的提醒，重载又变回 waiting。同一个 Agent，两个视图两种说法，且没有
 * 任何一条测试会红——实测过：把快照侧收窄成只认 native-hook，93 条全绿。
 *
 * 所以判据收到这里，两侧都 import 它。新增来源时只需回答一次「它算不算活动声明」，而不是去记得
 * 世上还有第二处拼法。
 *
 * 用 `Record<AgentMuxEvidenceSource, boolean>` 总映射而不是 `||` 串或 switch：给
 * {@link AgentMuxEvidenceSource} 加成员时少一格会让 tsc 变红，而不是安静落进 false——「忘了表态」
 * 与「表态为否」必须能区分开，这正是上面那个缺陷的成因。
 *
 * `terminal-output` 恒为 false 不是遗漏，是本仓的设计红线：AgentMux 绝不从终端字节推断语义活动
 * （见 types.ts 的 AgentMuxEvidenceSource 注释）。`run-process` 是进程投影本身——它不能压过自己。
 * `user` 是用户动作留下的印记，不是 Agent 在干活的证据。
 */
const AGENT_ACTIVITY_STATUS_SOURCE: Record<AgentMuxEvidenceSource, boolean> = {
  'terminal-output': false,
  'run-process': false,
  'native-hook': true,
  acp: true,
  user: false
}

export function isAgentActivityStatusSource(source: AgentMuxEvidenceSource): boolean {
  return AGENT_ACTIVITY_STATUS_SOURCE[source]
}
