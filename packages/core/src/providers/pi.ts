import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog } from './shared.js'
import { readPiSessionHistoryPage } from './pi-native-history.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * Pi 扩展订阅的事件名。
 *
 * 证据是**上游自己的源码**（`home//proj/github/pi`，即 `earendil-works/pi`，本机可读），
 * 不是任何第三方项目的转述：每个名字都是 `ExtensionAPI.on()` 的一个重载签名，逐字取自
 * `packages/coding-agent/src/core/extensions/types.ts:1282-1298`。
 *
 * 只订阅七个。上游的事件全集是 30+ 个（`ExtensionEvent` 联合体，`types.ts:1086-1113`），其余的要么
 * 与「Agent 在干什么」无关（`model_select`/`thinking_level_select`/主题与 UI 那批），要么是需要**返回值**
 * 才有意义的拦截点（`context`/`before_provider_request`/`input`——它们的 handler 返回值会改写 Pi 的行为）。
 * 我们是被动观察者，只订阅纯通知型事件。
 */
export const PI_HOOK_EVENTS = [
  'before_agent_start', 'agent_start', 'tool_call', 'tool_execution_start',
  'tool_execution_end', 'message_end', 'agent_settled'
] as const

/**
 * Pi 的 hook 合同。
 *
 * - `agent_settled` 在 `_runAgentPrompt` 的 finally 块触发（active=false），标志 prompt 循环
 *   （含 auto-retry 与 compaction）完全终止，统一发出 `turn-end` 以便建立提示就绪并放行后续输入。
 * - 真实最终成功仅当最后一轮 assistant 消息 `stopReason === 'stop'` 时判 `done`；
 *   `stopReason === 'error'` 判 `error`；
 *   `aborted`、`length` 或缺失结果判中立 `unknown`，绝不谎报成功。
 * - active 状态（before_agent_start, agent_start, tool_call, tool_execution_*, message_end）为 `working`。
 * - Pi 自身无交互权限事件，catalog.permission 记 `none`；工具与轮次无双向关联，replyCorrelation 记 `none`。
 */
export const PI_HOOKS: AgentNativeHookSpecification = {
  rules: [
    // stop: 正常成功收尾
    {
      events: ['agent_settled'],
      matches: (payload) => payload.stopReason === 'stop',
      state: 'done',
      lifecycleEvent: 'turn-end'
    },
    // error: 明确报错收尾
    {
      events: ['agent_settled'],
      matches: (payload) => payload.stopReason === 'error',
      state: 'error',
      lifecycleEvent: 'turn-end'
    },
    // aborted / length / 缺结果：循环已结束 (active=false)，收尾显式 turn-end，不阻碍后续输入
    {
      events: ['agent_settled'],
      state: 'unknown',
      lifecycleEvent: 'turn-end'
    },
    // 工作中事件
    {
      events: [
        'before_agent_start', 'agent_start', 'tool_call',
        'tool_execution_start', 'tool_execution_end', 'message_end'
      ],
      state: 'working'
    }
  ],
  nativeHandle: {
    sessionIdKeys: ['session_id'],
    transcriptPathKeys: ['session_file'],
    // Pi 的 resume 只认 transcript 路径（见 buildResumeArgs），所以 session_file 缺席时整个 handle
    // 都不成立——留一个只有 session_id 的 handle 会让 resume 在事后才发现自己没有可用的定位符。
    // 这一条与扩展侧「文件真存在才上报 session_file」是同一个约束的两端，缺一不可，见下面那段。
    requireTranscriptPath: true
  },
  // Pi 的 hook 面是一份 AgentMux 生成的扩展文件，跑在 pi 进程里**自己直接 POST**
  // （见下面 `piExtensionSource` 的 `post()`：body 里 `eventName` 是生成时写死的实参）。
  // `agent-hook-command` 那个子进程整个不在这条链路上，所以既谈不上 `--event` 旗标，也谈不上
  // 「从负载里解析出事件名」——事件名是结构性在场的，不是解析出来的。
  eventNameSource: { kind: 'generated-code' }
}

