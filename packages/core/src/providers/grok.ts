import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { GROK_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { PostureControlDeclaration } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog, managedHookCommand, hookCommandTimeout } from './shared.js'

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
  // 事件名随负载到达，键是 camelCase 的 `hookEventName`（**投递侧**拼法）。注意这与配置侧不同：
  // 配置写 PascalCase `PreToolUse`，负载报 snake_case 值（`pre_tool_use`）藏在 `hookEventName` 里。
  // 声明的是投递侧那个键——子进程读的就是它（见文件头「两个面」的说明）。
  eventNameSource: { kind: 'payload', payloadKey: 'hookEventName' },
  rules: [
    // grok 的 ask_user_question 被自动放行，于是它在**等用户回答时**照旧发 pre_tool_use。
    { events: ['pre_tool_use'], toolNames: ['ask_user_question', 'askuserquestion'], state: 'waiting' },
    // 三种收尾都算 done：正常完成、API 错误、以及被取消/中断。少任何一条都会卡在 working。
    { events: ['stop', 'stop_failure', 'stop_cancelled'], state: 'done' },
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
    stopEvents: ['subagent_stop'],
    mainStopEvents: ['stop', 'stop_failure', 'stop_cancelled'],
    idKeys: ['subagentType', 'subagent_type', 'agentId', 'agent_id']
  },
  // grok 的负载键一律 camelCase：`sessionId`，不是 Claude 的 `session_id`。它不报 transcript 路径，
  // 故不声明 transcriptPathKeys——resume 靠 session id。
  nativeHandle: {
    sessionIdKeys: ['sessionId']
  }
}

/**
 * grok 的 managed hook 计划。
 *
 * 只写 `~/.grok/hooks/`：那是 grok 文档标注「Always trusted」的全局目录，无需 folder-trust 授权。
 * grok 还会主动扫 `~/.claude/settings.json` 与 `~/.cursor/hooks.json` 做兼容——**绝不**往那两处写，
 * 那是用户为别的 CLI 维护的配置，AgentMux 挤进去会让一次 grok 安装污染 Claude 的行为。
 *
 * 单独一个文件名而非合并进 `config.toml`：同一目录下各文件互不干扰，卸载就是删这一个文件。
 */
export function createGrokManagedHookPlan(homeOverride?: string): AgentManagedHookPlan {
  const home = homeOverride ? resolve(homeOverride) : homedir()
  const command = managedHookCommand('grok')
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
    mutations: [{
      path: join(home, '.grok', 'hooks', 'agentmux-status.json'),
      content: `${JSON.stringify({ hooks }, null, 2)}\n`,
      mode: 0o600,
      merge: { kind: 'json-managed-events', marker: 'agentmux-hook.js' }
    }]
  }
}

export function createGrokProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
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
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, ...args, ...(prompt ? ['--', prompt] : [])
    ]
  })
}
