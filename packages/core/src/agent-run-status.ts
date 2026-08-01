import type { AgentMuxRunExitReason } from './agent-run-exit.js'
import type { AgentDisplayState, AgentMuxEvidenceSource, AgentMuxRunState } from './types.js'

/**
 * 「一个 run 的进程事实长什么样」→「界面上那一行状态说什么」的**唯一**投影。
 *
 * 为什么要有这个文件：这段投影本来存在**两份独立实现**，各自读一个不同形状的输入——
 * - 快照路径（主进程 runtime-controller 的 projectSession）：App 冷启动、reload、重连补发时走它，
 *   输入是 daemon 的 run 快照。
 * - 实时路径（renderer 的 session-state 收 process-state 事件）：进程状态当场变化时走它，
 *   输入是 Core 的事件。
 *
 * 两条路投影**同一个概念**，却在两个包里各写一遍，于是它们必然漂移，而且漂移的症状极难归因：同一个
 * 已退出的 Agent，「在场时看到的」与「reload 之后看到的」不是一句话。实测坐实过两处：
 * - 快照路径带 `signal SIGSEGV` 的 detail，实时路径整段没有（`exitSignal` 在 session-state.ts 零命中）。
 *   于是崩溃**当下**看不到也搜不到是哪个信号，关掉窗口再打开反而看到了。
 * - 'The Run owner interrupted this PTY.' 这句文案被逐字手抄两份，改一份不会有任何测试红。
 *   今天两句字面相同所以用户看不出问题，那只是「还没漂」，不是「不会漂」。
 *
 * 所以判据不是「两处取值凑巧相等」，而是**同一个决定只做一次**：两侧各自只负责从自己的输入形状里把
 * Core 事实取出来，喂给这里；「这些事实该显示成什么」只有这一个答案。
 *
 * 为什么落在 Core 而不是 renderer 的 lib：主进程与 renderer 分居两个包，只有 Core 是它们的公共下游。
 * 为什么单独一个文件（配 `./run-status` 子路径导出）而不是塞进 `types.ts` 或直接从包根导出：从包根
 * `@agentmux/core` import 会把 `runtime-paths.js` 一起拖进来，那条链要 `node:crypto`，renderer 的构建
 * 会当场炸。先例是 `agent-provider-id.ts` / `agent-status-freshness.ts`，同样的理由、同样的做法。
 *
 * 刻意**不**包含的东西：实时路径那道 `observedAt` 严格单调门禁。那是事件流特有的去抖（同一条状态会被
 * 反复重发），属于「这条证据要不要采纳」，不属于「采纳了该显示什么」。把它塞进来会让快照路径凭空多出
 * 一个它根本没有的概念。
 */

/**
 * 一次进程观察投影出来的界面状态。
 *
 * 刻意**不**复用 `AgentStatus`：那是「语义状态」的形状（Agent 自己声明的 working/waiting/done 等），
 * 它没有 `exitReason`。而进程投影必须带 exitReason——桌面侧的 `SessionStatus` 正是 `AgentStatus`
 * 加上 exitReason/continuity 等几条的超集，两条路径投出来的都要落进它。所以这里声明进程投影自己的
 * 返回形状，恰好是那个超集里进程事实能填的那几条：多写一条编译不过，少写一条那条事实到不了界面。
 */
export type RunProcessStatus = {
  state: AgentDisplayState
  source: AgentMuxEvidenceSource
  observedAt: number
  detail?: string
  exitCode?: number
  exitReason?: AgentMuxRunExitReason
}

/** 进程事实投影所需的输入。两条路径各自把自己的输入形状归一到这里，字段语义与 Core 事件同源。 */
export type RunProcessObservation = {
  /** 内核报的 run 状态。 */
  state: AgentMuxRunState
  /** 这条观察的来源与时刻，直接落到 status 上。 */
  source: AgentMuxEvidenceSource
  observedAt: number
  /** 内核报的退出码；缺席表示这条观察没带码。 */
  exitCode?: number
  /** 内核报的终止信号名；缺席表示不是被信号杀的（或这条观察没带）。 */
  exitSignal?: string
  /** 退出原因的诚实分类，由 Core 合成（意图 + 结果）。 */
  exitReason?: AgentMuxRunExitReason
}

/**
 * `interrupted` 的说明文案。
 *
 * 单独拎成常量而不是在投影里写字面量，是因为它此前被手抄了两份。常量化之后「这句话是什么」有且只有
 * 一个出处，改它必然同时改两条路径。
 *
 * 为什么 `interrupted` 需要一句话而 `exited` 不需要同款：`interrupted` 是「PTY 没了」，它既没有退出码
 * 也没有信号可给，不解释一句用户只会看到一个没有下文的 error。
 */
export const RUN_INTERRUPTED_DETAIL = 'The Run owner interrupted this PTY.'

/**
 * 进程状态在界面上的显示态。`interrupted`（PTY 消失）对用户就是「出错了」——它不是一个用户能理解的
 * 独立状态，而 `processState` 仍保留原值供需要区分的地方读。
 */
export function runDisplayState(state: AgentMuxRunState): AgentDisplayState {
  return state === 'interrupted' ? 'error' : state
}

/**
 * 把一次进程观察投影成界面那一行状态。
 *
 * detail 的取值顺序即优先级：`interrupted` 用固定文案（它没有码也没有信号可说）；否则若内核报了信号，
 * 说是哪个信号——`signal SIGSEGV` 比一个裸 error 有用得多，而且它是可搜索的文本。两者都没有就不写
 * detail，绝不写空串或占位符（那会把「没有更多信息」伪装成「信息是空的」）。
 *
 * `exitCode` / `exitReason` 都是「带就带上、缺就缺席」：0 是一个合法的退出码，用 `?? 0` 兜底会把
 * 「没报码」伪造成「干净退出」。
 */
export function projectRunProcessStatus(observation: RunProcessObservation): RunProcessStatus {
  return {
    state: runDisplayState(observation.state),
    source: observation.source,
    observedAt: observation.observedAt,
    ...(observation.state === 'interrupted'
      ? { detail: RUN_INTERRUPTED_DETAIL }
      : observation.exitSignal === undefined
        ? {}
        : { detail: `signal ${observation.exitSignal}` }),
    ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
    ...(observation.exitReason === undefined ? {} : { exitReason: observation.exitReason })
  }
}
