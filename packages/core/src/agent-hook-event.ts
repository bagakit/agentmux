import type { AgentHookLifecycleEvent } from './types.js'
import { TURN_REOPENING_EVENTS } from './hook-turn-phase.js'

/**
 * Hook 事件名的**规范化层**：一个零依赖的叶子模块，只做两件事——把「事件名藏在哪个字段」和
 * 「厂商方言叫什么」收敛成 Core 的同一份口径。
 *
 * 为什么单独成一个模块：这份表有两个消费者，它们跑在**不同的进程里**。normalizer 跑在 Core 进程，
 * `agent-hook-command` 跑在每次 hook 事件都新起一次的子进程（`bin/agentmux-hook.js`）里，后者的启动
 * 时间落在 Agent 每次工具调用的关键路径上。让子进程去 import normalizer（那里有跨事件的花名册 Map、
 * node:path 依赖）只为拿一张表，是让最热的路径为它用不到的机制付钱。所以表放在这里：无 runtime 依赖、
 * 两边都能便宜地拿到，且**只有一份**。
 *
 * 这层不碰语义状态。`working`/`done` 一律由 Provider 自己声明的 `rules` 决定（见 hook-normalizer.ts），
 * 规范化只回答 Core 真正需要判断的那几个问题——「这条事件是工具结果吗」「这条事件是 turn 收尾吗」。
 * 映射不到的事件保持映射不到：它的原始名照旧带进诊断，语义仍由 rules 给出，绝不因为「没认出来」就
 * 补一个 working/done。
 */

/**
 * 事件名可能藏身的 payload 字段名，顺序即优先级。
 *
 * 三个拼法都真实存在：Claude/Codex 的 stdin 负载给 `hook_event_name`，同族 CLI 的 camelCase 变体给
 * `hookEventName`，另一些给裸 `eventName`。**此前三个读取点各认其中两个**——normalizer 认
 * `hook_event_name`/`hookEventName`，hook 子进程认 `hook_event_name`/`eventName`，
 * 于是同一条事件在同一次投递里，一边认得出、另一边读成 null。这份清单就是那三处的唯一出处。
 */
export const HOOK_EVENT_NAME_PAYLOAD_KEYS = ['hook_event_name', 'hookEventName', 'eventName'] as const

/**
 * 一个 Provider 的负载里真正带事件名的那个键，取值只能是上面三拼法之一。
 *
 * 收成一个类型是为了让「事件名来源声明」在编译期就受这份 SSOT 约束：某 Provider 声明它靠
 * `hookEventName` 送事件名，而这个键哪天从上面的清单里被删，那个 Provider 文件就编不过——投递侧
 * 读不到、配置侧却还声称在用，正是本仓「两个拼法面」教训里那种「装了不认」。编译期挡一层，
 * 运行时的守卫再钉一层（vitest 只转译不查类型，单靠类型会漏）。
 */
export type HookEventNamePayloadKey = (typeof HOOK_EVENT_NAME_PAYLOAD_KEYS)[number]

/**
 * 一个 Provider 的方言声明：它把自己的原始事件名映射到 Core canonical 生命周期事件。
 *
 * **按 Provider 分块而不是一张全局表**，是为了让「新接一个 Provider」只动它自己的模块。全局表会让
 * 每个 Provider 分支都去改同一个文件的同一个对象字面量——那是并行开发里保证冲突的形状，也正是
 * Provider 模块拆分本来要消除的东西。
 */
export type AgentHookLifecycleDialect = Readonly<Record<string, AgentHookLifecycleEvent>>

