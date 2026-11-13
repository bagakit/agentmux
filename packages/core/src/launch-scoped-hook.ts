/**
 * Launch-carried Hooks: the mark on a call this launch declared, and the leftover rule the runner applies.
 *
 * A leaf module with no imports, because the Hook runner loads it on every Provider event and must not
 * pull in the installer, config merge or Provider registry to answer one comparison.
 */
export const LAUNCH_SCOPED_HOOK_FLAG = '--launch-scoped'

/**
 * In a Run whose Hooks travel with the launch, a Hook call without the launch mark comes from an
 * AgentMux entry an earlier version wrote into the workspace. The Provider still runs it; it must not
 * deliver a second copy of an event the launch-carried Hook already delivers.
 */
export function isLeftoverHookInvocation(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): boolean {
  return env.AGENTMUX_HOOK_LAUNCH_SCOPED === '1' && !argv.includes(LAUNCH_SCOPED_HOOK_FLAG)
}
