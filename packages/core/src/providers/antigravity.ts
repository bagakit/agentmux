import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { ANTIGRAVITY_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog, managedHookCommand } from './shared.js'

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
    { events: ['PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'SessionStart'], state: 'working' }
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
      ? [{ matcher: '*', hooks: [{ type: 'command', command: eventCmd, timeout: 10 }] }]
      : [{ type: 'command', command: eventCmd, timeout: 10 }]
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
