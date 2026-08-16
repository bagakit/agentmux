import type {
  AppConfig,
  BrowserSnapshot,
  SessionSnapshot
} from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import {
  findGroup,
  findGroupForTab,
  removeTab,
  leafIdsMatchRecords,
  balanceWorkbenchRegionLayout,
  closeWorkbenchRegion,
  createWorkbenchViewLayout,
  focusWorkbenchRegion,
  regionIds,
  splitWorkbenchRegion,
  swapWorkbenchRegions,
  type WorkspaceLayout,
  type WorkbenchViewLayout,
  type SplitDirection
} from '@agentmux/layout'
import {
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath
} from '../../../shared/scratch-topics'
import {
  resolveAgentName,
  resolveTabName,
  type TabAgentMember
} from './display-name'

export type AgentWorkbenchSurface = {
  regionId: string
  kind: 'agent'
  phase: 'launching' | 'attached'
  workspaceId: string
  sessionId: string
}

export type TerminalWorkbenchSurface = {
  regionId: string
  kind: 'terminal'
  phase: 'launching' | 'attached'
  workspaceId: string
  sessionId: string
}

export type FileWorkbenchSurface = {
  regionId: string
  kind: 'file'
  workspaceId: string
  path: string
}

export type LauncherWorkbenchSurface = {
  regionId: string
  kind: 'launcher'
  workspaceId: string
}

export type BrowserWorkbenchSurface = BrowserSnapshot & {
  regionId: string
  kind: 'browser'
  workspaceId: string
  browserId: string
  /**
   * 这个 Browser 是从一份书签文件打开的（`openFile` 的书签分支），记住它是哪份、以及那份文件本身是不是
   * 二进制。只为「查看源码」服务：有它才显示那个按钮（普通网页没有源可看），`binary` 决定按钮灰不灰
   * （二进制 plist 过 `files.read` 的 utf8 会坏，那一档不给看，§2.7）。缺省即「不是从书签开的」。
   *
   * **瞬时事实，不进持久化**：browser 面冷启动整面剥离（见 workbench-persistence 的说明），这一位随之而去。
   * 页内导航（`reduceBrowserEvent` 的 `updated`）经 `...surface` 保留它——`event.browser` 是纯快照没这字段。
   */
  bookmarkOrigin?: { path: string; binary: boolean }
}

export type WorkbenchSurface =
  | AgentWorkbenchSurface
  | TerminalWorkbenchSurface
  | FileWorkbenchSurface
  | LauncherWorkbenchSurface
  | BrowserWorkbenchSurface

export type WorkbenchTab = {
  id: string
  workspaceId: string
  topicId?: string
  titleRegionId: string
  layout: WorkbenchViewLayout
  regions: Record<string, WorkbenchSurface>
  /**
   * 用户手改的 Tab 显示名——最高优先级的那一档（见 `display-name.ts` 的优先级链）。
   *
   * 它是显示名，绝不进入 id/寻址 key：它是这个对象上的一个值，对象仍按 `id` 寻址，`titleRegionId`、
   * `regions` 的 key、View 地址（`formatViewAddress(id)`）都与它无关，因此改名不动三级地址。
   * 缺席即让默认策略接管（一个 Agent 对齐其名、多 Agent 用家族名）；一旦被设过，两条自动策略对
   * 这张 Tab 永久停手。**只有这一个 Tab 模型**——名字是它的一个字段，不另建第二个 tab 对象承载它。
   */
  name?: string
}

export function initialWorkbenchRegionId(tabId: string): string {
  return `region:${tabId}`
}

export function createWorkbenchTab(
  id: string,
  surface: WorkbenchSurface,
  name?: string
): WorkbenchTab {
  return {
    id,
    workspaceId: surface.workspaceId,
    titleRegionId: surface.regionId,
    layout: createWorkbenchViewLayout(surface.regionId),
    regions: { [surface.regionId]: surface },
    ...(name && name.trim().length > 0 ? { name: name.trim() } : {})
  }
}

