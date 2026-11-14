import { executionEnvironmentValue, executionHomeDirectory, executionPath, type ProviderExecutionEnvironment } from './execution-environment.js'
import { join } from 'node:path'
import { GROK_LAUNCH_OPTIONS } from './launch-options.js'
import type { PostureControlDeclaration } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import { observeGrokSessionHistory, readGrokSessionHistoryPage, readGrokConversationChanges, readGrokSessionHistoryRecord } from './grok-native-history.js'
import { catalog, hookToolFields, runScopedHookCommand, hookCommandTimeout } from './shared.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { readGrokInputInitialization } from './grok-input-initialization.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export const GROK_POSTURE: PostureControlDeclaration = {
  id: 'approval', label: 'Approvals',
  modes: [
    { id: 'ask', label: 'Ask each time', description: 'Grok asks before running commands or editing files.', tier: 'safe', input: '/always-approve off\r' },
    { id: 'always-approve', label: 'Auto-approve', description: 'Skip all permission prompts for this session.', tier: 'danger', input: '/always-approve on\r' }
  ]
}

/**
 * grok 写进 hooks 配置的事件名，与它在 stdin 负载里报的事件名**不是同一种拼法**。
 *
 * 配置侧是 PascalCase（`PreToolUse`），投递侧的 `hookEventName` 是 snake_case（`pre_tool_use`）。
 * 这不是矛盾，是两个面：installer 用这份常量，normalizer 用下面那份方言表。两边都必须照各自
 * 真实的拼法来，任何一边套用另一边的拼法都会静默失效。
 *
 * 只装 AgentMux 真的要用的事件。grok 另有 `PreCompact`/`PostCompact`/`PermissionDenied`/
 * `Notification` 等，Core 今天没有任何判断需要它们，装了只是让每次压缩都多起一个子进程。
 */
export const GROK_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'StopCancelled'
] as const

/**
 * grok 的 wire 方言（`hookEventName` 里真正出现的 snake_case 值）住在 `agent-hook-event.ts`：
 * 那是零依赖叶子，hook 子进程靠它拿表，不能反向依赖本模块。此处只保留配置侧清单与 rules。
 */
export const GROK_HOOKS: AgentNativeHookSpecification = {
  retainedRuntime: true,
  toolFields(eventName, payload) {
    if (!['pre_tool_use', 'post_tool_use', 'post_tool_use_failure'].includes(eventName)) return {}
    // Native stdin emits these same-value aliases; camelCase is the original spelling.
    return hookToolFields(payload.toolName === undefined ? payload.tool_name : payload.toolName,
      payload.toolInput === undefined ? payload.tool_input : payload.toolInput,
      payload.toolUseId === undefined ? payload.tool_use_id : payload.toolUseId)
  },
  toolOutcome(eventName, payload) {
    if (eventName === 'post_tool_use_failure') {
      const output = formatHookToolOutput(typeof payload.error === 'string' ? payload.error : undefined)
      return { failed: true, ...(output === undefined ? {} : { output }) }
    }
    if (eventName !== 'post_tool_use') return { failed: false }
    // Native stdin sends toolResult and its same-value tool_response alias.
    const raw = payload.toolResult === undefined ? payload.tool_response : payload.toolResult
    const result = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
    // The documented Execute name is run_terminal_command; MCP keeps its qualified server__tool target.
    const bash = payload.toolName === 'run_terminal_command' && result?.type === 'Bash'
    const body = bash ? (typeof result.pre_formatted === 'string' ? result.pre_formatted : result.output_for_prompt) : raw
    const failed = bash && typeof result.exit_code === 'number' && Number.isFinite(result.exit_code) && result.exit_code !== 0
    const output = formatHookToolOutput(body)
    return { failed, ...(output === undefined ? {} : { output }) }
  },
  lifecycle: {
    session_start: 'session-start',
    user_prompt_submit: 'user-prompt-submit',
    pre_tool_use: 'tool-use-start',
    post_tool_use: 'tool-use-end',
    post_tool_use_failure: 'tool-use-end',
    subagent_start: 'subagent-start',
  },
  // 事件名随负载到达，键是 camelCase 的 `hookEventName`（**投递侧**拼法）。注意这与配置侧不同：
  // 配置写 PascalCase `PreToolUse`，负载报 snake_case 值（`pre_tool_use`）藏在 `hookEventName` 里。
  // 声明的是投递侧那个键——子进程读的就是它（见文件头「两个面」的说明）。
  eventNameSource: { kind: 'payload', payloadKey: 'hookEventName' },
  // subagentType establishes child scope, not unique identity. Each child uses its own native session.
  resolveSubject(payload, context) {
    const nativeId = normalizeNativeSessionId(payload.sessionId)
    const child = typeof payload.subagentType === 'string' && payload.subagentType.trim().length > 0
    if (child && nativeId && context.nativeHandle?.sessionId === nativeId)
      return { kind: 'unknown', basis: 'provider-protocol', reason: 'conflicting-child-session', nativeSessionId: nativeId }
    if (child) return nativeId
      ? { kind: 'child', basis: 'provider-protocol', reason: 'grok-child-session', nativeSessionId: nativeId }
      : { kind: 'unknown', basis: 'provider-protocol', reason: 'child-native-identity-unconfirmed' }
    if (!nativeId) return { kind: 'unknown', basis: 'provider-protocol', reason: 'native-session-identity-unconfirmed' }
    const main = context.nativeHandle
    if (nativeId && main && (main.kind !== 'provider' || main.providerId !== 'grok' || main.sessionId !== nativeId))
      return { kind: 'foreign', basis: 'provider-protocol', reason: 'native-session-mismatch', nativeSessionId: nativeId }
    return { kind: 'main', basis: 'provider-protocol', reason: 'run-bound-protocol', ...(nativeId ? { nativeSessionId: nativeId } : {}) }
  },
  rules: [
    // grok 的 ask_user_question 被自动放行，于是它在**等用户回答时**照旧发 pre_tool_use。
    { events: ['pre_tool_use'], toolNames: ['ask_user_question', 'askuserquestion'], state: 'waiting' },
    // The stop gate can continue; observation-only failure/cancellation are actual non-success ends.
    { events: ['stop', 'subagent_stop'], state: 'unknown', lifecycleEvent: null },
    { events: ['stop_failure'], state: 'error', lifecycleEvent: 'turn-end' },
    { events: ['stop_cancelled'], state: 'unknown', lifecycleEvent: 'turn-end' },
    {
      events: [
        'session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use',
        'post_tool_use_failure', 'subagent_start'
      ],
      state: 'working'
    }
  ],
  subagentTracking: {
    startEvents: ['subagent_start'],
    stopEvents: [],
    mainStopEvents: ['stop_failure', 'stop_cancelled'],
    idKeys: ['sessionId']
  },
  // grok 的负载键一律 camelCase：`sessionId`，不是 Claude 的 `session_id`。它不报 transcript 路径，
  // 故不声明 transcriptPathKeys——resume 靠 session id。
  nativeHandle: {
    sessionIdKeys: ['sessionId']
  },
  // Grok's Stop gate can keep a genuinely completing main turn working. A non-error
  // `additionalContext` hands the frozen notice to the model as same-turn input without
  // reporting a hook failure. `stopHookActive` is true once a gate already continued this
  // turn, so only the first stop of each `promptId` can carry a notice.
  turnEndDecision: {
    eventName: 'stop',
    readTurn(payload) {
      const nativeTurnId = payload.promptId, active = payload.stopHookActive
      if (typeof nativeTurnId !== 'string' || !nativeTurnId.trim() || typeof active !== 'boolean' || payload.reason !== 'end_turn') return undefined
      return { nativeTurnId, firstStop: !active }
    },
    output: notice => ({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: notice } })
  }
}

