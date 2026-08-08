import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog, managedHookCommand, hookCommandTimeout } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * 写进 `<copilot-home>/hooks/agentmux.json` 的事件名。
 *
 * 证据来自**执行这个 CLI 自己的 hook 解析器**：它的原生 runtime（`prebuilds/<platform>/runtime.node`）
 * 可以直接被 node 加载，于是本轮不是读二进制字符串猜形状，而是真的把配置喂进去、真的让它 spawn 一个
 * 捕获脚本、真的读回每个事件的 stdin 负载。下面每一条"实测"都指这件事。
 *
 * 装十个。它的事件全集是十五个（配置 schema 里 `hooks.*` 十五个键逐字可读），不装的五个见文件末尾。
 *
 * - `sessionStart`：一轮的开端。负载带 `source`（`startup`/`resume`/`new`）与 `initialPrompt`。
 * - `userPromptSubmitted`：带 `prompt`。**这个名字必须逐字**——见下面 EVENT_NAMES_ARE_EXACT 那段。
 * - `preToolUse`/`postToolUse`/`postToolUseFailure`：一次工具调用的事前与两种事后。
 * - `permissionRequest`：授权规则引擎之前那一步（上游描述逐字："run before the permission rules
 *   engine for a tool decision, able to allow or deny"）。装它是为了让「Agent 正卡在一个授权决定上」
 *   对 Core 可见；我们不回决定（见 catalog 的 `permission: 'observe'`）。
 * - `subagentStart`/`subagentStop`：子代理两端，**实测真的成对触发**。
 * - `preCompact`：压缩前，带 `trigger`。压缩期间没有任何工具事件，少了它长压缩看起来像卡死。
 * - `agentStop`：**一轮**收尾，带 `stopReason`/`transcriptPath`。
 */
export const COPILOT_HOOK_EVENTS = [
  'sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'postToolUseFailure',
  'permissionRequest', 'subagentStart', 'subagentStop', 'preCompact', 'agentStop'
] as const

/**
 * 事件名一个字都不能猜。
 *
 * 这个解析器对**不认识的事件名静默丢弃**：不报错、不告警，加载照样成功，整份配置看起来"装好了"，
 * 只是那个桶永远不响。实测踩到的正是这一脚——先写了 `userPromptSubmit`（Claude 一族的拼法，也是最
 * 自然的猜法），配置被接受，事件一次都没到。真名是 `userPromptSubmitted`。
 *
 * 所以上面每个名字都来自它自己的配置 schema，而不是从别家 Provider 的拼法推导。"静默丢弃"意味着
 * **装错了没有任何信号**——没有守卫的话，下一个人照着 Claude 抄一个名字进来，测试全绿、上线全哑。
 * `test/providers/copilot.test.ts` 因此逐字钉住这十个名字。
 *
 * 剩下五个刻意不装：`sessionEnd`（会话终结不是轮次事实，与 droid/Gemini 同一判断）、
 * `userPromptTransformed`（同一句 prompt 的第二次投递，装了会让一轮的起点落两条）、
 * `preMcpToolCall`（同一次 MCP 调用会先过它再走 `preToolUse`，两条都算事前会重复计一次执行）、
 * `errorOccurred`（一次**模型调用**失败，不是工具失败，Core 今天没有判断需要它）、
 * `notification`（Copilot 自己的系统通知，与 Agent 在干什么无关）。
 */

/**
 * Copilot 的 hook 合同。
 *
 * **负载键两侧都是 camelCase**（`toolName`/`toolArgs`/`toolResult`/`transcriptPath`/`agentId`），
 * 与 Cursor 恰好相反——Cursor 的事件名是 camelCase 而负载键是 snake_case。"事件名像"推不出
 * "负载键像"，这也是 normalizer 需要读两族拼法的原因（既有读取顺序已覆盖 camelCase，不需要专属分支）。
 *
 * 每个事件的负载都是**强类型的**：实测把一个超集对象喂进去，只有该事件声明过的字段能穿过来，其余被
 * 悄悄剥掉。所以"负载里有什么"不是开放集合，而是逐事件固定的一小组——这正是可以钉死的东西。
 *
 * 三个基础键每个事件都有：`sessionId`/`timestamp`/`cwd`。注意是 **`cwd`**，不是它 SDK 那侧的
 * `workingDirectory`：同一个 CLI 的两条 hook 通道（shell 命令 / SDK JS 回调）负载拼法不同，
 * 照 SDK 的键读 shell 负载会读到 undefined。
 *
 * `agentStop` 判 done：它是一轮收尾。它**没有** Claude 的 `StopFailure`/grok 的 `stop_cancelled`
 * 那种第二收尾事件（十五个键里没有），所以不必照抄那两家的多条 done 规则。
 *
 * `permissionRequest` 判 waiting 而非 working：这一刻 Copilot 正把这次调用按住等一个决定。我们不回
 * 决定，于是它会落到 Copilot 自己的 TUI 提示上等用户——那正是 waiting 的定义。判成 working 会让
 * 「等我点一下」和「正在干活」在界面上长得一模一样（与 Cursor 的两个授权门同一判断）。
 */
