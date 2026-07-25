import type {
  AppConfig,
  BrowserSnapshot,
  SessionSnapshot
} from '../../../shared/contracts'
import {
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
}

export function initialWorkbenchRegionId(tabId: string): string {
  return `region:${tabId}`
}

export function createWorkbenchTab(
  id: string,
  surface: WorkbenchSurface
): WorkbenchTab {
  return {
    id,
    workspaceId: surface.workspaceId,
    titleRegionId: surface.regionId,
    layout: createWorkbenchViewLayout(surface.regionId),
    regions: { [surface.regionId]: surface }
  }
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

export function tabStillOpen(layouts: Record<string, WorkspaceLayout>, tabId: string): boolean {
  return Object.values(layouts).some((layout) =>
    layout.groups.some((group) => group.tabOrder.includes(tabId))
  )
}

export function tabGroupForTab(layout: WorkspaceLayout | undefined, tabId: string): string | null {
  return layout ? (findGroupForTab(layout, tabId)?.id ?? null) : null
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