/**
 * 给 Tab 设一个用户手改名，或（传空）清除它交还给默认策略。
 *
 * 只动 `name` 这一个字段。id、titleRegionId、layout、regions 的 key 全部原样保留——这正是"改名绝不
 * 破坏引用"这条前置约束在代码里的落点：session/region/tab 三级地址都不读 `name`，故改名后寻址与复制
 * 路径完全不变。空白名视为清除（回到默认策略），不留一个空串把这张 Tab 钉死成手改态。
 */
export function renameWorkbenchTab(tab: WorkbenchTab, name: string | null): WorkbenchTab {
  const trimmed = name?.trim() ?? ''
  if (trimmed.length > 0) return { ...tab, name: trimmed }
  if (tab.name === undefined) return tab
  const { name: _cleared, ...rest } = tab
  return rest
}

export function activeWorkbenchSurface(tab: WorkbenchTab): WorkbenchSurface {
  return tab.regions[tab.layout.activeRegionId] ?? tab.regions[tab.titleRegionId]!
}

export function titleWorkbenchSurface(tab: WorkbenchTab): WorkbenchSurface {
  return tab.regions[tab.titleRegionId] ?? activeWorkbenchSurface(tab)
}

export function workbenchSurfaces(tab: WorkbenchTab): WorkbenchSurface[] {
  return Object.values(tab.regions)
}

export function sessionIdsWithoutViewsAfterClosingTabs(
  tabs: Readonly<Record<string, WorkbenchTab>>,
  closingTabIds: readonly string[],
  kind: 'agent' | 'terminal'
): string[] {
  const closingIds = new Set(closingTabIds)
  return sessionIdsWithoutViewsAfterClosing(tabs, kind, (tab) => closingIds.has(tab.id))
}

function sessionIdsWithoutViewsAfterClosing(
  tabs: Readonly<Record<string, WorkbenchTab>>,
  kind: 'agent' | 'terminal',
  isClosing: (tab: WorkbenchTab, surface: AgentWorkbenchSurface | TerminalWorkbenchSurface) => boolean
): string[] {
  const closingSessionIds = new Set<string>()
  const remainingSessionIds = new Set<string>()
  for (const tab of Object.values(tabs)) {
    for (const surface of workbenchSurfaces(tab)) {
      if (surface.kind !== kind || surface.phase !== 'attached') continue
      if (isClosing(tab, surface)) closingSessionIds.add(surface.sessionId)
      else remainingSessionIds.add(surface.sessionId)
    }
  }
  return [...closingSessionIds].filter((sessionId) => !remainingSessionIds.has(sessionId))
}

export function findWorkbenchRegion(
  tabs: Readonly<Record<string, WorkbenchTab>>,
  regionId: string
): { tab: WorkbenchTab; surface: WorkbenchSurface } | null {
  for (const tab of Object.values(tabs)) {
    const surface = tab.regions[regionId]
    if (surface) return { tab, surface }
  }
  return null
}

export function updateWorkbenchRegion(
  tab: WorkbenchTab,
  regionId: string,
  update: (surface: WorkbenchSurface) => WorkbenchSurface
): WorkbenchTab {
  const surface = tab.regions[regionId]
  return surface
    ? { ...tab, regions: { ...tab.regions, [regionId]: update(surface) } }
    : tab
}

export function replaceWorkbenchRegion(
  tab: WorkbenchTab,
  regionId: string,
  surface: WorkbenchSurface
): WorkbenchTab {
  if (!tab.regions[regionId] || surface.regionId !== regionId) return tab
  return {
    ...tab,
    workspaceId: surface.workspaceId,
    layout: focusWorkbenchRegion(tab.layout, regionId),
    regions: { ...tab.regions, [regionId]: surface }
  }
}

