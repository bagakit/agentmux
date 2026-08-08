import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog, managedHookCommand, hookCommandTimeout } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * 写进 `<factory-home>/.factory/hooks.json` 的事件名。
 *
 * 这个 CLI 的事件全集恰好就是九个（本机二进制里的 zod 枚举，同一份枚举同时给配置 schema 与
 * 派发器用）。装其中八个：
 *
 * - `SessionStart`：一轮的开端。负载带 `source`（`startup`/`resume`/…）与 `previous_session_id`。
 * - `UserPromptSubmit`：带 `prompt` 与 `has_images`。
 * - `PreToolUse`/`PostToolUse`：一次工具调用的两端，负载键 `tool_name`/`tool_input`，
 *   `PostToolUse` 另带 `tool_response`（工具返回值）。负载里**没有工具关联 id**——`toolCallId`
 *   走的是派发函数的第四个内部 context 参数，不进负载（二进制里的 `tool_call_id`/`tool_use_id`
 *   分别属于 LLM 消息格式与 OTEL 属性，不是 hook 负载键）。所以一次调用在时间轴上是两行而不是
 *   一行，这是上游负载的事实，不是这里可以补的：编一个 id 键出来只会让关联静默错配。
 * - `Stop`：**一轮**收尾，带 `stop_hook_active`、`tool_execution_count`、`elapsed_time`。
 * - `SubagentStop`：子代理落地。**没有** `SubagentStart` —— 见下方 subagentTracking 那段。
 * - `PreCompact`：压缩前，带 `trigger: 'manual'|'auto'`。压缩期间没有任何工具事件，
 *   少了它长压缩看起来像卡死。
 * - `Notification`：系统通知，带 `notification_type`/`message`。
 *
 * `SessionEnd` 不装：它是**会话**终结（带 `reason`/`session_duration_ms`/`message_count`），
 * 不是轮次事实。判「这一轮结束」靠 `Stop`，会话终结由 PTY 事实回答（那是 ctxmux 的所有权，
 * 不是 Provider 语义）。这与 Gemini 对它自己的 `SessionEnd` 是同一个既定判断。
 *
 * 每个事件的负载都含同一组基础键：`session_id`/`transcript_path`/`cwd`/`permission_mode`/
 * `hook_event_name`。
 */
export const DROID_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'SubagentStop', 'PreCompact', 'Notification'
] as const

export const DROID_HOOKS: AgentNativeHookSpecification = {
  // 事件名随负载到达：每个事件的基础键里都有 `hook_event_name`（见上方 DROID_HOOK_EVENTS 的说明）。
  eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' },
  rules: [
    // 只有一种收尾事件——它没有 Claude/grok 那样的 `StopFailure`/`StopCancelled` 变体
    // （zod 枚举里就这九个），所以不必照抄那两家的多条收尾。
    { events: ['Stop'], state: 'done' },
    {
      events: [
        'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
        'SubagentStop', 'PreCompact', 'Notification'
      ],
      state: 'working'
    }
  ],
  // **不声明 subagentTracking**：事件全集里只有 `SubagentStop`，没有对应的 start。子代理在途记账
  // 要求 start/stop 成对（花名册加一才能减一），只装 stop 会让计数变成负数，并且会压制主 Agent 的
  // 收尾——它会一直等一个永远等不到的减一。与 Hermes 同一个判断。
  //
  // 负载键一律 snake_case，与 Claude 一族逐字相同（`session_id`/`transcript_path`）。
  nativeHandle: {
    sessionIdKeys: ['session_id'],
    transcriptPathKeys: ['transcript_path']
  }
}

/**
 * droid 的 managed hook 计划。
 *
 * 配置文件是 `<factory-home>/.factory/hooks.json`，其中 factory-home 由
 * `FACTORY_HOME_OVERRIDE ?? HOME` 决定（本机二进制里逐字如此，且 `.factory` 是硬编码的目录名）。
 * 尊重这个覆盖变量很重要：忽略它会写出一份该 CLI 永远不读的配置。
 *
 * **顶层结构比 Claude 少一层**：这个文件的顶层键**就是**事件名，不套 `hooks:`
 * （zod：`object({ PreToolUse: array(...).optional(), …, hooksDisabled: boolean().optional() })`）。
 * 每个事件的值是一个数组，元素形如 `{matcher?, commandRegex?, hooks: [{type:'command', command, timeout?}]}`。
 * 照 Claude 的形状多包一层 `hooks` 会让整份配置被 zod 判为无效——不是少响几个事件，是一个都不响。
 *
 * 因此合并策略也必须是**根层**那一支（`json-root-managed-events`）。用 `json-managed-events`
 * 不是"差一点"而是数据丢失：那支去 `hooks` 下找桶，在这份文件里一个都找不到，于是既不清扫、又把
 * 我们的根级事件键直接盖在用户同名的桶上，最后再写一个这个 CLI 不认的 `hooks: {}`。用户手写的
 * `PreToolUse` 审计 hook 会在下一次启动时消失。这不是推理——`renderMergedHookContent` 实测如此。
 */
export function createDroidManagedHookPlan(env?: Readonly<Record<string, string>>): AgentManagedHookPlan {
  const override = env?.FACTORY_HOME_OVERRIDE?.trim()
  const home = override ? resolve(override) : homedir()
  const command = managedHookCommand('droid')
  const events = Object.fromEntries(DROID_HOOK_EVENTS.map((eventName) => [eventName, [{
    // matcher 测的是工具名，只有两个工具事件有这个语义。其余事件上写 matcher 是噪音。
    ...(eventName === 'PreToolUse' || eventName === 'PostToolUse' ? { matcher: '*' } : {}),
    hooks: [{ type: 'command', command, ...hookCommandTimeout('droid') }]
  }]]))
  return {
    providerId: 'droid',
    mutations: [{
      path: join(home, '.factory', 'hooks.json'),
      content: `${JSON.stringify(events, null, 2)}\n`,
      mode: 0o600,
      merge: { kind: 'json-root-managed-events', marker: 'agentmux-hook.js' }
    }]
  }
}

export function createDroidProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'droid', label: 'Droid', executable: 'droid', expectedProcess: 'droid',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      // `--resume <id>` 恢复一个已有会话。注意它与 `-s/--session-id <id>` **不是同一件事**：
      // 后者的 `--help` 逐字写着 "Existing session to continue (requires a prompt)"，也就是说
      // 它要求同时给出 prompt；`--resume` 不要求。恢复走 `--resume`。
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        // observe 而非 respond：它的 `PreToolUse` 确实能拦（stdout 回 `continue:false`，或退出码
        // 2/3 直接中止），但那要求这个 fire-and-forget 的 hook 变成一条阻塞 RPC、把执行按住等用户
        // 点击。那条通路今天不存在。AgentMux 靠 PTY 注入按键回答它自己的授权提示。
        permission: 'observe',
        providerResume: true, replyCorrelation: 'none'
        // usage 刻意不声明：收尾负载（`Stop`）里只有 `tool_execution_count`/`elapsed_time`，
        // **没有任何 token 字段**。它报 `transcript_path`，但那份文件的格式未经核实，
        // 今天两个 reader（claude-jsonl / codex-rollout）都不能假定适用。按「未核实就不声明」留空。
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: DROID_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  })
}