/**
 * 厂商方言 → Core canonical 生命周期事件的**显式**映射。
 *
 * 显式是刻意的：不按前缀猜（`startsWith('Post')` 这类形状推理正是本表要取代的东西——它把
 * Antigravity 的 `PostInvocation` 误当成工具结果，同时对 Hermes 的 `post_tool_call`、Pi 的
 * `tool_execution_end` 完全失明）。一个方言名只在**该 Provider 自己的声明能佐证**时才进表；
 * 佐证不了的就不进表，让它保持可诊断，而不是替 Provider 猜语义。
 *
 * 也刻意**不做大小写/分隔符归一化**（把 `PreToolUse` 正则折成 `pre_tool_use` 那种）。折叠会顺带
 * 接受一堆从没被任何 Provider 观察到的拼法，于是表里每个键不再等于「某处有证据的事实」，
 * 而变成「碰巧能被折过来的字符串」——审计不了，也就守不住「能力未核实就不声明」这条北极星。
 *
 * 键**允许在 Provider 之间重复**：同一个原始名在不同 Provider 上是同一个结构性生命周期事件
 * （grok 与 cursor 都用 `stop` 收尾）。允许重复是安全的，因为这里只答「这是结构上的哪一步」，
 * 不答 `working`/`done`——语义状态一律由各 Provider 自己的 `rules` 给出。这个分工是必须的：
 * OpenCode 的 `SessionStart` 是 `done`（一次会话到此结束），Claude 的 `SessionStart` 是 `working`，
 * 同名同结构、语义相反。真出现同名却**结构**冲突的 Provider，再按其真实形状把查表下推到 Provider，
 * 别为了一个尚未存在的冲突提前把接口做复杂。
 */

/** Claude / Codex / Antigravity 一族的 PascalCase 方言（Claude 与 Codex 共用这份）。 */
export const PASCAL_CASE_HOOK_DIALECT: AgentHookLifecycleDialect = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt-submit',
  PermissionRequest: 'permission-request',
  // 一次工具调用的**事前**：只有入参，谈不上成败。
  PreToolUse: 'tool-use-start',
  // 一次工具调用的**事后**：结果与成败在此刻才存在。这两行就是 `startsWith('Post')` 的替代品。
  PostToolUse: 'tool-use-end',
  PostToolUseFailure: 'tool-use-end',
  // 子代理生命周期（按 id 记账的那套，见 hook-normalizer 的花名册）。
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
  // 一个 turn 收尾——用量在此刻已落定，故这是「该不该读 transcript 抽 token」的唯一判据。
  Stop: 'turn-end',
  StopFailure: 'turn-end'
}

/**
 * 故意不进表的几个，以及为什么（它们属于上面那份 PascalCase 方言的「不映射」决定）：
 * - `PreCompact`（Claude）、`PreInvocation`/`PostInvocation`（Antigravity）：Core 今天没有任何判断
 *   需要它们，各自的 Provider `rules` 已给出正确的 `working`。`PostInvocation` 尤其不能进
 *   `tool-use-end`——它是一次调用的外层收尾，不是一次工具调用的结果。
 */

/**
 * Hermes 的 snake_case 方言。
 *
 * `pre_llm_call` → `turn-start`：它是 Hermes 这一轮的**开工**信号，与 `post_llm_call` 的收尾成对
 * （第一方源码实测：`post_llm_call` 在 turn finalizer 里「每 turn 一次」，`pre_llm_call` 在 turn
 * context 构建里每 turn 一次；两者都不是每次 API 往返——那是更热的 `pre_api_request`，故刻意不装）。
 *
 * 这一条**曾经**按「Core 今天没有任何判断需要它」刻意不映射。那个理由已经过期：turn-phase 闸门
 * （hook-turn-phase.ts）就是需要它的判断，而 Hermes 的 hook 面上没有任何「用户提交了 prompt」事件
 * （用户在它自己的 TUI 里打字，AgentMux 看不见），于是闸门永久 latch——第一次收尾之后整个 run 余下的
 * working/等你态全被静默吞掉。教训是：「今天没有消费者」是个**会过期**的理由，加判断的人必须回头看
 * 这张表，而不是假设它已经够用。
 *
 * 为什么不图省事记成 `user-prompt-submit`：那会在 canonical 表里留一句假话（没有任何用户输入发生过），
 * 而这张表是「结构上的哪一步」的唯一真相。词汇表因此新增 `turn-start`（见 types.ts）。
 *
 * `on_session_start` 保持 `session-start`，**不**当重开用：第一方源码写明它只在全新会话建立时触发
 * （"not on continuation"），一个 run 里只有一次，拿它重开对第二轮起没有任何作用。
 *
 * `pre_approval_request`/`post_approval_response` 也不映射：它们是**授权门的两端**（Hermes 明说是
 * observers only，返回值被忽略），不是一次工具调用的事前/事后——同一条危险命令会先过授权门、
 * 再走 `pre_tool_call`，把门也算成 tool-use-start 会让一次执行在时间轴上落两条。这与 Cursor 的
 * `beforeShellExecution` 是同一个判断。语义状态由 Hermes 自己的 rules 给出（门是 `waiting`）。
 *
 * `subagent_stop` 这个名字由 grok 的方言块贡献（同名同结构，合并表允许重复），所以它**有** canonical
 * 值。Hermes 这边不加自己的条目也不需要：canonical 层只答「这是结构上的哪一步」，与哪家有记账无关。
 * 真正的分界在记账层——Hermes 的 `subagent_start` 未被证据佐证 id 键，故它不声明 `subagentTracking`
 * （见 providers/hermes.ts）。
 */
