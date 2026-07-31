import { isAbsolute } from 'node:path'
import { join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { CLAUDE_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import { createNumberedTerminalInteractionProtocol, type TerminalPermissionOption } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog, managedHookCommand } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'PermissionRequest', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Stop'
] as const

export const CLAUDE_HOOKS: AgentNativeHookSpecification = {
  rules: [
    { events: ['PermissionRequest'], state: 'waiting' },
    { events: ['PreToolUse'], toolNames: ['askuserquestion'], state: 'waiting' },
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
    ...(eventName === 'PreToolUse' || eventName === 'PostToolUse' ? { matcher: '*' } : {}),
    hooks: [{ type: 'command', command, timeout: 10 }]
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
      id: 'claude', label: 'Claude', executable: 'claude', expectedProcess: 'claude',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, hookEvents: true, timeline: 'complete-events', permission: 'respond',
        providerResume: true, acp: false, replyCorrelation: 'none',
        usage: { kind: 'native-transcript', transcriptFormat: 'claude-jsonl' }
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
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
