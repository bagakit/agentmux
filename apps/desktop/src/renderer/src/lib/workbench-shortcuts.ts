// Workbench 命令与落点解析层——纯函数，不碰窗口。哪个键触发哪个动作、平台切分、非终端可编辑控件的
// 门，全部收进了 `shortcut-registry.ts`（SSOT，那条「非 mac 绝不吃裸 Ctrl+字母」的底线在那里只表达
// 一次）。本文件只负责：把注册表匹配出的**绑定 id** 翻译成一个具体命令，再把命令解析成落点（哪个
// Workspace/Tab/Region）并转发到 store action。
//
// 判定为什么留在纯函数里（与注册表同一个理由）：本仓库组件测试用 `renderToStaticMarkup`，effect 不
// 跑、也发不出 DOM 事件，写进 App 的 `useEffect` 里的分支没有断言够得着。所以「这个 id 是哪个命令、
// 落到哪张 Tab/哪一格」这些承重判定全留在这里，App 的监听器只做无分支的转发与 preventDefault。

import { regionIds, workbenchRegionBounds, type WorkbenchViewLayout } from './workbench-view-layout'
import type { SplitDirection, WorkspaceLayout } from './workbench-layout'
import type { WorkbenchTab } from './workbench-tabs'
import { activeTopicIdFromLayout, layoutForActiveTopic } from './scratch-topic-layout'
import { SHORTCUT_BINDINGS } from './shortcut-registry'

/**
 * 一次按键解析出的命令——已经定到「哪个动作、往哪个方向、第几张」，但**落点（哪个 Workspace/Tab/
 * Region）留给落点解析**：落点要读按下那一刻的实时 store 投影，纯判定层不该也够不着那份状态。
 */
export type WorkbenchShortcutCommand =
  /** 按序号切 Tab；`ordinal` 是 1 基绝对序号，`'last'` 恒指最后一张。 */
  | { kind: 'select-tab'; ordinal: number | 'last' }
  /** 关闭当前焦点 Region。 */
  | { kind: 'close-region' }
  /** 沿 `direction` 分出一格。 */
  | { kind: 'split'; direction: SplitDirection }
  /** 把焦点移到 `direction` 方向上相邻的那一格 Region。 */
  | { kind: 'focus-region'; direction: SplitDirection }

/**
 * 这个和弦是否落在「非终端的可编辑控件」里——Agent composer 的文本框、Tab 内联重命名框这类原生输入。
 *
 * 窗口级 capture 监听存在的唯一理由，是抢在聚焦的 xterm 文本代理之前拿到键（终端要独占它们）。所以
 * **终端里的输入不放行**（`insideTerminal` 为真时返回 false，让快捷键照常接管）；但普通表单控件里用户是
 * 在打字/改名，Cmd+D 不该顺手把这一格分屏、Cmd+W 不该关掉正在打字的那一格。DOM 侧由 App 判定
 * `insideTerminal`（`.xterm` 子树内即为真），这里只做与 DOM 无关的纯判定，测试够得着。
 */