export const HERMES_HOOK_DIALECT: AgentHookLifecycleDialect = {
  on_session_start: 'session-start',
  pre_llm_call: 'turn-start',
  pre_tool_call: 'tool-use-start',
  post_tool_call: 'tool-use-end',
  post_llm_call: 'turn-end',
  on_session_end: 'turn-end'
}

/**
 * Pi 的 snake_case 方言。
 *
 * `message_end` 刻意不映射：Pi 自己把它声明成 `working` 而非 `done`，映射成 turn 收尾会与 Provider
 * 的声明相矛盾——那正是「替 Provider 猜语义」。
 *
 * **`agent_settled` 是唯一的收尾，`agent_end` 不是**，且后者刻意不在这张表上。这一条来自上游源码：
 * `agent_end` 之后 Pi 还有三条各自独立的续跑路径（可重试错误 / 自动压缩 / handler 自己排进队的消息，
 * 见 providers/pi.ts 那段逐行引证），`agent_settled` 才是那个 while 循环跑完后在 finally 里发的唯一
 * 一次。把 `agent_end` 记成 `turn-end` 在两条轴上都错：turn-phase 闸门会在每次重试前先判一次「本轮
 * 收尾」，而 USAGE_FINALIZATION_EVENTS 会在 transcript 还没落定时就去读用量。
 *
 * 它曾经在这张表上（与「两个名字都判 done」的旧规则成对）。删掉而不是留着：Pi 的扩展根本不订阅
 * `agent_end`，留一行永不命中的映射不是无害的冗余，而是一句关于「Pi 什么时候算干完」的谎，
 * 下一个人会据此以为闸门在 Pi 上按 `agent_end` 开合。
 *
 * **Pi 今天没有重开事件，这是已知缺口而不是遗漏。** turn-phase 闸门要求「能收尾的方言也要能重开」
 * （hook-turn-phase.ts），Pi 满足不了，而理由**不是**没有第一方证据——恰恰相反，证据齐了才看清缺口的
 * 真形状：`before_agent_start`/`agent_start` 每轮都发，但它们在上游是「这个 agent run 起来了」而不是
 * 「用户交了新输入」或「新一轮开工」；把它们记成 `turn-start` 会让闸门在一次 run 内的**每次续跑**
 * （retry / compaction / queued，见上）都误判成新一轮，那正是这道闸门要挡的残响窗口自己被打开。
 * 按本仓「未核实就不声明」的规矩，这里不编一个映射去让不变量变绿。
 *
 * 缺口的实际后果被 hookEventUpdatesSemanticStatus 的保守出口兜住了：它对没有重开事件的方言不 latch
 * （见本文件末尾的 `eventNamesCanReopenTurn`，以及 client.ts 摄入侧把它算出来喂进闸门的那一句），
 * 代价是 Pi 拿不到「收尾后压制迟到工具事件」这一层保护。
 * 要收掉这个缺口，需要的是一个语义上真的等于「新一轮开工」的 Pi 事件，而不是这张表上多一行。
 * 证据缺口记在 docs/reviews/agentmux-provider-cli-evidence.md 的 Pi 一节。
 */
export const PI_HOOK_DIALECT: AgentHookLifecycleDialect = {
  before_agent_start: 'session-start',
  agent_start: 'session-start',
  tool_call: 'tool-use-start',
  tool_execution_start: 'tool-use-start',
  tool_execution_end: 'tool-use-end',
  agent_settled: 'turn-end'
}