/**
 * 一张 Tab 的核心不变量（#494 gap）：Region 有两种表示，必须逐一相等——
 *   - 分屏树的叶子 id 集合：`regionIds(tab.layout.root)`；
 *   - surface 表的 key 集合：`Object.keys(tab.regions)`。
 *
 * 违约的两个方向都是「画不出、也回收不掉的孤儿」：树里多一格（regions 表没有对应记录）会在
 * `WorkspaceWorkbench` 里画成 null（`if (!surface) return null`）——一个看不见、也关不掉的孤儿格；
 * regions 表里多一格（树里没有对应叶子）则是一条永远画不到、也永远回收不掉的死记录。此前这条只由各个
 * reducer「两侧一起改」的手工约定维持（add/remove/arrange/swap/promote 六处成对改），零守卫；
 * `control.ts` 里那道 hand-placed 撞名闸就是这条缺守卫的直接证据——它单独护着预设那一条路。
 *
 * 把不变量提升成生产断言，套在每个改动 tab 的 reducer 尾部：将来第 7 条只改了一侧的路径，会在**改动
 * 发生的那一处**响亮失败，而不是在渲染层留下一个静默孤儿。这也是本模块里判定这条性质的**唯一**实现
 * （SSOT）——不变量测试不再自带第二份「两侧相等」的拷贝，改为调用它。
 *
 * 无条件 throw，不做 dev-only 门。三条理由：
 *   1. 用户代价可控。断言跑在 reducer 算出「下一个 tab」之后、return 之前；抛出即这个 tab 不被返回，
 *      store 的 `set(reducerResult)` 拿不到它（reducer 抛了就没有返回值可提交），于是这一次操作
 *      （分屏 / 关闭 / 预设 / 换位 / 促升）整个作废、落回上一个一致状态。用户丢的是这一次本就会产出
 *      坏 tab 的操作，而不是整个会话。
 *   2. 反面更糟且不可恢复。静默放行一个看不见的孤儿格，用户既看不见也关不掉，只能重启——而这恰恰
 *      只发生在生产（真实用户）里。dev-only 门会把守卫从最需要它的那个环境里剥掉。
 *   3. 与同层一致。本层其它 reducer（空树、arrange 撞名、control open 失败）都是无条件抛。
 *
 * 代价是 O(region 数) 的一次集合比较，跑在本就不频繁的布局改动上，不构成剥成 dev-only 的性能理由。
 *
 * 只读一张 Tab、只在违约时抛，所以可被同时改两张 Tab 的 reducer 复用——对每张受影响的 Tab 各调一次
 * 即可（promoteRegionToTab 已这么用；排队中的「跨两张 Tab 移动 Region」要原子地碰两棵树、两张表，
 * 也走这条路）。
 *
 * 判据本身在 `split-tree.ts` 的 {@link leafIdsMatchRecords}，与工作区那条断言（`assertGroupInvariant`）
 * 共用一份：两边此前各自手抄一份比较，而且**曾经判得不一样**——那一份用 `Set` 差集，对重复完全失明
 * （#571）。判据只有一处，两条断言就不可能再分家；本函数留下的只有「取哪两个清单」与错误消息。
 */
export function assertRegionInvariant(tab: WorkbenchTab): void {
  const tree = regionIds(tab.layout.root)
  const map = Object.keys(tab.regions)
  if (!leafIdsMatchRecords(tree, map)) {
    throw new Error(
      `Workbench Tab "${tab.id}" region invariant violated: the layout tree holds region ids ` +
        `[${[...tree].sort().join(', ')}] but tab.regions holds ` +
        `[${[...map].sort().join(', ')}]. Every tree leaf must have ` +
        `exactly one regions entry and vice versa — a mismatch is an invisible, un-closeable orphan Region.`
    )
  }
}