export const COPILOT_HOOKS: AgentNativeHookSpecification = {
  // 事件名靠 `--event` 旗标送达（负载不带任何事件名键，见 createCopilotManagedHookPlan 的说明）。
  eventNameSource: { kind: 'flag' },
  rules: [
    // 授权门：Copilot 正等一个决定。
    { events: ['permissionRequest'], state: 'waiting' },
    { events: ['agentStop'], state: 'done' },
    {
      events: [
        'sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse',
        'postToolUseFailure', 'subagentStart', 'preCompact'
      ],
      state: 'working'
    }
  ],
  // 子代理按**名字**记账，不是按 id：实测 `subagentStart` 的负载只有 `transcriptPath` + `agentName`，
  // **没有** `agentId`（`subagentStop` 两个都有）。记账要求 start 与 stop 认同一个键才能加一减一，
  // 于是唯一两端都在的键是 `agentName`。后果是同名子代理并发时会记成一个——这是上游负载的事实，
  // 不是这里可以补的：拿 `agentId` 记账会让每个 start 都记不上、每个 stop 都减一个不存在的条目。
  // 与 Kimi 同一形状、同一取舍。
  subagentTracking: {
    startEvents: ['subagentStart'],
    stopEvents: ['subagentStop'],
    mainStopEvents: ['agentStop'],
    idKeys: ['agentName']
  },
  // 负载键是 camelCase `sessionId`/`transcriptPath`（实测）。**不**声明 requireTranscriptPath：
  // `transcriptPath` 只在 stop 一族事件上出现，`sessionStart` 那条没有它。
  nativeHandle: {
    sessionIdKeys: ['sessionId'],
    transcriptPathKeys: ['transcriptPath']
  }
}

/**
 * Copilot 的配置根目录。
 *
 * 逐字实现它自己的解析：`configDir ?? COPILOT_HOME ?? join(homedir(), '.copilot')`，且**空串等于
 * 没设**（它自己的判断是 `if (t === undefined || t === "")`）。忽略 `COPILOT_HOME` 会让设了该变量的
 * 用户拿到一份 Copilot 永远不读的配置——表现出来是「hooks 装了但一个事件都没有」。
 *
 * `--config-dir` 那条旗标在它的 `--help` 里已标注 deprecated 并指向 `COPILOT_HOME`，所以这里只认
 * 环境变量，不去接一个正在被上游淘汰的旗标。
 */
function copilotHome(env?: Readonly<Record<string, string>>): string {
  const override = env?.COPILOT_HOME?.trim()
  return override ? resolve(override) : join(homedir(), '.copilot')
}

/**
 * Copilot 的 managed hook 计划。
 *
 * **装到一份自己独占的文件**：`<copilot-home>/hooks/agentmux.json`。实测这个目录下的**任意文件名**
 * 都会被加载（不是只认某个固定名），所以 AgentMux 可以整文件拥有，永远不必碰用户的
 * `<copilot-home>/config.json`——那份文件的 `hooks` 键是它的另一条用户级通道，同时还装着用户的模型、
 * 授权规则等一切设置。这与 grok 的做法是同一个模式，也是为什么这里**不需要**合并策略：
 * 没有第二个写者，整文件替换就是正确且最简的实现。
 *
 * **绝不写仓库层的 `.github/hooks/*.json`**：那是会被提交进用户仓库的文件（它也读那一层）。
 *
 * `version: 1` 是必需值——实测 schema 逐字 `version: Invalid literal value, expected 1`。它在缺席时
 * 可以通过，但既然真实合同是 1，写出来比省掉好：省掉是让一份配置的合法性依赖一个默认值。
 *
 * `matcher` **是正则**，不是 glob：实测 `'*'` 被当作无效正则拒掉（整个桶失效），`'.*'` 正常。这一脚
 * 与 droid 那边刚好相反（droid 的 `'*'` 是合法 glob），所以两家不能互抄这个字面量。只在两个工具事件
 * 上写它——它测的是工具名，别处写是噪音。
 *
 * `timeoutSec`（不是 `timeout`）：这个 CLI 的字段名带单位后缀，写 `timeout` 会被剥掉，然后整条 hook
 * 用它自己的默认超时——不是报错，是静默换了行为。这个键拼法不再在这里手写：它是
 * `HOOK_COMMAND_TIMEOUT_FIELD.copilot` 的 SSOT 值，由 `hookCommandTimeout('copilot')` 连同值一起派生
 * 进本条（见 shared.ts）。
 *
 * **每条命令都带 `--event <eventName>`**：这是本 task 修的真缺陷。Copilot 的负载键两侧都是 camelCase
 * （`toolName`/`toolArgs`/`toolResult`），**不含** `hook_event_name`/`hookEventName`/`eventName` 三拼法里
 * 的任何一个（本机 runtime 实测的负载形状，见 `test/providers/copilot.test.ts` 的 fixture）。于是它既不像
 * claude 那样靠负载自带事件名，也此前没有 `--event`——`agentmux-hook.js` 子进程三条来源全落空，
 * `eventName` 解析成 null，整条 POST 被 `if (url && token && eventName)` 静默跳过：Copilot 的 Agent
 * 「装上了但永远不动」（时间线空、状态永不变、无法 resume），而所有测试照旧全绿。
 *
 * 修法与 cursor/antigravity 同构：把事件名从配置侧用 `--event` 显式传给子进程。负载既然不带事件名，
 * 这是唯一可行的来源（不能编一个负载里不存在的键）。**一处未能在本机闭环的经验事实**：Copilot 的 CLI
 * bundle 不在本机（只有 `config.json` 与日志，无 prebuilds/runtime），所以没法把「命令串尾部追加
 * `--event` 后仍被原样执行」这一步再跑一遍捕获。但它落在 antigravity 已经验证过的**同一个**
 * `{type:'command', command}` 形状上——antigravity 正是往这个形状的 command 尾部追加 `--event`（见
 * antigravity.ts），而 payload 通道对 Copilot 是明确关死的，故这是仅有且方向正确的修法。
 */