/**
 * grok 的 snake_case wire 方言。
 *
 * 注意 grok 的两个面拼法不同：写进 hooks 配置的是 PascalCase（`PreToolUse`），而它在 stdin 负载的
 * `hookEventName` 里报的是 snake_case（`pre_tool_use`）。这里只管**投递侧**——配置侧的清单在
 * grok 自己的 Provider 模块里。
 *
 * `stop_cancelled` 是这份方言里最要紧的一条：grok 在中断、拒绝授权、max-turns、无进展时触发
 * `StopCancelled` **取代** `Stop`，也就是说这几种收尾根本不会有 `stop`。少映射它，用户按下中断后
 * Agent 会永远停在 working，且没有任何后续事件能把它救回来。
 *
 * `permission_denied`/`notification`/`pre_compact`/`post_compact` 刻意不映射：Core 今天没有判断
 * 需要它们，且 grok 的 `notification` 是一族按 message 分辨的 UI 提示，映射成生命周期等于替
 * Provider 猜语义。
 */
export const GROK_HOOK_DIALECT: AgentHookLifecycleDialect = {
  session_start: 'session-start',
  user_prompt_submit: 'user-prompt-submit',
  pre_tool_use: 'tool-use-start',
  post_tool_use: 'tool-use-end',
  post_tool_use_failure: 'tool-use-end',
  subagent_start: 'subagent-start',
  subagent_stop: 'subagent-stop',
  stop: 'turn-end',
  stop_failure: 'turn-end',
  stop_cancelled: 'turn-end'
}

/**
 * Gemini 的 PascalCase 方言。
 *
 * 事件名是 Gemini 自己的一套（`BeforeTool`，不是 Claude 的 `PreToolUse`），但**负载键**是 Claude
 * 同族的 snake_case——这正是 `gemini hooks migrate --from-claude` 成立的原因，也是最容易搞混的地方：
 * 同族的是负载，不是事件名，所以不能照抄 Claude 的事件清单。
 *
 * `AfterAgent` 映射 turn-end 而非 session-end：它带 `prompt`/`prompt_response`/`stop_hook_active`，
 * 是**一轮**的收尾。Gemini 另有 `SessionEnd` 管会话终结，那不是轮次事实，故不进表。
 *
 * `BeforeModel`/`AfterModel`/`BeforeToolSelection`/`PreCompress`/`Notification` 刻意不映射：
 * Core 今天没有判断需要它们，且 `AfterModel` 尤其不能进 `tool-use-end`——它是一次模型往返的收尾，
 * 不是一次工具调用的结果（与 Antigravity 的 `PostInvocation` 同理）。
 */
export const GEMINI_HOOK_DIALECT: AgentHookLifecycleDialect = {
  SessionStart: 'session-start',
  BeforeAgent: 'user-prompt-submit',
  BeforeTool: 'tool-use-start',
  AfterTool: 'tool-use-end',
  AfterAgent: 'turn-end'
}

/**
 * Cursor 的 camelCase 方言。
 *
 * 拼法自成一族：既不是 Claude 的 PascalCase，也不是 Hermes 的 snake_case。**只有事件名是 camelCase**，
 * 负载键反倒是 Claude 同族的 snake_case（`tool_name`/`tool_input`/`tool_output`/`tool_use_id`），
 * 与 Gemini 的错位方式相同、错位的方向相反。
 *
 * `beforeSubmitPrompt` 是 Cursor 的 user-prompt-submit（负载带 `prompt`）。`postToolUseFailure`
 * 与 `postToolUse` 同为一次工具调用的事后：两者都带 `tool_use_id`，前者携 `error_message`/
 * `failure_type`/`is_interrupt` 而**不带** `tool_output`——所以它必须映射成 tool-use-end，否则
 * 那次调用会永远停在 streaming 徽标上。
 *
 * `beforeShellExecution`/`beforeMCPExecution` 刻意不映射：它们是**授权门**（stdout 上回
 * `permission: allow|deny|ask`），不是一次工具调用的事前——同一条命令会先过门、再走
 * `preToolUse`，把门也算成 tool-use-start 会让一次执行在时间轴上落两条。
 * `afterAgentResponse` 也不映射：它带的是助手正文（`text`）与本轮 token，是**一段回复**的收尾
 * 而非**一轮**的收尾（Cursor 一轮里可以有多段回复），turn 收尾由 `stop` 独占。
 *
 * `sessionStart`/`sessionEnd`/`preCompact`/`subagentStart`/`subagentStop`/`afterAgentThought`/
 * `workspaceOpen` 等 Cursor 其余事件不进这份表也不安装：Core 今天没有判断需要它们（子代理记账
 * 需要 Cursor 侧的 id 键佐证，本机 bundle 里 `subagentStart` 带 `subagent_id`，但 AgentMux
 * 尚未观察过一次真实子代理会话，故按「未核实就不声明」留空）。
 */
