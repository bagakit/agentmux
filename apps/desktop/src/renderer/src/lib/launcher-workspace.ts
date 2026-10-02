/** One execution target for the Launcher summary and every creation consumer.
 * A Region owns its future resource; its Tab owns display placement. Empty Groups
 * still use their display Workspace until an explicit choice creates a durable Region.
 * Required fields make a consumer that omits the Region target a type error.
 */
export function resolveLauncherWorkspaceId(input: {
  launcherWorkspaceId: string | undefined
  launcherTabWorkspaceId: string | undefined
  activeWorkspaceId: string | null
}): string | null {
  return input.launcherWorkspaceId ?? input.launcherTabWorkspaceId ?? input.activeWorkspaceId
}
