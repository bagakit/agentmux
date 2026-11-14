import type { ProviderExecutionEnvironment } from './execution-environment.js'
import { join } from 'node:path'
import { CURSOR_LAUNCH_OPTIONS } from './launch-options.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { normalizeNativeHook, type AgentNativeHookSpecification } from '../hook-normalizer.js'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import { catalog, hookToolFields, managedHookCommand, hookCommandTimeout } from './shared.js'
import { cursorDataRoot, readCursorSessionHistoryPage, observeCursorSessionHistory } from './cursor-native-history.js'
import { discoverCursorNativeSession } from './cursor-native-session.js'
import { cursorPromptPayloadConsumption } from './cursor-payload-consumption.js'
import { buildPromptInputPayload, sanitizeBracketedPasteText } from '../bracketed-paste.js'
import { prepareCursorOwnedWorkspaceTrust } from './cursor-workspace-trust.js'
export { cursorTrustMarkerPath } from './cursor-workspace-trust.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * 写进 `~/.cursor/hooks.json` 的事件名。
 *
 * 只装 AgentMux 真的要用的八个。Cursor 的完整事件表比这大得多（`sessionStart`/`sessionEnd`/
 * `preCompact`/`subagentStart`/`subagentStop`/`afterAgentThought`/`afterShellExecution`/
 * `afterMCPExecution`/`beforeReadFile`/`afterFileEdit`/`beforeTabFileRead`/`afterTabFileEdit`/
 * `workspaceOpen`）——`beforeReadFile` 与 `afterFileEdit` 尤其致命：Agent 每读一个文件、每改一处
 * 都会新起一个子进程，那是把 hook 开销挂到最热的路径上，而 Core 今天没有任何判断需要它们。
 *
 * 装进来的八个各有其不可替代的作用：
 * - `beforeSubmitPrompt`：一轮的起点，也是 Cursor 唯一带 `prompt` 的事件。
 * - `preToolUse`/`postToolUse`/`postToolUseFailure`：一次工具调用的事前、成功事后、失败事后。
 *   三条都带 `tool_use_id`，故能收敛到时间轴上的同一条。
 * - `beforeShellExecution`/`beforeMCPExecution`：授权门。装它们不是为了回决定（我们不回），
 *   而是让 shell / MCP 执行的起点对 Core 可见。
 * - `afterAgentResponse`：助手正文（`text`）。
 * - `stop`：一轮收尾，且是 Cursor 唯一带 token 用量的事件。
 */
export const CURSOR_HOOK_EVENTS = [
  'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'postToolUseFailure',
  'beforeShellExecution', 'beforeMCPExecution', 'afterAgentResponse', 'stop'
] as const

/**
 * Cursor 的 hook 合同。
 *
 * 事件名是 camelCase，负载键却是 Claude 同族的 snake_case（`tool_name`/`tool_input`/`tool_output`/
 * `tool_use_id`）——normalizer 的既有读取顺序已覆盖这些键，所以时间轴不需要 Cursor 专属分支。
 *
 * `stop` 状态按 status 诚实区分：
 * 官方构建 e373342 实测，Cursor 在 stop 负载里传递 status（"completed" / "aborted" / "error"）。
 * 只有已证明成功的 "completed" 赋予 state: 'done' 与 successful completion 身份（放行 automatic 进度）；
 * 实际 "error" 诚实映射为 state: 'error'，lifecycleEvent: 'turn-end'（放行 manual 下一轮，automatic 零写拒绝）；
 * "aborted" 取消收尾使用已有诚实语义 state: 'unknown'，lifecycleEvent: 'turn-end'（无 completion 身份）；
 * 未知或缺席的 status 不得猜成功亦不能断定已结束，映射为 state: 'unknown'，lifecycleEvent: null。
 *
 * 两个授权门判 working 而非 waiting：Cursor 对每一次 shell / MCP 执行都触发它们，包括按 allowlist
 * 自动放行、根本不出提示的执行；负载里没有「是否会向用户提示」的事实。判 waiting 会让每条正在跑的
 * 命令都显示成等用户处理，中途被打断时还会一直停在 waiting。Cursor 的 TUI 授权提示今天没有 hook
 * 协议事实，保持未知，不从门事件猜。
 *
 * nativeHandle 与 subagent 隔离：
 * Cursor 运行时的会话标识统一为 UUID（执行循环中的 `Mt`），它同时用作 `conversationId` 和 chat 目录名；
 * `~/.cursor/chats/<32 hex>` 的 32 hex 仅是 `md5(resolve(cwd))` 的工作区目录桶，其下的子目录与 transcript
 * 路径均直接使用完整 UUID。`--resume <chatId>` 消费的正是该 UUID。Hook 负载通过 `conversation_id`（并带
 * `transcript_path`）送达，故声明 nativeHandle 解析主会话恢复句柄与定位器；同时声明 subagentTracking
 * 隔离子代理事件（`subagentStart`/`subagentStop` 携带 `subagent_id`），防止子代理覆盖主会话句柄。
 */