export const CURSOR_HOOK_DIALECT: AgentHookLifecycleDialect = {
  beforeSubmitPrompt: 'user-prompt-submit',
  preToolUse: 'tool-use-start',
  postToolUse: 'tool-use-end',
  postToolUseFailure: 'tool-use-end',
  stop: 'turn-end'
}

/**
 * Copilot 的 camelCase 方言。
 *
 * 事件名与 Cursor 同为 camelCase 且**三个键逐字重合**（`preToolUse`/`postToolUse`/
 * `postToolUseFailure`），映射也逐字相同——那是合法复用（同名同结构），不是冲突。但**负载键与
 * Cursor 相反**：Copilot 两侧都是 camelCase（`toolName`/`toolArgs`/`toolResult`），Cursor 的负载
 * 反倒是 snake_case。所以"事件名像"推不出"负载键像"，两者必须各自佐证。
 *
 * `userPromptSubmitted` 是它的 user-prompt-submit。这个名字**必须逐字**：`userPromptSubmit`
 * （Claude 一族的拼法，也是最自然的猜法）在它的解析器里会被**静默丢弃**——不报错、不告警，
 * 配置照样"装好了"，只是那个事件永远不响。本机实测如此（见 providers/copilot.ts 的实测记录）。
 *
 * `agentStop` 是**一轮**收尾。`sessionEnd` 不进表：它是会话终结（带 `reason`），与 droid/Gemini
 * 同一个既定判断——轮次收尾靠 agentStop，会话终结由 PTY 事实回答。
 *
 * `subagentStart`/`subagentStop` 进表：这是继 Claude 之后第二个**真的成对**的 Provider（实测两个
 * 事件都触发、都带 `agentName`）。
 *
 * `permissionRequest` 进表映射 permission-request：它是「授权规则引擎之前的那一步」，结构上确实是
 * 一次授权请求（上游描述逐字："run before the permission rules engine for a tool decision"）。
 *
 * `userPromptTransformed`/`errorOccurred`/`preCompact`/`notification`/`preMcpToolCall` 刻意不映射：
 * Core 今天没有判断需要它们，且 `preMcpToolCall` 尤其不能进 tool-use-start——同一次 MCP 调用会先过
 * 它、再走 `preToolUse`，两条都算事前会让一次执行在时间轴上落两条（与 Cursor 的两个授权门同理）。
 */
export const COPILOT_HOOK_DIALECT: AgentHookLifecycleDialect = {
  sessionStart: 'session-start',
  userPromptSubmitted: 'user-prompt-submit',
  permissionRequest: 'permission-request',
  preToolUse: 'tool-use-start',
  postToolUse: 'tool-use-end',
  postToolUseFailure: 'tool-use-end',
  subagentStart: 'subagent-start',
  subagentStop: 'subagent-stop',
  agentStop: 'turn-end'
}

/**
 * Core 认识的全部方言，按 Provider 组合。
 *
 * 每个 Provider 一块声明、这里一行 spread：新接一个 Provider 只在本文件追加自己那块，不必去动
 * 任何已有 Provider 的映射（并行分支因此改的是互不相邻的区域）。
 *
 * 为什么方言留在这个叶子模块、而不是搬进各自的 `providers/*.ts`：本模块是**零运行时依赖**的叶子，
 * 每次 hook 事件都新起一次的子进程靠它拿表（见文件头）。让它反向 import 任何 Provider 模块，就会
 * 把 node:os、registry、normalizer 整条图拖进 Agent 每次工具调用的关键路径——那正是本模块存在的
 * 理由所要避免的。方言是纯数据，放这里没有代价；Provider 侧只保留它自己的 rules 与 installer 清单。
 */
const HOOK_LIFECYCLE_DIALECTS: readonly AgentHookLifecycleDialect[] = [
  PASCAL_CASE_HOOK_DIALECT,
  HERMES_HOOK_DIALECT,
  PI_HOOK_DIALECT,
  GROK_HOOK_DIALECT,
  GEMINI_HOOK_DIALECT,
  CURSOR_HOOK_DIALECT,
  COPILOT_HOOK_DIALECT
]

