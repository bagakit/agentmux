import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * OpenCode 投递的事件名。
 *
 * 证据是**上游自己的源码**（`/Users/bytedance/proj/github/opencode`，本机可读），不是任何第三方项目的
 * 转述：事件联合体在 `packages/sdk/js/src/gen/types.gen.ts:704-736`（28 个成员），每个成员的形状是
 * `{ type, properties }`。下面的名字逐字取自那份生成类型，一个都不是推导出来的。
 *
 * 这里**不做名字翻译**。参考实现会把 `session.idle` 改写成 `SessionIdle` 之类的合成名再投递；那样做
 * 会把 SSOT 从上游类型挪到我们自己的一张翻译表上——上游改名时翻译表不会报错，只会静默失配。透传真名
 * 让这份声明与 `types.gen.ts` 直接对齐，与 Pi/Hermes 用 Provider 原生事件名的做法也一致。
 */
export const OPENCODE_HOOK_EVENTS = [
  'session.status', 'session.idle', 'message.part.updated',
  'permission.updated', 'permission.replied', 'session.compacted', 'session.error'
] as const

/**
 * 为什么 done 同时挂在 `session.status` 与 `session.idle` 两个名字上。
 *
 * 上游把一次「转为空闲」发成**两条**事件，且顺序固定（`packages/opencode/src/session/status.ts:41-45`）：
 *
 * ```ts
 * yield* events.publish(Event.Status, { sessionID, status })   // 先 session.status
 * if (status.type === "idle") {
 *   yield* events.publish(Event.Idle, { sessionID })           // 再 session.idle
 * }
 * ```
 *
 * 而 `session.idle` 在 schema 里**已标注废弃**（`packages/schema/src/session-status-event.ts:43` 那行
 * 逐字 `// deprecated`），`session.status` 是继任者。
 *
 * 于是只押一个都会坏：只押 `session.idle`，上游哪天真删掉它，done 就静默消失——不报错、不告警，只是
 * 会话永远停在 working；只押 `session.status`，它在**每次状态变化**时都发（含 `busy`），判 done 会让
 * 一轮刚开始就被判成结束。
 *
 * 本可以读负载里的 `status.type === 'idle'` 来精确区分，但 `eventState` 的规则匹配只看事件名
 * （`hook-normalizer.ts:187-198`，除 `toolNames` 外不读负载）。在不改归一化层的前提下，正确做法是
 * 认「两条成对到达」这个上游事实：两个名字都判 done，让 `session.status` 承担 `session.idle` 消失后
 * 的续命，同时接受一个已知代价——`session.status(busy)` 也会被判成 done。
 *
 * 这个代价由 `message.part.updated` 抵消：它在模型流式输出期间持续到达（`types.gen.ts:406-412`），
 * 每一条都判 working。真实时序是 status(busy) → 一串 part.updated → status(idle) + idle，所以一轮
 * 开头那次误判会被紧随其后的 part.updated 覆盖回 working，收尾那次才是最终态。
 *
 * 这不是最优解，是**在现有归一化层能力内最诚实的解**：它没有假装能读负载，也没有把一个已废弃的事件
 * 当作唯一依靠。若日后规则支持按负载字段匹配，这里应收敛成单条 `session.status` + `status.type` 判据。
 */
export const OPENCODE_HOOKS: AgentNativeHookSpecification = {
  rules: [
    // 授权门：Agent 正卡在一个授权决定上等人回答。`permission.updated` 的负载是一个完整的
    // `Permission`（`types.gen.ts:423-442`），带 `id`/`sessionID`/`callID`/`title`。
    // 判 waiting 而非 working——与 Copilot 的 `permissionRequest`、Cursor 的两个授权门同一判断。
    { events: ['permission.updated'], state: 'waiting' },
    // 收尾：两个名字都判，理由见上面那段。
    { events: ['session.status', 'session.idle'], state: 'done' },
    // 干活中。`permission.replied`（`types.gen.ts:444-451`）表示决定已经给出、执行随即继续，
    // 所以它是 working 而不是另一种收尾。
    { events: ['message.part.updated', 'permission.replied', 'session.compacted', 'session.error'], state: 'working' }
  ],
  // 子代理不记账：上游 28 个事件里没有任何一对子代理起止事件（`types.gen.ts:704-736` 逐个读过）。
  // 声明一个不存在的记账会让 `applySubagentTracking` 永远等一个不会到来的 stop，把 done 一直压住。
  //
  // native handle 的键是 **`sessionID`（大写 ID）**，不是 `sessionId`。这不是风格问题：
  // `stringField` 按声明的键逐字取值，拼错了取不到，于是每个事件都给不出 handle、resume 整条失效。
  // 上游全库统一大写（`session.idle` 在 `types.gen.ts:479`、`session.status` 在 `:470`）。
  //
  // **不声明 `transcriptPathKeys`**：上游没有单文件 transcript。会话被拆成三组存储键
  // （`storage.ts:150-196`：session/message/part 各一棵），没有任何一个事件负载带得出一条可读路径。
  // 声明一个取不到的键等于让 handle 永远缺一半。
  nativeHandle: {
    sessionIdKeys: ['sessionID']
  },
  // OpenCode 的 hook 面是一份 AgentMux 生成的插件文件，跑在 OpenCode 进程里**自己直接 POST**
  // （见下面 `openCodePluginSource`：body 里 `eventName: event.type` 由生成代码直接给出）。
  // `agent-hook-command` 那个子进程整个不在这条链路上，所以既谈不上 `--event` 旗标，也谈不上
  // 「从负载里解析出事件名」——事件名是结构性在场的，不是解析出来的。
  eventNameSource: { kind: 'generated-code' }
}

