import type { SplitDirection } from './workbench-layout'
import type { WorkbenchSurface } from './workbench-tabs'
import {
  workbenchRegionPresetSize,
  type WorkbenchRegionLayoutPreset
} from './workbench-view-layout'

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

export type WorkbenchRegionPresetAction = {
  preset: WorkbenchRegionLayoutPreset
  label: string
}

const WORKBENCH_REGION_PRESET_LABELS: ReadonlyArray<WorkbenchRegionPresetAction> = [
  { preset: 'columns-3', label: '3 Columns' },
  { preset: 'grid-4', label: '2 × 2 Grid' },
  { preset: 'grid-6', label: '2 × 3 Grid' },
  { preset: 'grid-9', label: '3 × 3 Grid' }
]

/**
 * 「这个 Tab 能摆成哪些预设，以及点下去做什么」——一次判定，同时决定菜单列哪几项和点了发什么。
 *
 * 预设的格数**只增不减**：`arrangeWorkbenchControlTab` 对格数已经超过预设的 Tab 抛
 * `LAYOUT_CAPACITY_EXCEEDED`（丢格子就是丢用户正在看的东西，拒绝是对的）。于是一个已经 5 分屏的
 * Tab 摆不成 `grid-4`。这件事必须**只判一次**：如果菜单照单全列、由动作那侧去撞拒绝，用户点了
 * 只会收到一条内部错误串——而菜单本来就知道那一项不可能成功。
 *
 * 收成一个出口的理由与 `moveSessionViewMenu` 相同（也与 #325 本身相同）：容量判定留在组件里，
 * 就会有第二个消费者（键盘、命令面板）各抄一份，两份必漂移，而漂移的症状是「菜单里灰着的项
 * 从命令面板点得动」或反过来。这里 `onSelect` 已经把 tab 身份闭包进去，壳里连一个 `if` 都不剩。
 *
 * 注意这里判的是**能不能提供**，不是「补几个格」——后者仍然只住在 arrangeWorkbenchControlTab 里，
 * 这个函数连 addedRegionIds 都碰不到。
 */
export function workbenchRegionPresetMenu(input: {
  regionCount: number
  arrange: (preset: WorkbenchRegionLayoutPreset) => void
}): {
  presets: WorkbenchRegionPresetAction[]
  onSelect: (preset: WorkbenchRegionLayoutPreset) => void
} {
  return {
    presets: WORKBENCH_REGION_PRESET_LABELS.filter(
      (action) => workbenchRegionPresetSize(action.preset) >= input.regionCount
    ),
    onSelect: input.arrange
  }
}

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
