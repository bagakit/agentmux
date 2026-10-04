import { AgentMuxError } from '../errors.js'
import type { AgentProviderHookActivation, AgentProviderHookActivationContext } from '../agent-provider.js'
import { withCodexNativeRead } from './codex-native-read.js'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Native Hook metadata is invalid.', 'INVALID_AGENT_HOOK_RESPONSE')
  return value as Record<string, unknown>
}

/** Match the current generated plan to Codex's effective definitions; native trust is never guessed. */
export async function inspectCodexHookActivation(context: AgentProviderHookActivationContext): Promise<AgentProviderHookActivation> {
  const required = context.plan.mutations.flatMap(mutation => {
    const hooks = object(object(JSON.parse(mutation.content)).hooks)
    return Object.entries(hooks).flatMap(([event, value]) => {
      if (!Array.isArray(value)) throw new AgentMuxError('Codex Hook plan bucket is invalid.', 'INVALID_HOOK_PLAN')
      return value.flatMap(value => {
        const group = object(value)
        if (!Array.isArray(group.hooks)) throw new AgentMuxError('Codex Hook plan group is invalid.', 'INVALID_HOOK_PLAN')
        return group.hooks.map(value => {
          const handler = object(value)
          if (handler.type !== 'command' || typeof handler.command !== 'string' || typeof handler.timeout !== 'number') {
            throw new AgentMuxError('Codex Hook plan command is invalid.', 'INVALID_HOOK_PLAN')
          }
          return { sourcePath: mutation.path, eventName: event[0]!.toLowerCase() + event.slice(1),
            command: handler.command, matcher: group.matcher ?? null, timeoutSec: handler.timeout, async: handler.async ?? false }
        })
      })
    })
  })
  if (required.length === 0) throw new AgentMuxError('Codex Hook plan is empty.', 'INVALID_HOOK_PLAN')
  return await withCodexNativeRead(context, 'hooks', async request => {
    const result = object(await request('hooks/list', { cwds: [context.workspacePath] }))
    if (!Array.isArray(result.data) || result.data.length !== 1) throw new AgentMuxError('Native Hook workspace is invalid.', 'INVALID_AGENT_HOOK_RESPONSE')
    const entry = object(result.data[0])
    if (entry.cwd !== context.workspacePath || !Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || !Array.isArray(entry.warnings)) {
      throw new AgentMuxError('Native Hook scope is invalid.', 'INVALID_AGENT_HOOK_RESPONSE')
    }
    if (entry.errors.length) throw new AgentMuxError('Native Hook configuration could not be read.', 'AGENT_HOOK_READ_UNAVAILABLE')
    const hooks = entry.hooks.map(object)
    const matched = required.map(expected => hooks.filter(hook =>
      hook.sourcePath === expected.sourcePath && hook.source === 'project' && hook.handlerType === 'command' &&
      hook.eventName === expected.eventName && hook.command === expected.command && hook.matcher === expected.matcher &&
      hook.timeoutSec === expected.timeoutSec && hook.async === expected.async))
    if (matched.some(definitions => definitions.length !== 1)) return { active: false, code: 'HOOK_NATIVE_DEFINITIONS_UNCONFIRMED',
      action: 'The native CLI did not expose every current managed Hook definition for this workspace. Check its feature settings and project trust, then inspect again.' }
    const definitions = matched.map(definitions => definitions[0]!)
    if (definitions.some(hook => typeof hook.enabled !== 'boolean' || typeof hook.currentHash !== 'string' || !hook.currentHash ||
      !['trusted', 'untrusted', 'stale'].includes(hook.trustStatus as string))) {
      throw new AgentMuxError('Native Hook activation metadata is invalid.', 'INVALID_AGENT_HOOK_RESPONSE')
    }
    if (definitions.some(hook => hook.enabled === false)) return { active: false, code: 'HOOK_NATIVE_DISABLED',
      action: 'Managed Hooks are present but disabled in the native CLI configuration. Review that setting, then inspect again.' }
    if (definitions.some(hook => hook.trustStatus !== 'trusted')) return { active: false, code: 'HOOK_NATIVE_TRUST_UNCONFIRMED',
      action: 'Managed Hooks are present but their current definitions are not trusted. Review their definitions through the native CLI, then inspect again.' }
    return { active: true, code: 'HOOK_NATIVE_CURRENT_AND_TRUSTED', action: null }
  })
}