/**
 * OpenCode 的配置根目录。
 *
 * 逐字实现上游的解析（`packages/core/src/global.ts:64`）：`OPENCODE_CONFIG_DIR ?? Path.config`，
 * 其中 `Path.config = join(xdgConfig, 'opencode')`（`global.ts:13`，经 `xdg-basedir`），即
 * `XDG_CONFIG_HOME` 未设时为 `~/.config/opencode`。
 *
 * 注意**不是** `OPENCODE_CONFIG`——那个是「单个配置文件」的路径（`flag/flag.ts:21`），不是目录。
 * 认错变量会把插件写进一个 OpenCode 永远不扫的地方，表现为「装了但一个事件都没有」。
 *
 * 上游还会扫项目级 `.opencode/` 与 home 下的 `.opencode/`（`config/paths.ts:23-41`）。这里只装到全局
 * 配置目录一处：项目级安装会把 AgentMux 的插件写进用户仓库（可能被提交），home 级则与全局目录重复
 * 加载同一个插件。装一处、且是用户不会提交的那一处，是唯一无副作用的选择。
 */
function openCodeConfigDir(env?: Readonly<Record<string, string>>): string {
  const override = env?.OPENCODE_CONFIG_DIR?.trim()
  if (override) return resolve(override)
  const xdg = env?.XDG_CONFIG_HOME?.trim()
  return xdg ? join(resolve(xdg), 'opencode') : join(homedir(), '.config', 'opencode')
}

/**
 * 写进插件文件的 JS 源码。
 *
 * **这是本仓第一个内容不是 shell 命令的 managed hook**。其余九家都调 `managedHookCommand()` 往配置里
 * 写一条命令，由 CLI 在事件发生时执行它；OpenCode 没有那条通路——它的 hook 全是同进程 JS 函数
 * （`packages/plugin/src/index.ts:222-335` 的 `Hooks` 接口）。但 `AgentManagedHookMutation` 只要求
 * `{path, content}` 且 `content` 全程按字节处理（`managed-hook-installer.ts:21-31`、`:79-157`），
 * 所以写一个插件文件与写一条命令走的是同一条安装路径，不需要新的 installation 种类。
 *
 * 插件把事件 POST 到 AgentMux 既有的 HTTP ingest——与那九家 shell hook 投递的是**同一个信封、同一个
 * 端点**（`agent-hook-command.ts:183`：`{receiptId, eventName, payload}` + `Bearer` 头）。服务端从
 * token 绑定反查 `providerId`/`runId`/`agentSessionId`（`hook-server.ts:302-304`），不从正文取，所以
 * 一个非 shell 的客户端与 shell 客户端在服务端是同一形状。
 *
 * 装载合同逐条对齐上游，每一条猜错都是静默失败：
 *
 * - **目录**：自动发现的 glob 是 `{plugin,plugins}/*.{ts,js}`（`config/plugin.ts:21`）。单复数都收，
 *   这里用单数 `plugin/`。
 * - **导出必须是函数**：`Plugin` 是**工厂**——`(input, options) => Promise<Hooks>`
 *   （`packages/plugin/src/index.ts:74`），不是 Hooks 对象本身。加载器对模块的每个导出取值判定，
 *   **任何一个非函数导出都会让整个模块抛 `"Plugin export is not a function"`**
 *   （`plugin/index.ts:99-112`）。所以这份源码只导出一个具名函数 `server`，不导出任何常量。
 * - **`server` 具名导出走 v1 路径**（`plugin/index.ts:118`），命中即 `return`，不会再被 legacy 路径
 *   加载一遍——不存在双注册导致事件翻倍。
 * - **ESM + 动态 import**：由 Bun 的 `import()` 加载（`plugin/loader.ts:139`）。**加载失败是永久缓存的**
 *   （`loader.ts:206-207`），所以这份源码必须一次就能被解析：不用任何需要构建的语法，只用 Bun 原生可跑的
 *   ESM。
 * - **事件是按目录过滤的**：监听器丢弃 `event.location?.directory !== ctx.directory` 的事件
 *   （`plugin/index.ts:255-262`），所以插件只会收到它自己那个目录的事件——这正是我们要的。
 *
 * `endpoint`/`token` 在写盘时**内联成字面量**，不从插件进程的环境变量读：插件跑在 OpenCode 自己的进程里，
 * 那个进程不继承 AgentMux 给 PTY 注入的 `AGENTMUX_HOOK_URL`/`AGENTMUX_HOOK_TOKEN`。
 *
 * 投递是 fire-and-forget 且**整体 catch**：插件跑在 Agent 的事件回路里，一次网络失败绝不能把用户的
 * 会话打断。丢事件比抛异常好。
 */
