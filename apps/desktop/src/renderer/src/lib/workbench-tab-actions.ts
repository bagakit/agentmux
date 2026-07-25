import type { SplitDirection } from './workbench-layout'

export type TabCloseScope = 'others' | 'left' | 'right'

// A workspace a Session's View can be moved into. The current View's own workspace is never a target —
// moving there is a no-op — so the menu only offers real destinations.
export type MoveSessionViewTarget = { workspaceId: string; name: string }

// The explicit "Move to Workspace" menu model. Given the workspaces that actually exist and the View's
// current workspace, it lists every other workspace as a destination. Pure so the menu's contents are
// asserted without a DOM; the component only renders what this returns.
export function moveSessionViewTargets(
  workspaces: ReadonlyArray<{ id: string; name: string }>,
  currentWorkspaceId: string
): MoveSessionViewTarget[] {
  return workspaces
    .filter((workspace) => workspace.id !== currentWorkspaceId)
    .map((workspace) => ({ workspaceId: workspace.id, name: workspace.name }))
}

export const WORKBENCH_TAB_SPLIT_ACTIONS: ReadonlyArray<{
  direction: SplitDirection
  label: string
}> = [
  { direction: 'left', label: 'Split Left' },
  { direction: 'right', label: 'Split Right' },
  { direction: 'up', label: 'Split Up' },
  { direction: 'down', label: 'Split Down' }
]

export function tabIdsForCloseScope(
  tabOrder: readonly string[],
  targetTabId: string,
  scope: TabCloseScope
): string[] {
  const targetIndex = tabOrder.indexOf(targetTabId)
  if (targetIndex < 0) return []
  if (scope === 'left') return tabOrder.slice(0, targetIndex)
  if (scope === 'right') return tabOrder.slice(targetIndex + 1)
  return tabOrder.filter((tabId) => tabId !== targetTabId)
}
