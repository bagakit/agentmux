import { CODEX_HOOK_SOURCE_PATH, codexHookTrustBypassed, type createCodexLaunchHooks } from './launch-hooks.js'
import type { AppServerNativeReadContext, createAppServerNativeRead } from '../app-server/native-read.js'
import type { NativeProviderError } from '../provider-error.js'

/** Inspect the exact native definitions using the configured launch and read-only invocation. */
export function createCodexHookActivation({ AgentMuxError, withAppServerNativeRead, codexManagedHooks, withCodexLaunchHooks }: {
  AgentMuxError: NativeProviderError
  withAppServerNativeRead: ReturnType<typeof createAppServerNativeRead>
} & Pick<ReturnType<typeof createCodexLaunchHooks>, 'codexManagedHooks' | 'withCodexLaunchHooks'>) {
  function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Native Hook metadata is invalid.', 'INVALID_AGENT_HOOK_RESPONSE')
    return value as Record<string, unknown>
  }

  /** Match the launch-carried definitions to the private native reader's effective session flags. */
  return async function inspectCodexHookActivation(context: AppServerNativeReadContext): Promise<{ active: boolean; code: string; action: string | null }> {
    const configured = withCodexLaunchHooks(context.args)
    if (configured.issue) return { active: false, code: 'HOOK_LAUNCH_CONFIGURATION_UNCONFIRMED',
      action: configured.issue + ' Review those original flags, then inspect again.' }
    const required = Object.entries(codexManagedHooks()).flatMap(([event, groups]) => groups.flatMap(group => group.hooks.map(hook => ({
      sourcePath: CODEX_HOOK_SOURCE_PATH, eventName: event[0]!.toLowerCase() + event.slice(1),
      command: hook.command, matcher: group.matcher ?? null, timeoutSec: hook.timeout, async: false
    }))))
    const bypass = codexHookTrustBypassed(context.args)
    return await withAppServerNativeRead({ ...context, args: configured.args }, 'hooks', async request => {
      const result = object(await request('hooks/list', { cwds: [context.workspacePath] }))
      if (!Array.isArray(result.data) || result.data.length !== 1) throw new AgentMuxError('Native Hook workspace is invalid.', 'INVALID_AGENT_HOOK_RESPONSE')
      const entry = object(result.data[0])
      if (entry.cwd !== context.workspacePath || !Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || !Array.isArray(entry.warnings)) {
        throw new AgentMuxError('Native Hook scope is invalid.', 'INVALID_AGENT_HOOK_RESPONSE')
      }
      if (entry.errors.length) throw new AgentMuxError('Native Hook configuration could not be read.', 'AGENT_HOOK_READ_UNAVAILABLE')
      const hooks = entry.hooks.map(object)
      const matched = required.map(expected => hooks.filter(hook =>
        hook.sourcePath === expected.sourcePath && hook.source === 'sessionFlags' && hook.handlerType === 'command' &&
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
      if (definitions.some(hook => hook.trustStatus !== 'trusted' && !(bypass && hook.trustStatus === 'untrusted'))) return { active: false, code: 'HOOK_NATIVE_TRUST_UNCONFIRMED',
        action: 'Managed Hooks are present but their current definitions are not trusted. Review their definitions through the native CLI, then inspect again.' }
      return { active: true, code: 'HOOK_NATIVE_CURRENT_AND_TRUSTED', action: null }
    })
  }
}
