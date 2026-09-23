import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { readOpenCodeSessionHistoryPage } from './opencode-native-history.js'
import { catalog } from './shared.js'

export { readOpenCodeSessionHistoryPage } from './opencode-native-history.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * OpenCode 投递的事件名。
 *
 * 证据是**上游自己的源码**（`home//proj/github/opencode`，本机可读），不是任何第三方项目的
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

function isChildPayload(payload: Readonly<Record<string, unknown>>): boolean {
  if (typeof payload.parentID === 'string' && payload.parentID.trim().length > 0) return true
  const info = typeof payload.info === 'object' && payload.info ? (payload.info as Record<string, unknown>) : undefined
  if (typeof info?.parentID === 'string' && info.parentID.trim().length > 0) return true
  return false
}

export const OPENCODE_HOOKS: AgentNativeHookSpecification = {
  rules: [
    // 授权门：Agent 正卡在一个授权决定上等人回答。
    { events: ['permission.updated'], state: 'waiting', lifecycleEvent: 'permission-request' },
    // session.status 细化谓词：busy -> working (turn-start), retry -> working, idle -> neutral unknown (null)
    {
      events: ['session.status'],
      matches: (payload) => {
        const status = typeof payload.status === 'object' && payload.status ? (payload.status as Record<string, unknown>).type : undefined
        return status === 'busy'
      },
      state: 'working',
      lifecycleEvent: 'turn-start'
    },
    {
      events: ['session.status'],
      matches: (payload) => {
        const status = typeof payload.status === 'object' && payload.status ? (payload.status as Record<string, unknown>).type : undefined
        return status === 'retry'
      },
      state: 'working'
    },
    {
      events: ['session.status'],
      matches: (payload) => {
        const status = typeof payload.status === 'object' && payload.status ? (payload.status as Record<string, unknown>).type : undefined
        return status === 'idle'
      },
      state: 'unknown',
      lifecycleEvent: null
    },
    { events: ['session.idle'], state: 'unknown', lifecycleEvent: null },
    // 干活中。permission.replied 表示决定已经给出、执行随即继续。
    { events: ['message.part.updated', 'permission.replied', 'session.compacted'], state: 'working' },
    { events: ['session.error'], state: 'unknown' }
  ],
  subagentSubject: isChildPayload,
  nativeHandle: {
    sessionIdKeys: ['sessionID']
  },
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

function adaptOpenCodePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...payload }
  const part = typeof payload.part === 'object' && payload.part ? (payload.part as Record<string, unknown>) : undefined
  if (part) {
    if (part.type === 'tool') {
      if (typeof part.tool === 'string') result.tool_name = part.tool
      if (typeof part.callID === 'string') result.call_id = part.callID
      const state = typeof part.state === 'object' && part.state ? (part.state as Record<string, unknown>) : undefined
      if (state) {
        if (state.input !== undefined) result.tool_input = state.input
        if (state.status === 'completed') {
          result.tool_output = state.output ?? ''
        } else if (state.status === 'error') {
          result.error = state.error ?? 'Tool failed'
          result.is_error = true
        }
      }
    } else if (part.type === 'text' && typeof part.text === 'string') {
      const time = typeof part.time === 'object' && part.time ? (part.time as Record<string, unknown>) : undefined
      if (time?.end !== undefined && part.synthetic !== true && part.ignored !== true) {
        result.last_assistant_message = part.text
      }
    }
  }
  return result
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
 * 扩展名用 `.js` 而非 `.ts`：glob 两者都收，但 `.ts` 会让这份内容看起来可以用 TS语法，而它实际上是
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
  const provider = defineAgentProvider({
    planManagedHooks: ({ env, endpoint }) => endpoint ? createOpenCodeManagedHookPlan(endpoint.url, endpoint.token, env) : null,
    catalog: catalog({
      id: 'opencode', label: 'OpenCode', executable: 'opencode', expectedProcess: 'opencode',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        replyCorrelation: 'none'
      }
    }),
    readSessionHistoryPage: readOpenCodeSessionHistoryPage,
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: OPENCODE_HOOKS,
    inspectHookActivation: async (context) => {
      const target = context.plan.mutations[0]
      if (!target) return { active: false, code: 'HOOK_PLAN_EMPTY', action: 'The managed Hook plan is empty.' }
      if (!existsSync(target.path)) {
        return {
          active: false,
          code: 'HOOK_CONFIGURATION_CHANGED',
          action: 'The managed Hook configuration changed during inspection. Inspect this scope again.'
        }
      }
      return {
        active: false,
        code: 'HOOK_ACTIVATION_NEEDS_EVIDENCE',
        action: 'OpenCode managed Hook plugin is present on disk, but live runtime activation in the current environment has not been established. Terminal interactions and prompt submissions remain available.'
      }
    },
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--session', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  })

  return {
    ...provider,
    normalizeHook(envelope, context) {
      const payload = envelope.payload ?? {}
      const nativeHandle = context.nativeHandle
      const trustedRootSessionId = nativeHandle?.sessionId
      const sid = typeof payload.sessionID === 'string' && payload.sessionID.trim().length > 0
        ? payload.sessionID.trim()
        : undefined
      const isChild = isChildPayload(payload)
      const isRoot = sid !== undefined && trustedRootSessionId !== undefined && sid === trustedRootSessionId && !isChild

      const adapted = adaptOpenCodePayload(payload)
      const normalized = provider.normalizeHook({ ...envelope, payload: adapted }, context)

      if (isRoot && nativeHandle) {
        return {
          ...normalized,
          nativeHandle
        }
      }

      const {
        nativeHandle: _nh,
        turnUsage: _tu,
        interaction: _ix,
        interactionCompletion: _ic,
        lifecycleEvent: _le,
        ...fenced
      } = normalized

      return {
        ...fenced,
        lifecycleEvent: null,
        semanticState: 'unknown',
        status: {
          ...normalized.status,
          state: 'running'
        }
      }
    }
  }
}