/** 合并后的查表面。重复键必须映射到同一个 canonical 事件，否则是真冲突——见下方构造时的断言。 */
export const AGENT_HOOK_LIFECYCLE_DIALECT: AgentHookLifecycleDialect = (() => {
  const merged: Record<string, AgentHookLifecycleEvent> = {}
  for (const dialect of HOOK_LIFECYCLE_DIALECTS) {
    for (const [raw, canonical] of Object.entries(dialect)) {
      const existing = merged[raw]
      // 同名不同结构 = 一个原始名在两家 Provider 上是**结构上不同**的一步。合并表答不了这种问题，
      // 静默取其一会让其中一家的时间轴长期错位，所以在模块加载时就炸，而不是留一个安静的错答案。
      if (existing !== undefined && existing !== canonical) {
        throw new Error(
          `Hook lifecycle dialect conflict for "${raw}": ${existing} vs ${canonical}. ` +
          'A raw event name must mean the same structural step for every Provider.'
        )
      }
      merged[raw] = canonical
    }
  }
  return merged
})()

function boundedEventName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * 从信封与负载里读出这条 hook 事件的**原始**名字。
 *
 * 信封上的显式 `eventName` 优先（它来自 hook 命令的 `--event` 旗标或环境变量，是投递方明说的），
 * 其次按 `HOOK_EVENT_NAME_PAYLOAD_KEYS` 依次读负载。读不出就是 `undefined`——由调用方决定缺席怎么办，
 * 这里不替它编一个名字。
 */
export function resolveHookEventName(
  envelopeEventName: unknown,
  payload: Record<string, unknown> = {}
): string | undefined {
  const explicit = boundedEventName(envelopeEventName)
  if (explicit) return explicit
  for (const key of HOOK_EVENT_NAME_PAYLOAD_KEYS) {
    const value = boundedEventName(payload[key])
    if (value) return value
  }
  return undefined
}

/**
 * 把一个厂商方言事件名归一化到 Core canonical 生命周期事件。
 *
 * 认不出就返回 `undefined`——这是一等公民的答案，读作「Core 对这条事件没有 canonical 语义」，
 * 而不是「这条事件不重要」或「就当它是 working」。调用方必须能在缺席下正确工作。
 */
export function canonicalHookLifecycleEvent(
  rawEventName: string | undefined
): AgentHookLifecycleEvent | undefined {
  if (!rawEventName) return undefined
  return AGENT_HOOK_LIFECYCLE_DIALECT[rawEventName]
}

/**
 * 反查：所有归一化到某个 canonical 事件的**原始**方言名。
 *
 * 给那些只能按原始名做集合判定的既有消费者用（`USAGE_FINALIZATION_EVENTS` 就是这么派生出来的），
 * 好让它们不必各自再抄一份厂商事件名——表在这里，派生在别处，仍然只有一份真相。
 */
export function rawEventNamesForLifecycle(
  lifecycleEvent: AgentHookLifecycleEvent
): readonly string[] {
  return Object.entries(AGENT_HOOK_LIFECYCLE_DIALECT)
    .filter(([, canonical]) => canonical === lifecycleEvent)
    .map(([raw]) => raw)
}

/**
 * 这家 Provider 有没有能力重开一个 turn，也就是 turn-phase 闸门的前提在它身上成不成立。
 *
 * 闸门（hook-turn-phase.ts）的整套推理是「收尾之后要再动工，必先开新一轮」。一家能收尾却无法重开的
 * Provider 让这个前提直接失效，闸门于是从「可逆的抑制」退化成「永久拒绝」。所以前提可满足性要算出来，
 * 而不是靠谁记得给哪家 Provider 加例外。
 *
 * 判据取 Provider **自己声明的原始事件名**（它 rules 里出现的那些）经方言归一后的结果，而不是去猜它
 * 属于哪份方言表——方言表按原始名查，压根没有「哪家用哪份」的绑定，硬做一份绑定等于新增一处手抄。
 *
 * 刻意是**存在性**而不是清单：不问「有没有 pre_llm_call」，只问「有没有任何声明的事件归一到重开事件」。
 * 换厂商事件名、接新 Provider 都不必改这里；写成清单则每加一家都要回来补，而漏补是静默的。
 */
export function eventNamesCanReopenTurn(rawEventNames: Iterable<string>): boolean {
  for (const raw of rawEventNames) {
    const canonical = canonicalHookLifecycleEvent(raw)
    if (canonical && TURN_REOPENING_EVENTS.includes(canonical)) return true
  }
  return false
}