/**
 * Pi 系（Pi / OMP / Prime）的扩展目录解析。
 *
 * 三家共用**同一套扩展 API 与同一个目录合同**，只有两个参数不同：环境变量名与默认配置目录名。这不是
 * 从相似性推断出来的——上游把配置目录名做成了 package.json 的一个字段：`CONFIG_DIR_NAME` 取自
 * `pkg.piConfig?.configDir`，缺省 `.pi`（`packages/coding-agent/src/config.ts:500`），而 env 变量名由
 * `APP_NAME` 派生：`ENV_AGENT_DIR = \`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR\``（`config.ts:504`）。
 * 换句话说，一个 Pi 的下游分发只要改 `piConfig`，就得到自己那一套目录与变量名——OMP 与 Prime 正是
 * 这样的分发。
 *
 * 解析顺序逐字实现 `getAgentDir()`（`config.ts:524-530`）：先读该家自己的 env，否则
 * `~/<configDir>/agent`。扩展落在它下面的 `extensions/`（`loader.ts:784`）。
 *
 * **绝不跨家兜底**：Pi 的目录找不到时不去看 OMP 的，反之亦然。装错目录不会报错，只会让 AgentMux 的
 * 扩展出现在另一家的加载路径里——同时遮蔽那一家的用户扩展，且两边都毫无征兆。所以每家只解析自己的
 * 那一条，解析不到就用自己的默认值建它。
 */
function piFamilyExtensionDir(
  agentDirEnv: string,
  configDirName: string,
  env?: Readonly<Record<string, string>>
): string {
  const override = env?.[agentDirEnv]?.trim()
  const agentDir = override ? resolve(override) : join(homedir(), configDirName, 'agent')
  return join(agentDir, 'extensions')
}

/**
 * 写进扩展文件的 JS 源码。
 *
 * 与 opencode 的插件同属「内容不是 shell 命令的 managed hook」，但**两者取 endpoint 的方式相反**，
 * 原因是运行位置不同：
 *
 *   - opencode 的插件跑在 **OpenCode 自己的进程**里，那个进程不是 AgentMux 起的，看不到我们注入 PTY
 *     的环境变量，所以 endpoint 与 token 必须在安装那一刻内联进文件；
 *   - Pi 的扩展跑在 **AgentMux 通过 PTY 起的 `pi` 进程**里（上游确认扩展只在主进程加载，没有任何
 *     worker/daemon 会再加载一遍——`resource-loader.ts:559`/`:579`/`:599` 是唯二调用点），因此
 *     `process.env.AGENTMUX_HOOK_URL`/`TOKEN` 直接可读（由 `client.ts:2123-2124` 注入）。
 *
 * 于是这里**在运行时读环境变量，绝不把 token 写进磁盘**。这不是风格选择：写进去的 token 会随文件长期
 * 留在用户 home 下，而且每次 Binding 轮换都会失效——变成一份既泄密又过期的死凭证。能不落盘就不落盘。
 *
 * 这也让同一份文件对所有 Run 都成立：它不绑定任何一次会话，可以真正幂等地装一次。
 *
 * 装载合同逐条对齐上游，每一条猜错都是静默失败：
 *
 * - **默认导出必须是函数**：加载器取 `{ default: true }` 再判 `typeof factory !== "function"`
 *   （`loader.ts:510-514`），不是函数就整个模块被跳过并报 "Extension does not export a valid factory
 *   function"。所以这里是 `export default function (pi) {...}`——注意与 opencode 相反，那边要的是
 *   **具名** `server` 导出。
 * - **`.js` 可以**：`isExtensionFile` 收 `.ts` 与 `.js`（`loader.ts:666-668`）。用 `.js` 如实表达
 *   「这就是被原样执行的 JS」，不需要 TS 语法。
 * - **一层目录、直接文件即可**：`discoverExtensionsInDir` 只扫一层，`extensions/*.js` 直接命中
 *   （`loader.ts:735-737`），不需要建子目录或 package.json。
 * - **加载失败不是永久缓存的**：只有成功才写进 `extensionCache`（`loader.ts:515-517`），失败会在下次
 *   加载时重试。这比 opencode 宽松，但不构成写更脆代码的理由。
 *
 * 投递是 fire-and-forget 且**整体 catch**：Pi 会 `await` 扩展的 handler（`runner` 逐个 await），一次
 * 网络失败绝不能把用户的会话打断，也不能让它等。丢事件比卡住好。
 *
 * **fs 必须用静态 `import`，绝不能用 `require`。** 加载器是 jiti（`loader.ts:498-510`），它在非二进制
 * 分发下不强制 `tryNative: false`，也就是说这份 `.js` 可能被**原生 ESM** 加载——那里 `require` 根本不
 * 存在。这个错误极其隐蔽：`require` 抛的是 ReferenceError，被 `sessionFields` 里那个 `catch` 吞掉，
 * `exists` 永远是 false，于是 `session_file` 一次都不上报；再叠加 `requireTranscriptPath: true`，
 * 每个 handle 都被丢弃，Pi 的 resume **永久不可用**，而且全程没有任何报错。
 *
 * 实测过（`node` 原生 ESM 载入生成的模块，喂一个真实存在的文件）：用 `require` 时 `session_file`
 * 缺席，`typeof require === 'undefined'`。静态 import 两条路都成立——jiti 转译 CJS 时会把它降成
 * require，原生 ESM 下就是原生 import。
 */
