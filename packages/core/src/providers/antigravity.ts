import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { ANTIGRAVITY_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog, managedHookCommand, hookCommandTimeout } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export const ANTIGRAVITY_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'
] as const

export const ANTIGRAVITY_HOOKS: AgentNativeHookSpecification = {
  // 事件名靠 `--event` 旗标送达（见下方 createAntigravityManagedHookPlan 往 command 尾部追加 --event）。
  eventNameSource: { kind: 'flag' },
  rules: [
    { events: ['PreToolUse'], toolNames: ['ask_question', 'ask_permission', 'request_user_input', 'askuserquestion'], state: 'waiting' },
    { events: ['Stop'], state: 'done' },
    // `UserPromptSubmit` 必须在这条 working 规则里，而它此前**漏了**——上面的安装清单
    // （ANTIGRAVITY_HOOK_EVENTS）装了它，rules 却没有任何一条提到它，于是它到达时 eventState 判
    // `unknown`。同族的 claude/codex/grok/gemini/cursor/copilot/kimi/droid 全都把它归 working，
    // 只有这里少一个（实测：它是全部 Provider 里唯一一个「装了的重开事件不在 rules 里」的）。
    //
    // 后果不止是少一个 working：turn-phase 闸门（hook-turn-phase.ts）按 Provider 的 rules 算「这家能不能
    // 重开一个 turn」，漏了它就等于对闸门声称 antigravity 无法重开，于是它退化成永不抑制，白丢一层
    // 「收尾后压制迟到工具事件」的保护。agent-provider-protocol.test.ts 里的结构不变量钉着这件事。
    { events: ['UserPromptSubmit', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'SessionStart'], state: 'working' }
  ],
  nativeHandle: {
    sessionIdKeys: ['conversationId', 'conversation_id', 'session_id', 'sessionId'],
    transcriptPathKeys: ['transcript_path', 'transcriptPath']
  }
}

export function createAntigravityManagedHookPlan(homeOrWorkspacePath?: string): AgentManagedHookPlan {
  const targetRoot = homeOrWorkspacePath ? resolve(homeOrWorkspacePath) : homedir()
  const targetPath = targetRoot.endsWith('.json') ? targetRoot : join(targetRoot, '.gemini', 'config', 'hooks.json')
  const command = managedHookCommand('antigravity')
  const bundle: Record<string, unknown> = {}
  for (const eventName of ANTIGRAVITY_HOOK_EVENTS) {
    const eventCmd = `${command} --event ${eventName}`
    bundle[eventName] = eventName === 'PreToolUse' || eventName === 'PostToolUse'
      ? [{ matcher: '*', hooks: [{ type: 'command', command: eventCmd, ...hookCommandTimeout('antigravity') }] }]
      : [{ type: 'command', command: eventCmd, ...hookCommandTimeout('antigravity') }]
  }
  return {
    providerId: 'antigravity',
    mutations: [{
      path: targetPath,
      content: `${JSON.stringify({ 'agentmux-status': bundle }, null, 2)}\n`,
      mode: 0o600,
      merge: { kind: 'json-owned-key', key: 'agentmux-status' }
    }]
  }
}

export function createAntigravityProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'antigravity', label: 'Antigravity', executable: 'agy', expectedProcess: 'agy',
      promptDelivery: 'flag-prompt-interactive',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events', permission: 'observe',
        providerResume: true, replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => prompt ? ['--prompt-interactive', prompt, ...args] : [...args],
    hook: ANTIGRAVITY_HOOKS,
    launchOptions: ANTIGRAVITY_LAUNCH_OPTIONS,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--conversation', sessionId, ...args, ...(prompt ? ['--prompt-interactive', prompt] : [])
    ]
  })
}