export function addWorkbenchRegion(
  tab: WorkbenchTab,
  targetRegionId: string,
  direction: SplitDirection,
  surface: WorkbenchSurface
): WorkbenchTab {
  if (surface.workspaceId !== tab.workspaceId || tab.regions[surface.regionId]) return tab
  const split = splitWorkbenchRegion(tab.layout, targetRegionId, direction, surface.regionId)
  if (split === tab.layout) return tab
  // #470「在某个方向打开任意多个并自动布局」：三个追加入口（GUI 分屏、控制协议 open.split、
  // 点链接 openHttpLink）都汇到这里，且都把同一个 origin 格当锚点连开。splitWorkbenchRegion 每次
  // 只用局部 0.5，于是在同一锚点上开第 N 个会把它切成 0.5^N ——第 6 个时首格只剩 ~1.5% 的窄缝。
  // 追加即按后代叶子数重算全部 ratio（balanceWorkbenchRegionLayout），N 格就各占 1/N。这一步只动
  // ratio、不重排 id、不改骨架，故活动格与新格身份原样保留；纯 splitWorkbenchRegion 保留局部 0.5
  // （嵌套分屏的几何测试靠它），均分只发生在这条「内容追加」漏斗上。
  //
  // 有意的取舍：balanceWorkbenchRegionLayout 重算的是**整棵树**，包括这次追加没碰到的兄弟子树。
  // 所以用户此前拖过的分隔比例（setWorkbenchRegionSplitRatio 写进同一批 ratio）会在下次「任意处」
  // 追加时一并被重置回等分。这是为了兑现 #470 承诺的全局 1/N——把均分限制在被追加的那个 split 子树、
  // 保留别处的手调比例，就给不出全局等分。今天定的是「追加即全局均分」，手调让位于此；若日后要保留
  // 手调，改的是这里的均分范围，而不是 balanceWorkbenchRegionLayout 本身。
  const layout = balanceWorkbenchRegionLayout(split)
  const next: WorkbenchTab = {
    ...tab,
    layout,
    regions: { ...tab.regions, [surface.regionId]: surface }
  }
  assertRegionInvariant(next)
  return next
}

export function removeWorkbenchRegion(tab: WorkbenchTab, regionId: string): WorkbenchTab | null {
  if (!tab.regions[regionId]) return tab
  if (regionIds(tab.layout.root).length <= 1) return null
  const layout = closeWorkbenchRegion(tab.layout, regionId)
  const regions = { ...tab.regions }
  delete regions[regionId]
  const next: WorkbenchTab = {
    ...tab,
    layout,
    titleRegionId: tab.titleRegionId === regionId ? layout.activeRegionId : tab.titleRegionId,
    regions
  }
  assertRegionInvariant(next)
  return next
}

export function focusWorkbenchTabRegion(tab: WorkbenchTab, regionId: string): WorkbenchTab {
  const layout = focusWorkbenchRegion(tab.layout, regionId)
  return layout === tab.layout ? tab : { ...tab, layout }
}

/**
 * 把这张 Tab 里两格的位置互换（#471）。只动 `layout`（换的是 id 在骨架上的位置），`regions` 表
 * 一字不动——两格的内容都还在，只是在树里换了位置。挂不上时（同一格、任一端点不在场）
 * `swapWorkbenchRegions` 原样返回旧 layout，这里据此交回原 tab，保持 `===` 稳定。
 */
export function swapWorkbenchTabRegions(
  tab: WorkbenchTab,
  regionIdA: string,
  regionIdB: string
): WorkbenchTab {
  const layout = swapWorkbenchRegions(tab.layout, regionIdA, regionIdB)
  if (layout === tab.layout) return tab
  const next: WorkbenchTab = { ...tab, layout }
  // 换位是集合下的置换（regions 表一字不动），本该恒满足不变量；这里仍套一次，是为了让每条改动 tab
  // 的 reducer 都过同一道闸——将来若换位实现被改成会动 id 集合的写法，这道断言就是它的守卫。
  assertRegionInvariant(next)
  return next
}

export function sessionTabId(sessionId: string): string {
  return `session:${sessionId}`
}

export function fileTabId(workspaceId: string, path: string): string {
  return `file:${workspaceId}:${path}`
}

export function documentKey(workspaceId: string, path: string): string {
  return `${workspaceId}\0${path}`
}

export function workspaceForSession(config: AppConfig | null, session: SessionSnapshot) {
  return config?.workspaces.find((workspace) => workspaceOwnsSessionPath(workspace, session))
}

