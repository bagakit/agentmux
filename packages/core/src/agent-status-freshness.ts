import type {
  AgentCapabilities,
  AgentDisplayState,
  AgentMuxEvidenceSource,
  AgentMuxRunState,
  AgentSemanticState,
  AgentStatus
} from './types.js'

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
 * 支撑这一行的**最后一次真实观察**是否已过新鲜度窗口——与衰减同一个阈值、同一个 observedAt，只是
 * 去掉了「状态必须可衰减」那一层门。
 *
 * 为什么显示层需要一个不带 can-decay 门的版本，而不能直接用 {@link semanticStatusStale}：衰减把静默
 * 超阈值的 `working` 落成显示态 `running`，且**原样保留 observedAt**（衰减是对旧观察的重新解读，不是
 * 新观察，见 agent-status-decay.ts）。于是到了显示层，一个「15 分钟没人听到」的 Agent 状态已经是
 * `running`、observedAt 是那条旧证据的时刻——`semanticStatusStale` 因为它不再是 `working` 而返回
 * `false`，看不见它。显示层要回答的不是「它该不该衰减」（那是 `working` 的事、已在别处判过），而是
 * 「支撑这一行『此刻在忙』声明的证据还新不新」，这个问题对 `running`（衰减产物、或 idle 待机）同样
 * 成立。所以判据只看 observedAt，不看 state。
 *
 * 复用同一个 `SEMANTIC_STATUS_STALE_AFTER_MS`：不引入第二个阈值。`>=` 与 {@link semanticStatusStale}
 * 同口径，正好到点即算陈旧。
 */
