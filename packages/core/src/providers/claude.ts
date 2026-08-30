import { isAbsolute } from 'node:path'
import { join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { CLAUDE_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import { createNumberedTerminalInteractionProtocol, type TerminalPermissionOption } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import {
  buildPromptInputPayload,
  catalog,
  managedHookCommand,
  hookCommandTimeout,
  sanitizeBracketedPasteText
} from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * 写进 `<workspace>/.claude/settings.json` 的事件名。
 *
 * 这份清单是**实际注册**的那一份，与 `CLAUDE_HOOKS.rules` 引用的名字必须一致：rules 里写了却没装的
 * 事件，Claude 压根不会发——声明看着完整，运行时永远命中不到。此前 `PostToolUseFailure`、
 * `StopFailure`、`PreCompact` 三个就是这样：rules 引用它们，清单不装它们（同族的 grok Provider
 * 反倒装了 `PostToolUseFailure`/`StopFailure`）。三个都被本机 CLI 的事件全集与负载 schema 佐证，
 * 所以补装而不是把 rules 删掉。
 *
 * 各自不可替代的作用（负载形状取自本机 bundle 的 zod schema）：
 * - `PostToolUseFailure`：`{tool_name, tool_input, tool_use_id, error, is_interrupt?, duration_ms?}`。
 *   **没有** `tool_response`，正文只在 `error` 里。少了这条，一次失败的工具调用会永远停在
 *   streaming 徽标上——`PostToolUse` 只在成功时触发（bundle 内嵌文档逐字："Run after successful tool"）。
 * - `StopFailure`：`{error, error_details?, last_assistant_message?}`。它**取代** `Stop`，也就是说
 *   报错收尾根本不会有 `Stop`。少装它，Agent 报错后会永远停在 working。
 * - `PreCompact`：`{trigger: 'manual'|'auto', custom_instructions}`。压缩期间 Agent 仍在干活，
 *   而这段时间没有任何工具事件——少了它，长压缩看起来像卡死。
 *
 * Claude 的事件全集有 33 个（bundle 里的 `_y`）。其余不装：`Notification`/`MessageDisplay`/
 * `StatusLine`/`FileSuggestion` 是 UI 通路；`FileChanged`/`CwdChanged`/`DirectoryAdded` 每次文件
 * 变动都触发，是把子进程挂到最热路径上；`PostCompact`/`SessionEnd`/`TeammateIdle`/`TaskCreated`/
 * `TaskCompleted`/`PermissionDenied`/`PostToolBatch` 等 Core 今天没有判断需要（见下方 rules 的说明）。
 */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'PermissionRequest', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact'
] as const

export const CLAUDE_HOOKS: AgentNativeHookSpecification = {
  // 事件名随负载到达：Claude 一族的 stdin 负载带 `hook_event_name`（这也是 claude/codex 的配置都不带
  // `--event` 却照样能用的原因——事件名不在配置侧、在投递侧）。
  eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' },
  rules: [
    { events: ['PermissionRequest'], state: 'waiting' },
    { events: ['PreToolUse'], toolNames: ['askuserquestion'], state: 'waiting' },
    // `StopFailure` 与 `Stop` 同为收尾且互斥（报错收尾不发 `Stop`）——两条都必须判 done。
    { events: ['Stop', 'StopFailure'], state: 'done' },
    { events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact'], state: 'working' }
  ],
  subagentTracking: {
    startEvents: ['SubagentStart'],
    stopEvents: ['SubagentStop'],
    mainStopEvents: ['Stop', 'StopFailure'],
    idKeys: ['agent_id', 'agentId']
  },
  nativeHandle: {
    sessionIdKeys: ['session_id'],
    transcriptPathKeys: ['transcript_path', 'transcriptPath']
  }
}

const PERMISSION_ESC = '\u001b'
const CLAUDE_PERMISSION_OPTIONS: readonly TerminalPermissionOption[] = [
  { id: 'allow-once', label: 'Allow once', kind: 'allow-once', tier: 'safe', input: '1' },
  {
    id: 'allow-always', label: "Allow & don't ask again", description: 'This tool, this directory.',
    kind: 'allow-always', tier: 'caution', input: '2'
  },
  { id: 'reject-once', label: 'Deny', kind: 'reject-once', tier: 'safe', input: PERMISSION_ESC }
]

export function createClaudeManagedHookPlan(workspacePath: string): AgentManagedHookPlan {
  const workspace = resolve(workspacePath)
  if (!isAbsolute(workspacePath) || workspace !== workspacePath) {
    throw new AgentMuxError('Claude Hook workspace must be an absolute normalized path.', 'INVALID_HOOK_PLAN')
  }
  const command = managedHookCommand('claude')
  const hooks = Object.fromEntries(CLAUDE_HOOK_EVENTS.map((eventName) => [eventName, [{
    // 三个 tool 事件按 matcher 分派（bundle 内嵌文档的 Hook Events 表里，这三行的 Matcher 列都是
    // "Tool name"）。`*` 是「所有工具」；缺了 matcher，Claude 对 tool 事件不会分派到我们这条。
    // `PostToolUseFailure` 此前既不在清单里、自然也没有 matcher——补装时必须一起给。
    ...(eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PostToolUseFailure'
      ? { matcher: '*' }
      : {}),
    hooks: [{ type: 'command', command, ...hookCommandTimeout('claude') }]
  }]]))
  return {
    providerId: 'claude',
    mutations: [{
      path: join(workspace, '.claude', 'settings.json'),
      content: `${JSON.stringify({ hooks }, null, 2)}\n`,
      mode: 0o600,
      merge: { kind: 'json-managed-events', marker: 'agentmux-hook.js' }
    }]
  }
}

export function createClaudeProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      composer: {"skillRoots": [".claude/skills", ".agents/skills"], "commands": [{"text": "/help", "description": "Available commands"}, {"text": "/model", "description": "Choose model"}, {"text": "/compact", "description": "Compact context"}, {"text": "/cost", "description": "Session usage"}, {"text": "/context", "description": "Context usage"}]},
      id: 'claude', label: 'Claude', executable: 'claude', expectedProcess: 'claude',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events', permission: 'respond',
        providerResume: true, replyCorrelation: 'none',
        usage: { kind: 'native-transcript', transcriptFormat: 'claude-jsonl' }
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    // Claude's composer is a real TUI input line. Send the payload first, verify that the \`❯\` line
    // contains the exact text, then send Enter as a separate CtxMux operation. A single write can
    // visibly populate the line while the TUI is still in a redraw/steer transition, leaving the
    // user with text that was never submitted.
    terminalPromptRender: { frameStart: '\u001b[?2026h', activeComposer: '❯', frameEnd: '\u001b[?2026l' },
    planPromptInput: (prompt) => ({
      kind: 'render-then-submit',
      payload: buildPromptInputPayload(prompt),
      renderedText: sanitizeBracketedPasteText(prompt).replace(/\r\n?/gu, '\n'),
      submit: '\r'
    }),
    interaction: createNumberedTerminalInteractionProtocol({
      questionEvents: ['PermissionRequest', 'PreToolUse'],
      questionTools: ['askuserquestion'],
      permissionOptions: CLAUDE_PERMISSION_OPTIONS
    }),
    hook: CLAUDE_HOOKS,
    launchOptions: CLAUDE_LAUNCH_OPTIONS,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  })
}
