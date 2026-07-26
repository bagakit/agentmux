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
  type WorkspaceLayout
} from './workbench-layout'
import {
  closeWorkbenchRegion,
  createWorkbenchViewLayout,
  focusWorkbenchRegion,
  regionIds,
  splitWorkbenchRegion,
  type WorkbenchViewLayout
} from './workbench-view-layout'
import type { SplitDirection } from './workbench-layout'
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

export function addWorkbenchRegion(
  tab: WorkbenchTab,
  targetRegionId: string,
  direction: SplitDirection,
  surface: WorkbenchSurface
): WorkbenchTab {
  if (surface.workspaceId !== tab.workspaceId || tab.regions[surface.regionId]) return tab
  const layout = splitWorkbenchRegion(tab.layout, targetRegionId, direction, surface.regionId)
  if (layout === tab.layout) return tab
  return {
    ...tab,
    layout,
    regions: { ...tab.regions, [surface.regionId]: surface }
  }
}

export function removeWorkbenchRegion(tab: WorkbenchTab, regionId: string): WorkbenchTab | null {
  if (!tab.regions[regionId]) return tab
  if (regionIds(tab.layout.root).length <= 1) return null
  const layout = closeWorkbenchRegion(tab.layout, regionId)
  const regions = { ...tab.regions }
  delete regions[regionId]
  return {
    ...tab,
    layout,
    titleRegionId: tab.titleRegionId === regionId ? layout.activeRegionId : tab.titleRegionId,
    regions
  }
}

export function focusWorkbenchTabRegion(tab: WorkbenchTab, regionId: string): WorkbenchTab {
  const layout = focusWorkbenchRegion(tab.layout, regionId)
  return layout === tab.layout ? tab : { ...tab, layout }
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
