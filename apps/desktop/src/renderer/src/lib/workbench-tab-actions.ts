import type { SplitDirection } from './workbench-layout'
import type { WorkbenchSurface } from './workbench-tabs'

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

/**
 * 「这一格能不能被移动，以及移动它要送哪个 Region」——一次判定，同时决定菜单里列不列目的地
 * 和点下去做什么。
 *
 * 只有承载 Session 的投影才可移动：file / launcher / browser 一格没有 Session 身份可搬，于是
 * 目的地为空，菜单那一节整段不出现。
 *
 * 收成一个出口是因为组件里那两处此前各自判一次，而两次判定都无人守（实测，move-session-view.test.ts
 * 17 条）：把清单与动作的三元分支调换（点了目的地什么也不发生，菜单反而在不可移动的一格上列出
 * 目的地），tsc 沉默、17 条全绿；把判据从 `agent || terminal` 收成只认 `agent`（终端一格悄悄
 * 不能移动了），同样 tsc 沉默、17 条全绿。
 *
 * 现在两者出自同一个返回值：菜单列 `targets`，点下去调 `onSelect`——两者要么都来自同一次
 * `kind` 判定，要么都是空的。组件里没有第二次判定可以与第一次不一致，`onSelect` 也已经把
 * regionId 闭包进去了，于是那层壳里连一个 `if` 都不剩（同 terminalInputSender 的收法）。
 * 而这个函数真跑得到。
 */
export function moveSessionViewMenu(input: {
  surface: WorkbenchSurface
  workspaces: ReadonlyArray<{ id: string; name: string }>
  currentWorkspaceId: string
  move: (regionId: string, targetWorkspaceId: string) => void
}): { targets: MoveSessionViewTarget[]; onSelect: (targetWorkspaceId: string) => void } {
  if (input.surface.kind !== 'agent' && input.surface.kind !== 'terminal') {
    return { targets: [], onSelect: () => {} }
  }
  const regionId = input.surface.regionId
  return {
    targets: moveSessionViewTargets(input.workspaces, input.currentWorkspaceId),
    onSelect: (targetWorkspaceId) => input.move(regionId, targetWorkspaceId)
  }
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