function openCodePluginSource(endpoint: string, token: string): string {
  return `// AgentMux managed plugin. Generated — edits are overwritten on reinstall.
export async function server() {
  const endpoint = ${JSON.stringify(endpoint)}
  const token = ${JSON.stringify(token)}
  const events = new Set(${JSON.stringify([...OPENCODE_HOOK_EVENTS])})
  return {
    event: async ({ event }) => {
      if (!events.has(event.type)) return
      try {
        await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({
            receiptId: crypto.randomUUID(),
            eventName: event.type,
            payload: event.properties ?? {}
          }),
          signal: AbortSignal.timeout(2000)
        })
      } catch {
        // 投递失败就丢这一条。绝不让状态上报打断用户的会话。
      }
    }
  }
}
`
}

/**
 * OpenCode 的 managed hook 计划。
 *
 * 装到 `<config-dir>/plugin/agentmux.js` —— 一份 AgentMux 独占的文件，所以**不需要合并策略**：
 * 上游按 glob 收整个目录下的每个文件（`config/plugin.ts:21`），用户自己的插件是同目录下的别的文件，
 * 我们整文件拥有自己这一个，两边互不相干。这与 Copilot 装到独占 `hooks/agentmux.json` 是同一模式。
 *
 * 扩展名用 `.js` 而非 `.ts`：glob 两者都收，但 `.ts` 会让这份内容看起来可以用 TS 语法，而它实际上是
 * 直接被 `import()` 的源码，写错了是永久缓存的加载失败（`loader.ts:206-207`）。`.js` 如实表达了
 * 「这就是要被原样执行的 JS」。
 */
export function createOpenCodeManagedHookPlan(
  endpoint: string,
  token: string,
  env?: Readonly<Record<string, string>>
): AgentManagedHookPlan {
  return {
    providerId: 'opencode',
    mutations: [{
      path: join(openCodeConfigDir(env), 'plugin', 'agentmux.js'),
      content: openCodePluginSource(endpoint, token),
      mode: 0o600
    }]
  }
}

export function createOpenCodeProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'opencode', label: 'OpenCode', executable: 'opencode', expectedProcess: 'opencode',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      // 恢复走 `--session <id>`（`cli/cmd/run.ts:152-156`，别名 `-s`，描述逐字 "session id to
      // continue"）。**没有 `--resume`**——照别家拼法猜一个会直接报未知参数。
      // `--continue`（`-c`，`:147-151`）是「继续上一个会话」，不接受 id，不是这里要的。
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, hookEvents: true, timeline: 'complete-events',
        // observe 而非 respond：`permission.updated` 能看见 Agent 在等一个授权决定，但回决定要走
        // SDK 的 permission 接口，是另一条通路。今天靠 PTY 注入按键回答，与其余各家一致。
        permission: 'observe',
        providerResume: true, acp: false,
        // 没有工具关联 id：工具调用不是独立事件，而是流式 `message.part.updated` 里的 part
        // （`types.gen.ts:406-412`），一次调用的两端拿不到同一个 id。如实声明 none。
        replyCorrelation: 'none'
        // usage 不声明：没有单文件 transcript（`storage.ts:150-196` 把会话拆成三组存储键），
        // 既有两个 reader（claude-jsonl / codex-rollout）都不适用。按「未核实就不声明」留空。
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: OPENCODE_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--session', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  })
}