/**
 * 这个 Session 的磁盘路径**落在**哪个仓里——用来把绝对路径缩成相对路径，仅此一用。
 *
 * 与 {@link workspaceForSession} 是两个不同的问题，所以是两个函数而不是一个放宽了的谓词：
 * 前者问「归属」（谁拥有这一格：决定 Tab 挂在哪、计数算给谁、Topic 是哪个），必须精确，
 * 一个子目录终端不该被算进某个 Project 的 Agent 数里；后者问「包含」（这条绝对路径的前缀
 * 是什么），子目录当然算——`/repo/sub` 里的文件就是 `/repo` 仓里的文件。
 *
 * 不合并的判据是**放宽归属会改动八个调用方**（侧栏计数、Topic 绑定、工具坞、持久化…），
 * 它们都要的是精确归属。为了缩短一条路径去动那些，是拿正确性换排版。
 *
 * 取最长前缀而不是第一个命中：仓库可以嵌套（`/proj` 与 `/proj/repo` 都注册时，
 * `/proj/repo/src/x.ts` 该按 `repo` 缩短，不是按 `proj`——否则剥出来的相对路径
 * 读起来像是另一个仓里的文件，那正是 pane-workspace-root 那条判据钉住的坏输出）。
 *
 * 认不出仍然返回 undefined：宁可不缩短，也不拿一个凑合的根去剥。
 */
export function workspaceRootForPath(config: AppConfig | null, session: SessionSnapshot): string | undefined {
  const owner = workspaceForSession(config, session)
  if (owner) return owner.path
  let best: string | undefined
  for (const workspace of config?.workspaces ?? []) {
    if (workspace.hostId !== session.hostId) continue
    const root = workspace.path.replace(/[/\\]+$/u, '')
    if (!root || !session.workspacePath.startsWith(`${root}/`)) continue
    if (!best || root.length > best.length) best = root
  }
  return best
}

export function topicIdForSession(config: AppConfig | null, session: SessionSnapshot): string | null {
  const workspace = workspaceForSession(config, session)
  return workspace ? scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath) : null
}

/**
 * Resolve the Topic binding for a brand-new Tab/View from the active work line.
 *
 * `WorkbenchTab.topicId` is the only Renderer-side binding truth. A new surface must copy the
 * active Tab's binding at its creation boundary; deriving a Topic from the new tab id or keeping a
 * second `activeTopic` field would make one Topic-per-tab and drift when navigation enters through
 * another path. The workspace and group checks keep ordinary Git Workspaces and stale anchors
 * explicitly unbound.
 */
export function inheritedTopicIdForNewTab(
  workspaceId: string,
  layout: WorkspaceLayout | undefined,
  tabs: Readonly<Record<string, WorkbenchTab>>,
  targetGroupId?: string
): string | undefined {
  if (!isScratchWorkspaceId(workspaceId) || !layout) return undefined
  const group = findGroup(layout, targetGroupId ?? layout.activeGroupId)
  const activeTabId = group?.activeTabId
  if (!activeTabId) return undefined
  const activeTab = tabs[activeTabId]
  if (!activeTab || activeTab.workspaceId !== workspaceId) return undefined
  return activeTab.topicId
}

export function tabStillOpen(layouts: Record<string, WorkspaceLayout>, tabId: string): boolean {
  return Object.values(layouts).some((layout) =>
    layout.groups.some((group) => group.tabOrder.includes(tabId))
  )
}

export function tabGroupForTab(layout: WorkspaceLayout | undefined, tabId: string): string | null {
  return layout ? (findGroupForTab(layout, tabId)?.id ?? null) : null
}

/**
 * 从 timeline 里取首条用户消息作为"首条 prompt"派生源。取不到返回 null——没有对话不是错误。
 * timeline 是 Store 已持有的投影，这里不新建第二份对话记录。
 */
export function firstPromptFromTimeline(timeline: AgentTimelineSnapshot | undefined): string | null {
  const first = timeline?.items.find((item) => item.kind === 'user_message')
  return first?.content ?? first?.title ?? null
}