export function agentEvidenceStale(
  status: Pick<AgentStatus, 'observedAt'>,
  now: number
): boolean {
  return now - status.observedAt >= SEMANTIC_STATUS_STALE_AFTER_MS
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

/**
 * 一次 Agent 观察的**三条不折叠的轴**——收敛入口。
 *
 * 这三件事此前分散在三处、各判各的，谁都没有把它们放在一起当一份合同来回答：进程活性走
 * `agent-run-status.ts` 的 {@link projectRunProcessStatus}；「此刻是不是在干活」的语义声明走本文件的
 * {@link agentDisplayState} / {@link isAgentActivityStatusSource} / 衰减；「就绪没就绪」则散在 Session
 * 的 `terminalPromptReadiness` / `pendingInteraction` / 终端能力降级里。三者一旦被某个消费者塌进一个
 * `busy` 布尔，就再也分不出「进程还活着但闲着」「在跑」「活着但还没就绪到能接你的话」——而它们要求用户
 * 做的事完全不同。这个类型把三条轴**并排**保留，各带自己的证据来源与观察时刻，谁也不冒充谁。
 */
export type AgentObservation = {
  /** 进程活性：内核报的 run 状态，独立于语义活动。`running` 不等于「在干活」。 */
  process: AgentMuxRunState
  /**
   * 语义活性：Agent 自己声明的「此刻在不在干活」。由**声明的 state** 与**来源**共同决定，不是只看来源
   * ——同一个 `native-hook` 会先后报 `working`（在干活）、`waiting`/`blocked`（停下了、在等你）、
   * `done`/`error`（出了结论），只看来源会把这三件事塌成一个 active。判定见 {@link observeAgent}。
   *
   * - `active`：有一条**活动声明**（native-hook / acp）且其 state 是「此刻正在干活」的 `working`，且未过
   *   新鲜度窗口。「哪个 state 算在干活」不另立拼法——直接问本文件 SSOT {@link semanticStatusCanDecay}。
   * - `awaiting-input`：进程在跑，且 Agent 明确声明 `waiting`/`blocked`——「我停下了、在等你」的**静止
   *   声明**。它既不是 active（没在干活）也不能压成 idle：它驱动界面的「需要你」提醒，压成 idle 等于把
   *   一个真实、可操作的信号悄悄抹掉（本仓明确记过的坑，见 {@link semanticStatusCanDecay} 注释）。四档
   *   active/idle/unknown/unsupported 装不下它，所以它自成一档。与 unknown 的分野：unknown 是「进程没在
   *   跑、无从谈起」，awaiting-input 是「进程在跑、且明确在等你」。且它不随静默衰减（只有 working 会），
   *   一条 20 分钟前的「等你」仍然在等你。
   * - `idle`：进程活着，但既没有在干活的活动声明、也没在等你。含裸 running、15 分钟静默衰减后的 working，
   *   以及 `done`/`error` 这类**结论**——它们在 running 下绝不报 active（那会谎称一个已出结论的 Agent
   *   还在干活）。
   * - `unknown`：进程不再是 running（starting/exited/interrupted 等），谈不上语义活性——不伪造 idle。
   * - `unsupported`：这个 Provider 的 timeline 能力是 `unavailable`，它根本不产语义活动信号。
   *   与 `unknown` 分开：unknown 是「这一刻碰巧没有」，unsupported 是「这条通道永远不存在」，
   *   叫用户去等一个永远不来的信号是错的。
   */
  semantic: 'active' | 'idle' | 'awaiting-input' | 'unknown' | 'unsupported'
  /**
   * 就绪性：Agent 现在能不能接你的一条普通输入。
   *
   * - `pending`：进程活着但还没就绪——正卡在一个待答的 typed 请求上（`awaitingRequest`），或终端
   *   能力尚未确认（握手降级）。此刻把 prompt 当普通输入送进去要么被拒、要么被当成对请求的回答。
   * - `ready`：进程 running 且没有上述阻塞，普通输入送得进去。
   * - `unknown`：进程不是 running，就绪与否无从谈起——不伪造 ready。
   */
  readiness: 'ready' | 'pending' | 'unknown'
  /** 谁观察到支撑这次读数的语义状态；沿用证据来源词表。 */
  source: AgentMuxEvidenceSource
  /** 支撑这次读数的最后一次观察时刻（epoch ms）。 */
  observedAt: number
  /**
   * 支撑 `semantic === 'active'` 的那条证据是否已过新鲜度窗口。
   *
   * `active` 由门禁（session-state / runtime-controller）在采纳时就会随衰减落回 idle，所以稳态下
   * 一个 stale 的读数通常已不是 active；这一位是给「拿到一份原始读数、想自己判它还新不新」的消费者
   * 用的诚实标注，判据只看 observedAt、与 {@link agentEvidenceStale} 同口径。
   */
  stale: boolean
}

/**
 * 迟到/过期/异源的读数是否**有资格**覆盖当前 Run 的观察。
 *
 * 这是「不能用一条陈旧或不属于当前 Run 的事件改写当前状态」这条不变量的收口判定，做成纯函数让它能被
 * 直接断言，而不是埋在某个 reducer 的 `&&` 链里各写一遍（session-state 的 agent-status/agent-session
 * 两条 arm 就各自手抄过 `observedAt >= …` 与 run 比对）。
 *
 * 两道门，缺一不可：
 *   1. **同一个 Run**：`incoming.runId` 必须等于 `current.runId`。一条属于旧 Run 的迟到事件绝不作用于
 *      新 Run（Resume 后 runId 变、agentSessionId 不变，正是这条要挡的场景）。`current.runId` 缺席读作
 *      「还没绑定到任何 Run」——此时无从比对，拒绝采纳。
 *   2. **不更旧**：`incoming.observedAt >= current.observedAt`。严格更旧的读数一律不采纳；正好同刻放行，
 *      与既有门禁的 `>=` 同口径（同刻重发是常态，不该被判为过期）。
 */
export function observationSupersedes(
  current: { runId?: string; observedAt: number },
  incoming: { runId: string; observedAt: number }
): boolean {
  if (current.runId === undefined || current.runId !== incoming.runId) return false
  return incoming.observedAt >= current.observedAt
}

/**
 * 把「Session 现在的三条事实」收敛成一份 {@link AgentObservation}——**唯一**的观察合同投影。
 *
 * 输入刻意收成「三条轴各自的原始事实」而不是某个具名 Session 类型：Core 侧的
 * `AgentMuxAgentSession` 与渲染侧的 `SessionSnapshot` 是两个不同的载体，它们只在这几条上同名同义，
 * 让两侧都喂这一个函数，才不会各自再拼一份塌成 busy 的逻辑（那正是本 Feature 要消灭的
 * 「声明了却各造一套」）。
 *
 * @param input.process        内核报的 run 状态。
 * @param input.status         当前语义/进程投影出的 {@link AgentStatus}（含 state/source/observedAt）。
 * @param input.timelineCapability 这个 Provider 的 timeline 能力档位；`unavailable` ⇒ semantic 恒
 *   `unsupported`（它根本不产语义信号，别叫用户等）。
 * @param input.awaitingRequest 是否正卡在一个待答的 typed 请求上（permission/question）。
 * @param input.terminalCapabilityUnverified 终端能力是否尚未确认（握手降级），此时就绪性 pending。
 * @param now                  现在时刻，用于新鲜度标注。
 */
export function observeAgent(
  input: {
    process: AgentMuxRunState
    status: Pick<AgentStatus, 'state' | 'source' | 'observedAt'>
    timelineCapability: AgentCapabilities['timeline']
    awaitingRequest: boolean
    terminalCapabilityUnverified: boolean
  },
  now: number
): AgentObservation {
  const running = input.process === 'running'
  const state = input.status.state
  const declared = isAgentActivityStatusSource(input.status.source)
  const semantic: AgentObservation['semantic'] = input.timelineCapability === 'unavailable'
    ? 'unsupported'
    : !running
      ? 'unknown'
      // 语义活性由**声明的 state** 与**来源**共同决定，不是只看来源：只有活动声明来源（native-hook/acp）
      // 才谈得上语义活性，裸的 run-process/terminal/user 投影一律 idle（它不能压过自己）。
      : !declared
        ? 'idle'
        // waiting/blocked：「我停下了、在等你」的静止声明——自成一档 awaiting-input，绝不压成 idle
        // （压成 idle 会抹掉驱动「需要你」提醒的真实信号，见 semanticStatusCanDecay 注释里记的坑）。
        // 它不随静默衰减（只有 working 会），所以不看 agentEvidenceStale：一条 20 分钟前的「等你」仍在等你。
        // 「waiting/blocked = 需要人介入」这个概念的 SSOT 在渲染侧 attention-vocabulary.ts 的 NeedsYouState；
        // Core 够不着它（那个模块 import 自 @agentmux/core，反向依赖会成环），故此处就地判定。
        : state === 'waiting' || state === 'blocked'
          ? 'awaiting-input'
          // working 且新鲜 = 此刻正在干活。「哪个 state 算在干活」不另立第三份拼法——直接问本文件
          // SSOT semanticStatusCanDecay（只有 working）。done/error 这类**结论**、以及已过新鲜度窗口的
          // working，都落 idle：绝不冒充 active（那会谎称一个已出结论/已沉默的 Agent 还在干活）。
          : semanticStatusCanDecay(state) && !agentEvidenceStale(input.status, now)
            ? 'active'
            : 'idle'
  const readiness: AgentObservation['readiness'] = !running
    ? 'unknown'
    : input.awaitingRequest || input.terminalCapabilityUnverified
      ? 'pending'
      : 'ready'
  return {
    process: input.process,
    semantic,
    readiness,
    source: input.status.source,
    observedAt: input.status.observedAt,
    stale: agentEvidenceStale(input.status, now)
  }
}
