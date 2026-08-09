import type { AgentMuxArrangeMode } from '@agentmux/core/control'
import type { WorkbenchSurface } from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'
import {
  workbenchRegionPresetSize,
  type SplitDirection,
  type WorkbenchRegionLayoutPreset
} from '@agentmux/layout'

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
  if (!isSessionSurface(input.surface)) {
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

/**
 * 每一档预设的菜单措辞与顺序。
 *
 * 写成 `as const satisfies` 而不是加类型标注（`: ReadonlyArray<WorkbenchRegionPresetAction>`），是为了让
 * 下面那道 exactness 证明能真正发红：标注会把 `preset` 拓宽成整个 union，于是「这张表少列一档」在类型层
 * 彻底不可观测。`satisfies` 既留住字面量、又照旧校验每一项都是合法的预设名。
 */
const WORKBENCH_REGION_PRESET_LABELS = [
  { preset: 'columns-3', label: '3 Columns' },
  { preset: 'grid-4', label: '2 × 2 Grid' },
  { preset: 'grid-6', label: '2 × 3 Grid' },
  { preset: 'grid-9', label: '3 × 3 Grid' }
] as const satisfies ReadonlyArray<WorkbenchRegionPresetAction>

/**
 * 「不依赖格数的重排」这两档：均分、把当前格挪到第一位。
 *
 * 与预设那一组分开列，是因为两者的**可用条件不同**，不是因为长得不一样：预设要补格子，所以格数超了
 * 就整组消失（`workbenchRegionPresetMenu` 判的）；这两档只重排已在场的格子，不增不减，所以只要
 * 有得排（≥2 格）就永远可用。把它们混进预设那一组，就会跟着预设一起被容量判定误杀——一张 5 分屏的
 * Tab 恰恰是最需要「均分一下」的那张，而它摆不成任何预设。
 *
 * 引擎（`arrangeWorkbenchControlTab`）从一开始就支持这三档，控制协议的 `AgentMuxArrangeMode` 也是。
 * 缺的只是 GUI 表达不出后两档（#486）——不是缺一个菜单项，是 store 那个 action 的签名只收 preset，
 * 把它们挡在了外面。
 */
const WORKBENCH_REGION_REARRANGE_LABELS = [
  { mode: { kind: 'balance' }, label: 'Even Split' },
  { mode: { kind: 'active-first' }, label: 'Focused First' }
] as const satisfies ReadonlyArray<{ mode: WorkbenchRegionRearrangeMode; label: string }>

/** 不依赖格数的那两档重排。刻意是 `AgentMuxArrangeMode` 的子集，不是另一个平行的枚举。 */
export type WorkbenchRegionRearrangeMode = Exclude<AgentMuxArrangeMode, { kind: 'preset' }>

/**
 * 两张措辞表各自「不多不少，恰好覆盖它那个 union」的双向证明。
 *
 * 为什么需要它：#486 的教训不是「少了两个菜单项」，而是**引擎支持的档位在 GUI 里静默不可达**——而那
 * 一次是签名挡住的，这一次会是措辞表挡住的。今天给核心的预设 union 加第五档，`presetColumns`（穷举
 * switch，TS2366）与 `PRESET_ICONS`（`satisfies Record`）都会响亮地报错，唯独上面这两张表不会：它们
 * 只是数组，少列一项完全合法。症状与 #486 逐字相同——CLI 能摆，菜单里没有，而每个容器自己的测试照旧
 * 全绿。同理，给 `AgentMuxArrangeMode` 加第三档重排，`REARRANGE_ICONS` 会报错而措辞表不会。
 *
 * 两个方向都要写：`表 ⊆ union` 抓「表里写了个不存在的档」（`satisfies` 也抓这一半），`union ⊆ 表`
 * 抓真正危险的那一半——「union 长了而表没跟上」。任一半是 `never` 都不能赋给 `true` 的槽位，于是漂移
 * 是一处点名了是哪个方向失败的编译错误。形状与 `packages/core/src/workbench-layout-preset.ts` 里
 * `_presetTupleIsExactlyTheUnion` 相同，理由也相同——包括那里写明的「union 不可从表派生」：若从表派生，
 * 两个方向都退化成自反的 `true`，证明成为永不失败的死代码。这两个 union 都在别处独立写着
 *（预设在 core 的 `WorkbenchLayoutPreset`，重排在 `AgentMuxArrangeMode`），所以证明是活的。
 */
type PresetLabelEntry = (typeof WORKBENCH_REGION_PRESET_LABELS)[number]['preset']
type RearrangeLabelEntry = (typeof WORKBENCH_REGION_REARRANGE_LABELS)[number]['mode']['kind']
const _labelTablesAreExactlyTheirUnions: [
  PresetLabelEntry extends WorkbenchRegionLayoutPreset ? true : never,
  WorkbenchRegionLayoutPreset extends PresetLabelEntry ? true : never,
  RearrangeLabelEntry extends WorkbenchRegionRearrangeMode['kind'] ? true : never,
  WorkbenchRegionRearrangeMode['kind'] extends RearrangeLabelEntry ? true : never
] = [true, true, true, true]
void _labelTablesAreExactlyTheirUnions


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
  arrange: (mode: AgentMuxArrangeMode) => void
}): {
  presets: WorkbenchRegionPresetAction[]
  onSelect: (preset: WorkbenchRegionLayoutPreset) => void
} {
  return {
    presets: WORKBENCH_REGION_PRESET_LABELS.filter(
      (action) => workbenchRegionPresetSize(action.preset) >= input.regionCount
    ),
    onSelect: (preset) => input.arrange({ kind: 'preset', preset })
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
  | { kind: 'rearrange'; mode: WorkbenchRegionRearrangeMode; label: string; onSelect(): void }
  | { kind: 'separator' }

/**
 * 「重排」那一节本身：预设 + 不依赖格数的那两档。刻意与「分屏方向」分开成一个可单独取用的清单，
 * 因为**有一个容器只要这一节**——Tab 的右键菜单里，分屏方向那一组是另一个动作（`onMoveToNewGroup`，
 * 搬 Tab 开新分组，不是给这张 Tab 分格），于是它的「Rearrange Splits」子菜单只画这一节。
 *
 * 抽出来的理由是那个容器此前自己 map 了一遍 `workbenchRegionPresetMenu().presets`、自己调
 * `workbenchRegionPresetIcon`、自己用 `presets.length > 0` 判整节在不在场——那就是本仓
 * duplicated-rule-defeats-the-fix 的第二份：给这一节加一档（正是 #486 要做的事）时，没跟上的那个
 * 容器静默保留旧清单，而它自己的测试照旧全绿。现在两个消费者都 map 同一个返回值，"这一节有没有
 * 东西" 也只有一个答案（`length > 0`），不存在一个容器认为有、另一个认为没有。
 */
export type WorkbenchRegionLayoutMenuEntry = Extract<
  WorkbenchSplitMenuEntry,
  { kind: 'preset' | 'rearrange' }
>

export function workbenchRegionLayoutMenuEntries(input: {
  /** 这个 Tab 现在有几格。预设只增不减，故它决定预设那一组列不列得出来。 */
  regionCount: number
  arrange: (mode: AgentMuxArrangeMode) => void
}): readonly WorkbenchRegionLayoutMenuEntry[] {
  // 容量判定不在这里重做一遍：它只住在 workbenchRegionPresetMenu 里（那份注释说明了为什么）。
  const presetMenu = workbenchRegionPresetMenu({
    regionCount: input.regionCount,
    arrange: input.arrange
  })
  const presets: WorkbenchRegionLayoutMenuEntry[] = presetMenu.presets.map((action) => ({
    kind: 'preset',
    preset: action.preset,
    label: action.label,
    onSelect: () => presetMenu.onSelect(action.preset)
  }))
  // 均分与「当前格优先」只重排已在场的格子，故它们的在场条件是「有得排」而不是容量：单格的 Tab
  // 里两者都是 no-op（`balanceNode` 对叶子原样返回，`placeActiveWorkbenchRegionFirst` 首格已是
  // 活动格时原样返回），画出来只是一个点了什么都不发生的按钮，所以以缺席表达。
  const rearranges: WorkbenchRegionLayoutMenuEntry[] =
    input.regionCount > 1
      ? WORKBENCH_REGION_REARRANGE_LABELS.map((action) => ({
          kind: 'rearrange',
          mode: action.mode,
          label: action.label,
          onSelect: () => input.arrange(action.mode)
        }))
      : []
  return [...presets, ...rearranges]
}

export function workbenchSplitMenuEntries(input: {
  /** 这个 Tab 现在有几格。预设只增不减，故它决定预设那一组列不列得出来。 */
  regionCount: number
  split: (direction: SplitDirection) => void
  arrange: (mode: AgentMuxArrangeMode) => void
}): readonly WorkbenchSplitMenuEntry[] {
  const splits: WorkbenchSplitMenuEntry[] = WORKBENCH_TAB_SPLIT_ACTIONS.map((action) => ({
    kind: 'split',
    direction: action.direction,
    label: action.label,
    onSelect: () => input.split(action.direction)
  }))
  const layout = workbenchRegionLayoutMenuEntries({
    regionCount: input.regionCount,
    arrange: input.arrange
  })
  // 重排那一节可以整节缺席（预设被容量毙掉、且只有一格没得排），故分隔线不能写成常量：
  // 只在它前后**都真有东西**时才插一条。一条贴在顶上或悬在底下的线是噪音。
  if (layout.length === 0) return splits
  return [...splits, { kind: 'separator' }, ...layout]
}

