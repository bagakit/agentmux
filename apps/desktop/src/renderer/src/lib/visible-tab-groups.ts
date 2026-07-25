// Which tab groups are actually rendered right now. Pulled out because "what is on screen" is the
// load-bearing input to whether a person gets interrupted, and getting it wrong is silent in both
// directions: too broad suppresses real completions, too narrow interrupts someone mid-read.
export function visibleTabGroupsForState(state: {
  mainSurface: string
  activeWorkspaceId?: string | null
  layouts?: Record<string, { groups?: readonly { activeTabId: string | null }[] }>
}): readonly { activeTabId: string | null }[] {
  // The Board replaces the workbench entirely, so no Session occupies a Region while it is open.
  if (state.mainSurface !== 'workbench') return []
  if (!state.activeWorkspaceId) return []
  return state.layouts?.[state.activeWorkspaceId]?.groups ?? []
}