export const CURSOR_HOOKS: AgentNativeHookSpecification = {
  toolFields(eventName, payload) {
    if (eventName === 'beforeShellExecution') return hookToolFields(undefined, undefined, payload.tool_use_id)
    if (!['preToolUse', 'postToolUse', 'postToolUseFailure', 'beforeMCPExecution'].includes(eventName)) return {}
    return hookToolFields(payload.tool_name, payload.tool_input, payload.tool_use_id)
  },
  toolOutcome(eventName, payload) {
    const failed = eventName === 'postToolUseFailure'
    const body = failed ? (typeof payload.error_message === 'string' ? payload.error_message : undefined)
      : eventName === 'postToolUse' ? payload.tool_output : undefined
    const output = formatHookToolOutput(body)
    return { failed, ...(output === undefined ? {} : { output }) }
  },
  lifecycle: {
    beforeSubmitPrompt: 'user-prompt-submit',
    preToolUse: 'tool-use-start',
    postToolUse: 'tool-use-end',
    postToolUseFailure: 'tool-use-end',
  },
  // 固定第一方版本同时提供 hook_event_name；托管配置继续显式用 --event 传递事件名。
  eventNameSource: { kind: 'flag' },
  rules: [
    // afterAgentResponse carries body content and can arrive after stop(completed).
    // It grants no new activity; Core preserves the original state for a content-only event.
    { events: ['stop'], matches: payload => payload.status === 'completed', state: 'done', lifecycleEvent: 'turn-end' },
    { events: ['stop'], matches: payload => payload.status === 'error', state: 'error', lifecycleEvent: 'turn-end' },
    { events: ['stop'], matches: payload => payload.status === 'aborted', state: 'unknown', lifecycleEvent: 'turn-end' },
    { events: ['stop'], state: 'unknown', lifecycleEvent: null },
    {
      events: [
        'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'postToolUseFailure',
        'beforeShellExecution', 'beforeMCPExecution'
      ],
      state: 'working'
    }
  ],
  subagentTracking: {
    startEvents: ['subagentStart'], stopEvents: ['subagentStop'], mainStopEvents: ['stop'], idKeys: ['subagent_id']
  },
  nativeHandle: { sessionIdKeys: ['conversation_id'], transcriptPathKeys: ['transcript_path'] }
}

/** User-level Hook declarations contain no directory trust authority. */
export function createCursorManagedHookPlan(
  workspacePath: string,
  env?: ProviderExecutionEnvironment
): AgentManagedHookPlan {
  const command = managedHookCommand('cursor')
  const hooks = Object.fromEntries(CURSOR_HOOK_EVENTS.map((eventName) => [eventName, [
    // 托管脚本的事件名来源保持显式 --event，不猜负载别名。
    { command: `${command} --event ${eventName}`, ...hookCommandTimeout('cursor') }
  ]]))
  return {
    providerId: 'cursor',
    mutations: [
      {
        path: join(cursorDataRoot(workspacePath, env), 'hooks.json'),
        content: `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`,
        mode: 0o600,
        merge: { kind: 'json-managed-events' }
      }
    ]
  }
}

