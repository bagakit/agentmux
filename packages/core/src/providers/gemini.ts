import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { GEMINI_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog, managedHookCommand, hookCommandTimeout } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * Gemini 写进 hooks 配置、也在负载里报的事件名——**两侧同一种拼法**（PascalCase），
 * 与 grok 的双面情况不同，不需要第二份清单。
 *
 * 只装 AgentMux 真的要用的事件。Gemini 另有 `BeforeModel`/`AfterModel`/`BeforeToolSelection`/
 * `PreCompress`/`Notification`：每次模型往返都触发，而 Core 今天没有任何判断需要它们——装了
 * 只会让每轮多起若干子进程。`SessionEnd` 也不装：AgentMux 判「这一轮结束」靠 `AfterAgent`，
 * 会话终结由 PTY 事实回答（那是 ctxmux 的所有权，不是 Provider 语义）。
 */
export const GEMINI_HOOK_EVENTS = [
  'SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent'
] as const

/**
 * Gemini 的 hook 合同。
 *
 * 负载是 Claude 同族的 snake_case（`hook_event_name` / `tool_name` / `tool_input` /
 * `tool_response` / `session_id` / `transcript_path`），这也解释了 `gemini hooks migrate
 * --from-claude` 为什么成立。**但事件名是 Gemini 自己的**（`BeforeTool` 而非 `PreToolUse`），
 * 所以不能照抄 Claude 的事件清单——只有负载键的拼法同族。
 *
 * `AfterAgent` 是**一轮**收尾（带 `prompt` / `prompt_response` / `stop_hook_active`），不是会话
 * 收尾——因此它才是 done 的来源。`SessionEnd` 属于会话终结，Core 不拿它判轮次。
 */
export const GEMINI_HOOKS: AgentNativeHookSpecification = {
  // 事件名随负载到达：负载是 Claude 同族的 snake_case，带 `hook_event_name`（见下方 rules 前的说明）。
  eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' },
  rules: [
    { events: ['AfterAgent'], state: 'done' },
    { events: ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool'], state: 'working' }
  ],
  // Gemini 每个事件都带 transcript_path（见 `createBaseInput`），所以 usage 能真的抽到 token。
  nativeHandle: {
    sessionIdKeys: ['session_id'],
    transcriptPathKeys: ['transcript_path']
  }
}

/**
 * Gemini 的 managed hook 计划。
 *
 * 写 `~/.gemini/settings.json` 的 `hooks` 键。这里有一处**必须**看清的邻接风险：Antigravity 也住在
 * `~/.gemini` 下，但它的 hook 配置是 `~/.gemini/config/hooks.json`（见 createAntigravityManagedHookPlan）
 * ——两者是**不同文件**，互不覆盖。写错一个就会让装 Gemini 顺手改掉用户 Antigravity 的行为。
 *
 * settings.json 是用户的主配置（本机实测同时含 `security` 与 `mcpServers`），所以必须走
 * `json-managed-events` 合并：它按 marker 只清扫自有条目，foreign 顶层键与 foreign hook 定义全部保留。
 */
export function createGeminiManagedHookPlan(homeOverride?: string): AgentManagedHookPlan {
  const home = homeOverride ? resolve(homeOverride) : homedir()
  const command = managedHookCommand('gemini')
  const hooks = Object.fromEntries(GEMINI_HOOK_EVENTS.map((eventName) => [eventName, [{
    // matcher 只在工具类事件上有意义（`matchesContext` 拿它去比 `context.toolName`）。
    // 空串与 `*` 都被读作「匹配全部」，这里显式写 `*` 与 Claude 侧保持一致。
    ...(eventName === 'BeforeTool' || eventName === 'AfterTool' ? { matcher: '*' } : {}),
    hooks: [{ type: 'command', command, ...hookCommandTimeout('gemini') }]
  }]]))
  return {
    providerId: 'gemini',
    mutations: [{
      path: join(home, '.gemini', 'settings.json'),
      content: `${JSON.stringify({ hooks }, null, 2)}\n`,
      mode: 0o600,
      merge: { kind: 'json-managed-events', marker: 'agentmux-hook.js' }
    }]
  }
}

export function createGeminiProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'gemini', label: 'Gemini', executable: 'gemini', expectedProcess: 'gemini',
      promptDelivery: 'flag-prompt-interactive',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      // `--resume` 的 `--help` 只写 "latest" 或序号，据此会误判成「只能按序号」。但实现里的
      // `findSession(identifier)` 是 **UUID 优先**：先 `sessions.find(s => s.id === identifier)`，
      // 命中即返回，**只有**匹配不上才回退到 1-based 序号（本机 0.55.1 与最新 0.57.0 逐字一致）。
      // 所以 locator 是 session-id，而不是位置性的序号——序号会在会话增删后指向另一段对话。
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      // `--acp` 真实存在，但 AgentMux 侧的 ACP 适配未接，故如实声明 none/false。
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        // observe 而非 respond：与 grok 同理——回决定需要把 fire-and-forget 的 hook 变成阻塞 RPC。
        permission: 'observe',
        providerResume: true, replyCorrelation: 'none'
        // usage 刻意不声明：Gemini 每个事件都带 transcript_path，但它那份 transcript 是**整文件
        // JSON** 的 conversation record（`loadConversationRecord`），既不是 claude-jsonl 也不是
        // codex-rollout——今天两个 reader 都读不了它。声明 usage 就得先加第三种解析器，那超出本 task
        // 的验收面；按「能力未核实就不声明」如实留空，接 reader 时再单独记一个 task。
      }
    }),
    buildArgs: (prompt, args) => prompt ? ['--prompt-interactive', prompt, ...args] : [...args],
    hook: GEMINI_HOOKS,
    launchOptions: GEMINI_LAUNCH_OPTIONS,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, ...(prompt ? ['--prompt-interactive', prompt] : []), ...args
    ]
  })
}