function piExtensionSource(): string {
  return `// AgentMux managed extension. Generated — edits are overwritten on reinstall.
import { existsSync } from 'node:fs'

export default function (pi) {
  // session_file 只有在 transcript **真的落盘之后**才上报。
  //
  // 上游在会话创建时就把路径算出来并从 getSessionFile() 返回（session-manager.ts:954），但文件要等
  // 第一条 assistant 消息到达才被创建（:1031 的 openSync(..., "wx")）。所以一轮刚开始时那条路径指向
  // 一个不存在的文件——照报的话，AgentMux 会拿它当可 resume 的 handle，而 \`pi --session <path>\` 会
  // 打不开。每次投递都重新 existsSync，让第一条 assistant 消息落盘后的那一刻自动转为可恢复。
  function sessionFields(ctx) {
    const manager = ctx && ctx.sessionManager
    if (!manager) return {}
    const sessionId = manager.getSessionId && manager.getSessionId()
    if (typeof sessionId !== 'string' || !sessionId) return {}
    const sessionFile = manager.getSessionFile && manager.getSessionFile()
    if (typeof sessionFile !== 'string' || !sessionFile) return { session_id: sessionId }
    let exists = false
    try {
      exists = existsSync(sessionFile)
    } catch {
      exists = false
    }
    return exists ? { session_id: sessionId, session_file: sessionFile } : { session_id: sessionId }
  }

  function post(eventName, ctx, extra) {
    // endpoint 每次现读：扩展在 pi 进程内常驻，而这个进程是 AgentMux 起的，环境变量在其生命周期内稳定。
    const url = process.env.AGENTMUX_HOOK_URL
    const token = process.env.AGENTMUX_HOOK_TOKEN
    if (!url || !token) return
    const payload = { hook_event_name: eventName }
    const session = sessionFields(ctx)
    for (const key in session) payload[key] = session[key]
    if (extra) for (const key in extra) payload[key] = extra[key]
    // 不 await：Pi 会 await 每个 handler，投递挂在事件回路上会让用户的会话等我们的网络。
    void fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: crypto.randomUUID(), eventName: eventName, payload: payload }),
      signal: AbortSignal.timeout(2000)
    }).catch(() => {
      // 投递失败就丢这一条。绝不让状态上报打断用户的会话。
    })
  }

  let lastAssistant = null

  pi.on('before_agent_start', (event, ctx) => {
    lastAssistant = null
    post('before_agent_start', ctx, { prompt: (event && event.prompt) || '' })
  })
  pi.on('agent_start', (_event, ctx) => {
    lastAssistant = null
    post('agent_start', ctx)
  })
  // tool_call 的参数在 \`input\`，tool_execution_start 的在 \`args\`——两者的**工具名**都叫 toolName，
  // 但参数字段名不同（types.ts:889-896 对 :798-803）。都投成 tool_name/tool_input，让归一化层按
  // 它既有的两族拼法读到（hook-normalizer 的 stringField 已认 tool_name/toolName）。
  pi.on('tool_call', (event, ctx) => { post('tool_call', ctx, { tool_name: event.toolName, tool_input: event.input }) })
  pi.on('tool_execution_start', (event, ctx) => { post('tool_execution_start', ctx, { tool_name: event.toolName, tool_input: event.args }) })
  pi.on('tool_execution_end', (event, ctx) => { post('tool_execution_end', ctx, { tool_name: event.toolName }) })
  pi.on('message_end', (event, ctx) => {
    const msg = event && event.message
    const manager = ctx && ctx.sessionManager
    const sessionId = manager && manager.getSessionId && manager.getSessionId()
    if (msg && msg.role === 'assistant' && typeof sessionId === 'string' && sessionId) {
      lastAssistant = {
        sessionId: sessionId,
        stopReason: msg.stopReason,
        errorMessage: msg.errorMessage
      }
    }
    const extra = msg ? {
      role: msg.role,
      stopReason: msg.stopReason,
      errorMessage: msg.errorMessage
    } : undefined
    post('message_end', ctx, extra)
  })
  // 最终 quiescence：循环结束。上报当前会话最后一轮 assistant 结果，区分 stop / error / unknown。
  pi.on('agent_settled', (_event, ctx) => {
    const manager = ctx && ctx.sessionManager
    const sessionId = manager && manager.getSessionId && manager.getSessionId()
    const match = lastAssistant && typeof sessionId === 'string' && sessionId && lastAssistant.sessionId === sessionId
    const extra = match && lastAssistant.stopReason ? {
      stopReason: lastAssistant.stopReason,
      errorMessage: lastAssistant.errorMessage
    } : undefined
    post('agent_settled', ctx, extra)
  })
}
`
}