/** 求一个 Agent 的显示名所需的全部投影事实。都是既有 Store 里已有的东西，本模块不新增来源。 */
export type AgentNameFacts = {
  /** 用户手改名（store.agentNames[sessionId]）。 */
  userName?: string | null | undefined
  /** 启动时指定名（当前由启动路径写入 agentNames，故与 userName 同源；保留独立入参供派生链表达该档）。 */
  launchName?: string | null | undefined
  /** 首条 prompt，用于派生。 */
  firstPrompt?: string | null | undefined
  /** Provider·Workspace 派生的兜底串，即 session.label（Main 唯一构建处）。 */
  fallbackLabel: string
  /** Provider 展示标签（如 "Codex"），用于多 Agent 时的家族名。 */
  providerLabel: string
}

/**
 * 一个 Agent 的最终显示名。所有展示 Agent 名的地方都调它，经《显示名与身份》那条唯一优先级链求值，
 * 不各自拼一份。返回纯字符串即可满足展示；需要断言是哪一档胜出的调用方直接用 `resolveAgentName`。
 */
export function agentDisplayName(facts: AgentNameFacts): string {
  return resolveAgentName({
    userName: facts.userName,
    launchName: facts.launchName,
    firstPrompt: facts.firstPrompt,
    fallback: facts.fallbackLabel
  }).name
}

/**
 * 一张 Tab 的最终显示名——Tab 名策略的唯一落点。
 *
 * 它把 Tab 上每个 Agent Region 经同一条链求出各自的名字，再按成员数量套用默认策略：
 *   - 用户手改过（`tab.name` 存在）→ 用它，两条自动策略永久停手；
 *   - 恰好一个 Agent → 对齐该 Agent 名；两个及以上 → 家族名（不冒充任一成员、不随 title region 跳变）；
 *   - 没有 Agent 成员 → `fallback`（文件名 / "New Tab" / 浏览器标题等既有表面派生，由调用方给出）。
 *
 * 关键：家族名与"对齐单 Agent"都**不读** `tab.titleRegionId`——它遍历 `tab.regions` 里全部 agent
 * 表面，故换 title region 不改变 Tab 名（这正是合同要求的"不随 title region 变化而跳变"）。
 */
export function tabDisplayName(input: {
  tab: WorkbenchTab
  fallback: string
  /** 把一个 agent 表面的 sessionId 解析成它的显示名事实。取不到（如 session 尚未 attach）返回 null 跳过。 */
  agentFactsFor(sessionId: string): AgentNameFacts | null
}): string {
  const agents: TabAgentMember[] = []
  for (const surface of workbenchSurfaces(input.tab)) {
    if (surface.kind !== 'agent') continue
    const facts = input.agentFactsFor(surface.sessionId)
    if (!facts) continue
    agents.push({ name: agentDisplayName(facts), providerLabel: facts.providerLabel })
  }
  return resolveTabName({
    userName: input.tab.name,
    agents,
    fallback: input.fallback
  }).name
}

export function remapLayoutTabIds(
  layout: WorkspaceLayout,
  replacements: ReadonlyMap<string, string>
): WorkspaceLayout {
  const replace = (id: string): string => replacements.get(id) ?? id
  return {
    ...layout,
    groups: layout.groups.map((group) => ({
      ...group,
      tabOrder: group.tabOrder.map(replace),
      activeTabId: group.activeTabId ? replace(group.activeTabId) : null,
      recentTabIds: group.recentTabIds.map(replace)
    }))
  }
}

export function removeTabsFromLayouts(
  layouts: Record<string, WorkspaceLayout>,
  tabIds: readonly string[]
): Record<string, WorkspaceLayout> {
  let next = layouts
  for (const tabId of tabIds) {
    next = Object.fromEntries(Object.entries(next).map(([workspaceId, layout]) => {
      const tabGroupId = tabGroupForTab(layout, tabId)
      return [workspaceId, tabGroupId ? removeTab(layout, tabGroupId, tabId) : layout]
    }))
  }
  return next
}
