import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { HERMES_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog, hermesHookCommand } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export const HERMES_HOOK_EVENTS = [
  'on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'post_llm_call', 'on_session_end'
] as const

export const HERMES_HOOKS: AgentNativeHookSpecification = {
  rules: [
    { events: ['pre_tool_call'], toolNames: ['clarify'], state: 'waiting' },
    { events: ['post_llm_call', 'on_session_end'], state: 'done' },
    { events: ['on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call'], state: 'working' }
  ]
}

export function createHermesManagedHookPlan(env?: Readonly<Record<string, string>>): AgentManagedHookPlan {
  const hermesHome = env?.HERMES_HOME?.trim()
  const home = hermesHome ? resolve(hermesHome) : join(homedir(), '.hermes')
  const command = hermesHookCommand()
  const hooks = Object.fromEntries(
    HERMES_HOOK_EVENTS.map((eventName) => [eventName, [{ command, timeout: 10 }]])
  )
  const approvals = HERMES_HOOK_EVENTS.map((eventName) => ({ event: eventName, command }))
  return {
    providerId: 'hermes',
    mutations: [
      {
        path: join(home, 'config.yaml'),
        content: `${JSON.stringify({ hooks }, null, 2)}\n`,
        mode: 0o600,
        merge: { kind: 'yaml-managed-events', marker: 'agentmux-hook.js' }
      },
      {
        path: join(home, 'shell-hooks-allowlist.json'),
        content: `${JSON.stringify({ approvals }, null, 2)}\n`,
        mode: 0o600,
        merge: { kind: 'json-managed-approvals', marker: 'agentmux-hook.js' }
      }
    ]
  }
}

export function createHermesProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'hermes', label: 'Hermes', executable: 'hermes', expectedProcess: 'hermes',
      promptDelivery: 'hermes-query',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, hookEvents: true, timeline: 'complete-events', permission: 'observe',
        providerResume: false, acp: false, replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => prompt ? ['chat', '--query', prompt, ...args, '--tui'] : [...args, '--tui'],
    hook: HERMES_HOOKS,
    launchOptions: HERMES_LAUNCH_OPTIONS
  })
}