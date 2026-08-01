// Workbench 窗口级快捷键的判定层——纯函数，不碰窗口，照 `quick-switch-shortcut.ts` /
// `editor-save-shortcut.ts` 的同一套路：本仓库组件测试用 `renderToStaticMarkup`，effect 不跑、也
// 发不出 DOM 事件，写进 App 的 `useEffect` 里的分支没有断言够得着。所以「这个键是哪个动作、往哪个
// 方向、切第几张」这些承重判定全留在这里，App 的监听器只做无分支的转发与 preventDefault。
//
// 覆盖 T-007 明确的高价值子集：**关闭当前 Region、按序号切 Tab、分屏、切换焦点格**。不建 action
// catalog、不做用户改键——那是本 task 明确排除的范围。
//
// 平台切分沿用既有两族（`quick-switch-shortcut.ts` / `terminal-shortcuts.ts`）的同一底线：
// **非 mac 绝不吃裸 Ctrl+字母**——那些是 shell/readline 的地盘（Ctrl+W 删词、Ctrl+D 是 EOF）。于是
// 非 mac 上字母类动作一律带 Shift；数字（选 Tab）用裸 Ctrl 安全（Ctrl+数字不是 readline 键，也是
// 浏览器/终端选标签页的既有惯例）；方向移动用 Ctrl+Alt+方向键，与既有终端作用域键（Cmd+F/C/K、
// Shift+Enter，见 terminal-shortcuts.ts）无一相交。mac 侧走裸 Cmd 的 mac 终端/编辑器惯例。

import { regionIds, workbenchRegionBounds, type WorkbenchViewLayout } from './workbench-view-layout'
import type { SplitDirection, WorkspaceLayout } from './workbench-layout'
import type { WorkbenchTab } from './workbench-tabs'
import { activeTopicIdFromLayout, layoutForActiveTopic } from './scratch-topic-layout'

export type WorkbenchShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
>

/**
 * 一次按键解析出的命令——已经定到「哪个动作、往哪个方向、第几张」，但**落点（哪个 Workspace/Tab/
 * Region）留给 App**：落点要读按下那一刻的实时 store 投影，纯判定层不该也够不着那份状态。
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

function isPrimaryChord(event: WorkbenchShortcutEvent, isMac: boolean): boolean {
  // mac：裸 Cmd（不含 Ctrl）；非 mac：Ctrl（不含 Cmd）。两边都排除对面的主修饰键，免得一个
  // Cmd+Ctrl 的混合和弦同时落进两条分支。是否带 Shift/Alt 由各动作自己再判。
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

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

function arrowDirection(key: string): SplitDirection | null {
  switch (key) {
    case 'arrowleft': return 'left'
    case 'arrowright': return 'right'
    case 'arrowup': return 'up'
    case 'arrowdown': return 'down'
    default: return null
  }
}

/**
 * 把一次按键解析成命令；不是本层的键就返回 `null`（由 App 原样放行）。
 *
 * 只认落在纯判定内的事实（键、修饰键、平台），落点解析不在这里。
 */
export function resolveWorkbenchShortcut(
  event: WorkbenchShortcutEvent,
  isMac: boolean
): WorkbenchShortcutCommand | null {
  if (!isPrimaryChord(event, isMac)) return null
  const key = event.key.toLowerCase()

  // 切换焦点格：mac Cmd+Alt+方向 / 非 mac Ctrl+Alt+方向。方向键不与任何字母/数字键冲突，
  // 也是「按方向移动焦点」最无歧义的表达。它是唯一用到 Alt 的分支，所以先判、判完即走。
  if (event.altKey && !event.shiftKey) {
    const direction = arrowDirection(key)
    return direction ? { kind: 'focus-region', direction } : null
  }
  if (event.altKey) return null

  // 选 Tab：mac Cmd+1..9 / 非 mac Ctrl+1..9，都不带 Shift。1..8 是绝对序号；9 恒指最后一张
  // （浏览器/终端惯例：第 9 个键跳末尾，而不是要求正好九张）。
  if (!event.shiftKey && key.length === 1 && key >= '1' && key <= '9') {
    return { kind: 'select-tab', ordinal: key === '9' ? 'last' : Number(key) }
  }

  // 关闭当前 Region：mac Cmd+W / 非 mac Ctrl+Shift+W。裸 Ctrl+W 是 readline 的删词，绝不吃。
  // 注意：让 Cmd+W 真正落到这里、而不是被系统菜单抢去关窗口，靠的是主进程换掉了默认应用菜单
  // （application-menu.ts 去掉了绑 Cmd+W 的 close/fileMenu/windowMenu role）——渲染层的
  // preventDefault 拦不住原生菜单加速键，那个保证不在这一层。
  if (key === 'w' && letterChordMatches(event, isMac)) {
    return { kind: 'close-region' }
  }

  // 分屏：mac 用 Shift 区分方向（Cmd+D 向右、Cmd+Shift+D 向下，mac 终端惯例）。非 mac 的基础
  // 和弦已含 Shift（裸 Ctrl+字母要留给 shell），无法再用 Shift 区分方向，于是按常见 Linux 终端
  // 惯例改用不同字母：Ctrl+Shift+E 向右、Ctrl+Shift+O 向下。
  if (isMac) {
    if (key === 'd') return { kind: 'split', direction: event.shiftKey ? 'down' : 'right' }
    return null
  }
  if (event.shiftKey) {
    if (key === 'e') return { kind: 'split', direction: 'right' }
    if (key === 'o') return { kind: 'split', direction: 'down' }
  }
  return null
}

// 字母类动作（close-region）的修饰键判定：mac 裸 Cmd 无 Shift；非 mac Ctrl+Shift。
function letterChordMatches(event: WorkbenchShortcutEvent, isMac: boolean): boolean {
  return isMac ? !event.shiftKey : event.shiftKey
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
 * 一次按键的完整处理：判定 → 落点解析 → 转发 store action，返回是否吃下了这个键。
 *
 * 把整条链收进这一个纯函数，是为了让「该不该 preventDefault」以及「落点怎么从 store 投影出来」这两处
 * 决定都能被断言——它们若留在 App 的 `useEffect` 里，本仓库 `renderToStaticMarkup` 不跑 effect，断言
 * 够不着（f-2248f4yx5 的 Cmd+S 教训：删掉注册那行，判定测试全绿，只有接线测试会红）。App 的监听器
 * 因此塌成一行「吃下了就 preventDefault」。落点沿用组件层同一条派生：投影出当前 Topic 的 layout →
 * 活动组 → 活动 Tab → 活动 Region，序号和方向就与用户眼前所见对齐。
 *
 * 返回 `true` 表示已执行动作、调用方应 preventDefault；`false` 表示这不是本层的键或落点解析失败，
 * 原样放行。
 */
export function handleWorkbenchShortcut(
  event: WorkbenchShortcutEvent,
  isMac: boolean,
  store: WorkbenchShortcutStore
): boolean {
  const command = resolveWorkbenchShortcut(event, isMac)
  if (!command) return false
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