export function isEditableChordTarget(target: {
  tagName: string
  isContentEditable: boolean
  insideTerminal: boolean
}): boolean {
  if (target.insideTerminal) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

/**
 * 把一个 workbench 绑定 id 翻译成命令。id 由注册表匹配得出（`matchShortcut` scope `window`），这里只做
 * 「id → 命令」这一步纯翻译，不认识的 id（比如 quick-switch.toggle 这类非 workbench 动作）返回 null。
 */
export function commandForWorkbenchId(id: string): WorkbenchShortcutCommand | null {
  const selectTab = id.match(/^workbench\.select-tab\.(\d)$/)
  if (selectTab) {
    const digit = selectTab[1]!
    // 1..8 是绝对序号；9 恒指最后一张（浏览器/终端惯例：第 9 个键跳末尾，而不是要求正好九张）。
    return { kind: 'select-tab', ordinal: digit === '9' ? 'last' : Number(digit) }
  }
  if (id === 'workbench.close-region') return { kind: 'close-region' }
  if (id === 'workbench.split.right') return { kind: 'split', direction: 'right' }
  if (id === 'workbench.split.down') return { kind: 'split', direction: 'down' }
  if (id === 'workbench.focus-region.left') return { kind: 'focus-region', direction: 'left' }
  if (id === 'workbench.focus-region.right') return { kind: 'focus-region', direction: 'right' }
  if (id === 'workbench.focus-region.up') return { kind: 'focus-region', direction: 'up' }
  if (id === 'workbench.focus-region.down') return { kind: 'focus-region', direction: 'down' }
  return null
}

/**
 * 序号落到哪张 Tab。1 基；`'last'` 取末尾。越界不回绕——按了不存在的序号当没按，回绕会把
 * 「跳到第 5 张」变成难以预料的落点。
 */
export function tabIdForOrdinal(
  tabOrder: readonly string[],
  ordinal: number | 'last'
): string | null {
  if (ordinal === 'last') return tabOrder.at(-1) ?? null
  return tabOrder[ordinal - 1] ?? null
}

/**
 * 焦点格沿 `direction` 的相邻 Region。
 *
 * 用归一化几何（`workbenchRegionBounds`）而不是遍历分屏树：树的父子关系不等于屏幕上的上下左右，
 * 一个嵌套分屏里「右边那一格」可能在树上隔着好几层。几何是用户眼里方向的唯一真相。
 *
 * 选法：先筛出在该方向确实更靠外的候选（左/右比较 x、上/下比较 y），再取其中最贴近当前格的那个——
 * 主轴距离最小、主轴相同再取另一轴中心最近。`workbenchRegionBounds` 永远是单位面的完整平铺，所以
 * 「同一行/列里紧挨着的那格」必然存在且另一轴中心最近，斜对角格因中心偏得更远自然落选，不需要另设
 * 重叠判定去挡它。没有相邻格（已在边缘、或没分屏）时返回 `null`。
 */
export function adjacentRegionId(
  layout: WorkbenchViewLayout,
  direction: SplitDirection
): string | null {
  const bounds = workbenchRegionBounds(layout.root)
  const active = bounds.find((entry) => entry.regionId === layout.activeRegionId)
  if (!active || regionIds(layout.root).length <= 1) return null
  const a = active.bounds
  const aCenterX = a.x + a.width / 2
  const aCenterY = a.y + a.height / 2

  const horizontal = direction === 'left' || direction === 'right'
  const candidates = bounds.filter((entry) => {
    if (entry.regionId === active.regionId) return false
    const b = entry.bounds
    if (horizontal) {
      return direction === 'right' ? b.x >= a.x + a.width - 1e-9 : b.x + b.width <= a.x + 1e-9
    }
    return direction === 'down' ? b.y >= a.y + a.height - 1e-9 : b.y + b.height <= a.y + 1e-9
  })
  if (candidates.length === 0) return null

  // 最贴近的一格：按主轴距离取最小，主轴相同再按另一轴中心距离取最小，落点稳定。另一轴中心距离正是
  // 「同一行/列」的连续量化——紧邻格中心对齐（距离≈0），斜对角格中心偏开，于是前者胜出。
  return candidates.reduce((best, entry) => {
    const distance = mainAxisDistance(entry.bounds, a, direction)
    const bestDistance = mainAxisDistance(best.bounds, a, direction)
    if (distance < bestDistance - 1e-9) return entry
    if (distance > bestDistance + 1e-9) return best
    const cross = horizontal
      ? Math.abs(entry.bounds.y + entry.bounds.height / 2 - aCenterY)
      : Math.abs(entry.bounds.x + entry.bounds.width / 2 - aCenterX)
    const bestCross = horizontal
      ? Math.abs(best.bounds.y + best.bounds.height / 2 - aCenterY)
      : Math.abs(best.bounds.x + best.bounds.width / 2 - aCenterX)
    return cross < bestCross ? entry : best
  }).regionId
}

function mainAxisDistance(
  candidate: { x: number; y: number; width: number; height: number },
  active: { x: number; y: number; width: number; height: number },
  direction: SplitDirection
): number {
  switch (direction) {
    case 'right': return candidate.x - (active.x + active.width)
    case 'left': return active.x - (candidate.x + candidate.width)
    case 'down': return candidate.y - (active.y + active.height)
    case 'up': return active.y - (candidate.y + candidate.height)
  }
}

/** 落点解析 + 转发所需的最小 store 切片。App 直接把 store 快照传进来（它是这个类型的超集）。 */
export type WorkbenchShortcutStore = {
  mainSurface: string
  activeWorkspaceId: string | null
  layouts: Readonly<Record<string, WorkspaceLayout>>
  tabs: Readonly<Record<string, WorkbenchTab>>
  activateTab(workspaceId: string, tabGroupId: string, tabId: string): void
  // 保留在类型里但键盘层不再直接调它：真正的关格在组件消费 requestCloseRegion 后才发生。留着是因为接线
  // 测试要能断言「键盘路没有裸调 closeRegion」——删掉它 vitest 只转译不查类型，回退到裸调时运行期照样
  // 静默丢改动而不报错，那条守卫就抓不住了。
  closeRegion(workspaceId: string, tabId: string, regionId: string): void | Promise<void>
  // 关整张 Tab（含未保存/在跑 Agent 的确认）走的是这条「意图」而不是 store.closeTab：那份确认只活在
  // 组件里（requestTabsClose→ConfirmationDialog），裸调 store.closeTab 会静默弃掉未存改动、停掉在跑的
  // Agent——鼠标点 X 都不会那样。所以键盘关 Tab 只投一个意图，交给活动 Tab 组件用它既有的确认流处理。
  requestCloseTab(workspaceId: string, tabGroupId: string, tabId: string): void
  // 关某一格 Region 同理：那格的未保存确认（dirty→对话框）只活在承载它的组件里，与鼠标点这一格的 X 是
  // 同一个决定出口。键盘裸调 closeRegion 会静默弃掉未存改动，所以多格时也只投意图、由那一格消费。
  requestCloseRegion(workspaceId: string, tabId: string, regionId: string): void
  splitRegion(workspaceId: string, tabId: string, regionId: string, direction: SplitDirection): void
  focusRegion(workspaceId: string, tabId: string, regionId: string): void
}

/**
 * 把一条命令解析成落点并转发到 store action，返回是否吃下了这个键。
 *
 * 把落点解析收进这一个纯函数，是为了让「该不该 preventDefault」以及「落点怎么从 store 投影出来」这两处
 * 决定都能被断言——它们若留在 App 的 `useEffect` 里，本仓库 `renderToStaticMarkup` 不跑 effect，断言
 * 够不着（f-2248f4yx5 的 Cmd+S 教训：删掉注册那行，判定测试全绿，只有接线测试会红）。落点沿用组件层
 * 同一条派生：投影出当前 Topic 的 layout → 活动组 → 活动 Tab → 活动 Region，序号和方向就与用户眼前所见
 * 对齐。
 *
 * 返回 `true` 表示已执行动作、调用方应 preventDefault；`false` 表示落点解析失败，原样放行。
 */
export function dispatchWorkbenchCommand(
  command: WorkbenchShortcutCommand,
  store: WorkbenchShortcutStore
): boolean {
  // 快捷键只作用于 Workbench 面；Board 等其他主面不接管这些键。
  if (store.mainSurface !== 'workbench') return false
  const workspaceId = store.activeWorkspaceId
  const storedLayout = workspaceId ? store.layouts[workspaceId] : undefined
  if (!workspaceId || !storedLayout) return false
  // 投影出与 Workbench 渲染相同的 Topic 过滤后 layout，让序号与活动组/Tab 恰好对上用户所见。
  const layout = layoutForActiveTopic(
    storedLayout,
    store.tabs,
    activeTopicIdFromLayout(storedLayout, store.tabs)
  )
  const group = layout.groups.find((candidate) => candidate.id === layout.activeGroupId)
  if (!group) return false

  if (command.kind === 'select-tab') {
    const tabId = tabIdForOrdinal(group.tabOrder, command.ordinal)
    if (!tabId) return false
    store.activateTab(workspaceId, group.id, tabId)
    return true
  }

  const tabId = group.activeTabId
  const tab = tabId ? store.tabs[tabId] : undefined
  if (!tabId || !tab) return false
  const activeRegionId = tab.layout.activeRegionId

  if (command.kind === 'close-region') {
    // 单 Region 的 Tab（launcher/session/file 默认都是单格，分屏是显式操作，所以任意时刻大多数 Tab
    // 都是单格）没有「格」可关：closeRegion 到 removeWorkbenchRegion 见只剩一格会静默不动。这正是任务
    // 头号诉求「关不掉」的常见现场——对齐 iTerm/VS Code「最后一格时 Cmd+W 关 Tab」，回退到关整张 Tab。
    // 关 Tab 必须走确认流（见 requestCloseTab 注释），不能裸调 closeRegion 或 store.closeTab。
    if (regionIds(tab.layout.root).length <= 1) {
      store.requestCloseTab(workspaceId, group.id, tabId)
      return true
    }
    // 多格：关的是活动那一格。同样只投意图、不裸调 closeRegion——那一格若有未保存的编辑器改动，裸调会
    // 静默弃掉，而鼠标点这一格的 X 会先弹「未保存确认」。同一个「关这一格」的概念必须只有一个决定出口，
    // 于是键盘也走意图，由承载该格的组件跑与 X 相同的 dirty→确认→closeRegion。
    store.requestCloseRegion(workspaceId, tabId, activeRegionId)
    return true
  }
  if (command.kind === 'split') {
    store.splitRegion(workspaceId, tabId, activeRegionId, command.direction)
    return true
  }
  const neighbourRegionId = adjacentRegionId(tab.layout, command.direction)
  if (!neighbourRegionId) return false
  store.focusRegion(workspaceId, tabId, neighbourRegionId)
  return true
}

/**
 * 窗口作用域每个绑定 id 对应的处理器。App 把这份 map 原样喂给 `routeWindowShortcut`，自己不列举任何
 * id、不做任何分支——「路由一半」= 这份 map 缺 id，由测试挡住（它必须覆盖注册表里每一条 window scope
 * 绑定）。
 *
 * 每个处理器返回是否真的吃下了这个键：workbench 动作可能拒绝（序号越界、方向上没有相邻格），拒绝时返回
 * false，调用方就不 preventDefault、放行给别处。quick-switch 是纯切换，恒返回 true。
 */
export function windowShortcutHandlers(
  store: WorkbenchShortcutStore,
  actions: { toggleQuickSwitch: () => void; toggleShortcutsHelp: () => void }
): Record<string, () => boolean> {
  const handlers: Record<string, () => boolean> = {
    'quick-switch.toggle': () => {
      actions.toggleQuickSwitch()
      return true
    },
    'help.shortcuts': () => {
      actions.toggleShortcutsHelp()
      return true
    }
  }
  // 把每条能翻译成 workbench 命令的 window 绑定接成一个 handler：翻译成命令 → 解析落点 → 转发。id 集合
  // 从注册表推导（不手抄），新增一条 workbench.* 绑定就自动接上，不会出现「注册了却没人处理」的漏。
  for (const id of workbenchWindowBindingIds()) {
    handlers[id] = () => {
      const command = commandForWorkbenchId(id)
      return command ? dispatchWorkbenchCommand(command, store) : false
    }
  }
  return handlers
}

/**
 * 注册表里所有能翻译成 workbench 命令的 window 绑定 id——SSOT 是 `SHORTCUT_BINDINGS`，这里只做
 * 「scope==='window' 且 commandForWorkbenchId 认得」的过滤，不另存一份清单。
 */
export function workbenchWindowBindingIds(): string[] {
  return SHORTCUT_BINDINGS
    .filter((binding) => binding.scope === 'window' && commandForWorkbenchId(binding.id) !== null)
    .map((binding) => binding.id)
}