export function createCursorProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  const { subagentTracking: _tracking, nativeHandle: _identity, ...observationOnly } = CURSOR_HOOKS
  const provider = defineAgentProvider({
    prepareOwnedWorkspaceTrust: prepareCursorOwnedWorkspaceTrust,
    planManagedHooks: ({ workspacePath, env }) => createCursorManagedHookPlan(workspacePath, env),
    catalog: catalog({
      id: 'cursor', label: 'Cursor', executable: 'cursor-agent', expectedProcess: 'cursor-agent',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      // `--resume [chatId]` 直传 chat id（bundle 实测：`else fe=o.resume`，无 UUID 校验、无序号
      // 解释；只有 `-1` 与 `-<n>` 两种**负数**形式才被当成「第 n 近」）。chat id 是
      // `<configRoot>/chats/<workspaceBucket>/<chatId>` 的原生会话 UUID，跨会话稳定。
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        // observe 而非 respond：`preToolUse` 与两个 shell/MCP 门确实读 stdout 上的
        // `permission: allow|deny|ask`，但回决定要把这条 fire-and-forget 的 hook 变成阻塞 RPC。
        // 我们回 `{}`——Cursor 的校验器写明 permission 可以是 undefined，且它只在**显式**
        // `continue === false` 时拦提交，所以 `{}` 既合法又不改变它的行为。
        permission: 'observe',
        providerResume: true, replyCorrelation: 'none'
        // usage 刻意不声明：Cursor 的 `stop` 负载**直接带** `input_tokens`/`output_tokens`/
        // `cache_read_tokens`/`cache_write_tokens`，压根不需要读 transcript——而今天的 usage 通路
        // （AgentUsageCapability）只有 native-transcript 一种形状，声明它等于承诺去解析一个
        // Cursor 从不产出的 transcript 文件。这条留给「负载直报 usage」那一类能力单独接。
      }
    }),
    launchOptions: CURSOR_LAUNCH_OPTIONS,
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    promptPayloadConsumption: cursorPromptPayloadConsumption,
    planPromptInput: (prompt, context) => {
      const payload = buildPromptInputPayload(prompt)
      const payloadText = sanitizeBracketedPasteText(prompt).replace(/\r\n?/gu, '\n').replaceAll('\t', '  ')
      // Native persistence acknowledges only this supported body domain. Explicit
      // current-terminal input retains its ordinary plan before it is frozen;
      // optional native observation cannot take that healthy capability away.
      return context?.currentTerminal !== true && payloadText.length > 800
        ? { kind: 'payload-then-submit', payload, payloadText, submit: '\u001b[13u', minimumSubmitDelayMs: 35 }
        : { kind: 'single-phase', data: `${payload}\u001b[13u` }
    },
    hook: CURSOR_HOOKS,
    discoverNativeSession: discoverCursorNativeSession,
    readSessionHistoryPage: readCursorSessionHistoryPage,
    observeSessionHistory: observeCursorSessionHistory,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  })
  return {
    ...provider,
    normalizeHook(envelope, context) {
      const payload = envelope.payload ?? {}
      const sessionId = typeof payload.conversation_id === 'string' && payload.conversation_id.trim()
        ? payload.conversation_id.trim() : undefined
      const known = context.nativeHandle
      const foreign = known !== undefined && sessionId !== undefined && sessionId !== known.sessionId
      // A foreign receipt must not mutate this Run's existing child roster before
      // its return value is fenced. It contributes only the authenticated raw observation.
      const normalized = foreign ? normalizeNativeHook({ ...observationOnly, rules: [] }, envelope, context)
        : provider.normalizeHook(envelope, context)
      if (!foreign) {
        // An authenticated first-party receipt establishes birth. A later receipt cannot
        // replace the durable locator for the same main native Session. Known child
        // settlement retains the shared roster's proven parent completion contribution.
        return known && normalized.nativeHandle ? { ...normalized, nativeHandle: known } : normalized
      }
      const { nativeHandle: _handle, turnUsage: _usage, interaction: _interaction,
        interactionCompletion: _completion, ...neutral } = normalized
      return { ...neutral, mainSubject: false, lifecycleEvent: null, semanticState: 'unknown',
        status: { ...normalized.status, state: 'running' }, timeline: [] }
    }
  }

}