/**
 * Pi 的 managed hook 计划。
 *
 * 装到 `<agent-dir>/extensions/agentmux.js` —— 一份 AgentMux 独占的文件，所以**不需要合并策略**：
 * 上游按目录扫每个 `.ts`/`.js`（`loader.ts:735-737`），用户自己的扩展是同目录下的别的文件，我们整文件
 * 拥有自己这一个，两边互不相干。与 opencode 的插件、Copilot 的 `hooks/agentmux.json` 同一模式。
 *
 * 不需要 endpoint 参数：内容在运行时从环境变量取（见 `piExtensionSource` 那段），所以修复路径（没有
 * Binding）也能照常产出一份完全有效的 plan。
 */
export function createPiManagedHookPlan(env?: Readonly<Record<string, string>>): AgentManagedHookPlan {
  return {
    providerId: 'pi',
    mutations: [{
      path: join(piFamilyExtensionDir('PI_CODING_AGENT_DIR', '.pi', env), 'agentmux.js'),
      content: piExtensionSource(),
      mode: 0o600
    }]
  }
}

export function createPiProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    planManagedHooks: ({ env }) => createPiManagedHookPlan(env),
    readSessionHistoryPage: readPiSessionHistoryPage,
    catalog: catalog({
      composer: {"skillRoots": [".pi/agent/skills", ".agents/skills"], "commands": [{"text": "/help", "description": "Available commands"}, {"text": "/model", "description": "Choose model"}, {"text": "/compact", "description": "Compact context"}]},
      id: 'pi', label: 'Pi', executable: 'pi', expectedProcess: 'pi', promptDelivery: 'positional-argv',
      // `explicit-managed` 而非此前的 `unmanaged`：AgentMux 现在真的把状态扩展装进 Pi 的扩展目录。
      // 之前记 unmanaged 是因为没有第一方证据能确定装载合同（目录、导出形状、可用事件名）；这些现在
      // 逐条来自上游源码，见上面各段的引用。
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'transcript-path' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        // `none` 而非 observe：Pi 没有任何可订阅的授权/等待事件（`types.ts` 里没有 permission 族；
        // `ui_prompt_*` 只在扩展自己弹窗时发，见 PI_HOOKS 那段）。声明 observe 会是一句
        // 「我们看得见它在等人」的谎。
        permission: 'none',
        providerResume: true,
        // 工具调用两端确实带同一个 `toolCallId`（`types.ts:889-892`/`:798-803`/`:815-821`），但我们
        // 今天没有把它投递上来（payload 只放 tool_name/tool_input）。按「未接线就不声明」记 none；
        // 要改成有关联，得先在扩展源码里把 toolCallId 投出来，两处一起改。
        replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: PI_HOOKS,
    buildResumeArgs: (_sessionId, transcriptPath, prompt, args) => {
      // 与「handle 属于别的 Provider」共用一个错误码，故必须靠 detail 分辨：这里是 Provider 对得上、
      // 但它要的 transcript 路径没到（Pi 的 resume locator 是 session_file，不是 session id）。
      // 该做的事也不同——等 hook 报出 session_file，而不是刷新会话。
      //
      // 这条路径在真实时序里会命中：扩展只在 transcript 真落盘后才报 session_file（见扩展源码那段），
      // 所以一轮里第一条 assistant 消息之前，handle 就是缺 transcriptPath 的。
      if (!transcriptPath) {
        throw new AgentMuxError(
          'Pi resume requires its hook-reported session file.',
          'INVALID_NATIVE_SESSION_HANDLE',
          'providerId=pi resumeLocator=transcript-path missingField=transcriptPath reason=hook-has-not-reported-session-file'
        )
      }
      // `--session <path>` 接受一个 transcript 路径（`cli/args.ts:123-124` 解析，`main.ts:385-391`
      // 经 resolveSessionPath 后 openSessionOrExit 打开它）。**不是** `--session-id`（:125-126，那个
      // 是给会话取 id，不是恢复）。
      return ['--session', transcriptPath, ...args, ...(prompt ? [prompt] : [])]
    }
  })
}
