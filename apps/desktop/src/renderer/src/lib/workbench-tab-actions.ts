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

/** 一格能和之交换位置的一个目标：换到哪一格、菜单上画什么字、点了做什么。 */
export type RegionSwapMenuEntry = {
  targetRegionId: string
  label: string
  onSelect(): void
}

/**
 * 「这一格能和谁换位置，点了换哪个」——一次判定，同时决定菜单列哪几项和点了发什么（#471）。
 *
 * 与 `workbenchSplitMenuEntries` / `moveSessionViewMenu` 同一个形状与同一个理由：清单与动作出自
 * 同一个返回值，`onSelect` 已把「源格 + 目标格」这一对闭包进去，渲染层因此只 map、无条件可写。
 * 自己不在清单里——和自己换是 no-op（`swapWorkbenchRegions` 也会把它当 no-op），画出来只是噪音。
 *
 * `regions` 是这张 Tab 的每一格「id + 显示名」，由组件按既有的表面派生（文件名 / 会话 label /
 * 浏览器标题）**按视觉顺序**算好传进来；本模块不认表面种类，只负责「排除自己、拼动词、把源与目标
 * 配对」这一件事。换位的合法性（两个端点都要在场）由 `swapWorkbenchRegions` 自己守，这里不重判——
 * 那会是第二份判据。
 *
 * 同名多格要编号，否则菜单里两条一模一样的项（两个终端都是「Swap with Terminal」、两个同名文件、
 * 两个 New Tab）根本无从区分——而分辨「和哪一格换」正是这份 label 唯一的用处。编号按出现次序
 * （即调用方给的视觉顺序）算，且**覆盖全体、含自己**：这样不管右键点中哪一格，某一格的编号都稳定
 * （右键中间那个终端时，目标仍是「Terminal 1」「Terminal 3」而非被重新数成 1、2）。标签唯一时保持
 * 裸名，不无谓地加「1」。
 */
export function regionSwapMenuEntries(input: {
  regionId: string
  regions: ReadonlyArray<{ regionId: string; label: string }>
  swap: (regionIdA: string, regionIdB: string) => void
}): readonly RegionSwapMenuEntry[] {
  const labelTotals = new Map<string, number>()
  for (const region of input.regions) {
    labelTotals.set(region.label, (labelTotals.get(region.label) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return input.regions
    .map((region) => {
      const ordinal = (seen.get(region.label) ?? 0) + 1
      seen.set(region.label, ordinal)
      const display =
        (labelTotals.get(region.label) ?? 0) > 1 ? `${region.label} ${ordinal}` : region.label
      return { regionId: region.regionId, display }
    })
    .filter((region) => region.regionId !== input.regionId)
    .map((region) => ({
      targetRegionId: region.regionId,
      label: `Swap with ${region.display}`,
      onSelect: () => input.swap(input.regionId, region.regionId)
    }))
}

/**
 * 「分屏与重排这一节要画哪几项、什么顺序、哪里断一道线」——四个容器共用的**唯一**那份清单。
 *
 * 为什么必须只有一份：这一节现在出现在四个地方——Tab 条上的 Split 下拉、Tab 右键菜单、
 * 一格的右键菜单、以及点链接时的目的地选择器。前两个此前各自把 `WORKBENCH_TAB_SPLIT_ACTIONS`
 * map 一遍，并各自维护一份逐字相同的方向→图标映射；再给后两个各加一份，就是本仓
 * duplicated-rule-defeats-the-fix 那一族的第三、第四份。那族的症状不是报错：改一处（比如给
 * 预设加一档、或调一次顺序）只会让**没跟上的那几个容器静默保留旧清单**，而每个容器各自的
 * 测试照旧全绿——因为它们各自断言的是自己那份。
 *
 * 分隔线只在两侧都真有东西时才出现：一条贴在顶上或悬在底下的线是噪音（与 RegionContextMenu
 * 的 `regionMenuEntries` 同一条规矩）。预设那一组会因为格数超限而整组消失
 * （`workbenchRegionPresetMenu` 判的），所以「有没有分隔线」不能写成常量。
 *
 * `onSelect` 已经把该发什么闭包进去，容器里因此连一个 `if` 都不剩，只有一次 map——
 * 这是本仓能挡住「JSX 里塞 `{false && …}` 让整项永不渲染而 grep 全绿」的唯一形状
 * （Radix 的 Content 默认关闭且在 Portal 里，renderToStaticMarkup 渲不出它）。
 */
export type WorkbenchSplitMenuEntry =
  | { kind: 'split'; direction: SplitDirection; label: string; onSelect(): void }
  | { kind: 'preset'; preset: WorkbenchRegionLayoutPreset; label: string; onSelect(): void }
  | { kind: 'separator' }

export function workbenchSplitMenuEntries(input: {
  /** 这个 Tab 现在有几格。预设只增不减，故它决定预设那一组列不列得出来。 */
  regionCount: number
  split: (direction: SplitDirection) => void
  arrange: (preset: WorkbenchRegionLayoutPreset) => void
}): readonly WorkbenchSplitMenuEntry[] {
  const splits: WorkbenchSplitMenuEntry[] = WORKBENCH_TAB_SPLIT_ACTIONS.map((action) => ({
    kind: 'split',
    direction: action.direction,
    label: action.label,
    onSelect: () => input.split(action.direction)
  }))
  // 容量判定不在这里重做一遍：它只住在 workbenchRegionPresetMenu 里（那份注释说明了为什么）。
  const presetMenu = workbenchRegionPresetMenu({
    regionCount: input.regionCount,
    arrange: input.arrange
  })
  const presets: WorkbenchSplitMenuEntry[] = presetMenu.presets.map((action) => ({
    kind: 'preset',
    preset: action.preset,
    label: action.label,
    onSelect: () => presetMenu.onSelect(action.preset)
  }))
  if (presets.length === 0) return splits
  return [...splits, { kind: 'separator' }, ...presets]
}