/**
 * grok 的 managed hook 计划。
 *
 * 只写原生配置根的 `hooks/`，不写兼容读取的 Claude／Cursor 配置。
 * 原生 trust 与文件位置分开：headless 加载 own hooks，TUI 仍沿原生 folder trust。
 * grok 还会主动扫 `~/.claude/settings.json` 与 `~/.cursor/hooks.json` 做兼容——**绝不**往那两处写，
 * 那是用户为别的 CLI 维护的配置，AgentMux 挤进去会让一次 grok 安装污染 Claude 的行为。
 *
 * 单独一个文件名而非合并进 `config.toml`：同一目录下各文件互不干扰，卸载就是删这一个文件。
 */
export function createGrokManagedHookPlan(homeOverride?: string, env?: ProviderExecutionEnvironment, workspacePath?: string): AgentManagedHookPlan {
  const configRoot = homeOverride === undefined
    ? executionEnvironmentValue(env, 'GROK_HOME') || join(executionHomeDirectory(env), '.grok')
    : join(homeOverride, '.grok')
  const grokHome = executionPath(configRoot, workspacePath)
  const command = runScopedHookCommand('grok')
  const hooks = Object.fromEntries(GROK_HOOK_EVENTS.map((eventName) => [eventName, [{
    // 工具类事件才有 matcher 语义（它测的是工具名）；grok 明说 Stop/UserPromptSubmit 上的 matcher
    // 会被忽略并告警，所以不写——写了只会在用户的 /hooks 面板里留一条噪音警告。
    ...(eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PostToolUseFailure'
      ? { matcher: '.*' }
      : {}),
    hooks: [{ type: 'command', command, ...hookCommandTimeout('grok') }]
  }]]))
  return {
    providerId: 'grok',
    retainPreviousDeclarations: true,
    mutations: [{
      path: join(grokHome, 'hooks', 'agentmux-status.json'),
      content: `${JSON.stringify({ hooks }, null, 2)}\n`,
      mode: 0o600,
      merge: { kind: 'json-managed-events' }
    }]
  }
}

export function createGrokProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    planManagedHooks: ({ env, workspacePath }) => createGrokManagedHookPlan(undefined, env, workspacePath),
    catalog: catalog({
      id: 'grok', label: 'Grok', executable: 'grok', expectedProcess: 'grok', promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      // `grok --resume <SESSION_ID_OR_TITLE>` 按 id 或标题恢复（`--help` 实测）。`--session-id` 是
      // **给新会话指定 UUID**，不能用来恢复，故 locator 是 session-id。
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        // observe 而非 respond：grok 的 PreToolUse 能在 stdout 上回 deny/ask，但那要求这个
        // fire-and-forget 的 hook 变成一条阻塞 RPC、把 stdout 按住等用户点击。那条通路今天不存在，
        // 所以只观察，不应答——AgentMux 靠 PTY 注入按键回答它自己的授权提示。
        permission: 'observe',
        providerResume: true, replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => prompt ? [...args, '--', prompt] : [...args],
    posture: GROK_POSTURE,
    hook: GROK_HOOKS,
    launchOptions: GROK_LAUNCH_OPTIONS,
    readSessionHistoryPage: readGrokSessionHistoryPage,
    readSessionHistoryRecord: readGrokSessionHistoryRecord,
    observeSessionHistory: observeGrokSessionHistory,
    readConversationChanges: readGrokConversationChanges,
    readInputInitialization: readGrokInputInitialization,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, ...args, ...(prompt ? ['--', prompt] : [])
    ]
  })
}