export function createCopilotManagedHookPlan(env?: Readonly<Record<string, string>>): AgentManagedHookPlan {
  const command = managedHookCommand('copilot')
  const hooks = Object.fromEntries(COPILOT_HOOK_EVENTS.map((eventName) => [eventName, [{
    ...(eventName === 'preToolUse' || eventName === 'postToolUse' ? { matcher: '.*' } : {}),
    // 事件名靠 `--event` 传：Copilot 的负载里没有任何事件名键（见文件头的实测记录），少了它每条事件
    // 到子进程都解析不出事件名、整条 POST 被静默丢弃。与 antigravity/cursor 同一修法。
    hooks: [{ type: 'command', command: `${command} --event ${eventName}`, ...hookCommandTimeout('copilot') }]
  }]]))
  return {
    providerId: 'copilot',
    mutations: [{
      path: join(copilotHome(env), 'hooks', 'agentmux.json'),
      content: `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`,
      mode: 0o600
    }]
  }
}

export function createCopilotProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'copilot', label: 'Copilot', executable: 'copilot', expectedProcess: 'copilot',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      // `--help` 逐字：`-r, --resume [value]`、`--continue`、`--session-id <id>`。恢复走 `--resume`
      // 并直传 session id；`--session-id` 是**给新会话指定 id**，不是恢复（与 grok 同一区分）。
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      // `--acp`（"Start as Agent Client Protocol server"）在这个 CLI 里**真的存在**，但 AgentMux
      // 今天没有任何 Provider 声明 `acpStrategy: {kind:'adapter'}`，那条通路一端还没有。声明一个
      // 接不上的能力比不声明更坏：它会让上层以为可以走 ACP。按「未核实就不声明」如实留 none。
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        // observe 而非 respond：`preToolUse`/`permissionRequest` 确实能回决定（stdout 上的
        // `hookSpecificOutput`，或退出码 2），但那要求这条 fire-and-forget 的 hook 变成一条阻塞
        // RPC、把执行按住等用户点击。那条通路今天不存在。AgentMux 靠 PTY 注入按键回答授权提示。
        permission: 'observe',
        providerResume: true,
        // **没有工具关联 id**：实测 `preToolUse`/`postToolUse` 的负载都只有 `toolName`/`toolArgs`
        // （`postToolUse` 另带 `toolResult`），一次调用的两端拿不到同一个 id。它的 SDK 类型里只有
        // `PreMcpToolCallHookInput` 有 `toolCallId`，那是 MCP 那条路、且只有事前一侧。
        // 于是一次调用在时间轴上是两行而不是一行——与 droid 同一个已知损失，如实声明为 none。
        replyCorrelation: 'none'
        // usage 刻意不声明：收尾负载（`agentStop`）里只有 `stopReason`/`transcriptPath`，**没有任何
        // token 字段**。它报 transcript 路径，但那份文件的格式未经核实，今天两个 reader
        // （claude-jsonl / codex-rollout）都不能假定适用。按「未核实就不声明」留空。
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: COPILOT_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  })
}
