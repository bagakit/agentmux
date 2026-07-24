import type {
  AppConfig,
  BrowserSnapshot,
  SessionSnapshot
} from '../../../shared/contracts'
import {
  createWorkspaceLayout,
  findGroupForTab,
  removeTab,
  type WorkspaceLayout
} from './workbench-layout'
import type { LauncherView } from './surface-tool-dock'

export type AgentWorkbenchTab = {
  id: string
  kind: 'agent'
  phase: 'launching' | 'attached'
  workspaceId: string
  sessionId: string
}

export type TerminalWorkbenchTab = {
  id: string
  kind: 'terminal'
  phase: 'launching' | 'attached'
  workspaceId: string
  sessionId: string
}

export type FileWorkbenchTab = {
  id: string
  kind: 'file'
  workspaceId: string
  path: string
}

export type LauncherWorkbenchTab = {
  id: string
  kind: 'launcher'
  workspaceId: string
  view: LauncherView
}

export type BrowserWorkbenchTab = BrowserSnapshot & {
  kind: 'browser'
  workspaceId: string
  browserId: string
}

export type WorkbenchTab =
  | AgentWorkbenchTab
  | TerminalWorkbenchTab
  | FileWorkbenchTab
  | LauncherWorkbenchTab
  | BrowserWorkbenchTab

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
  return config?.workspaces.find(
    (workspace) =>
      workspace.hostId === session.hostId && workspace.path === session.workspacePath
  )
}

export function createInitialWorkbench(
  config: AppConfig,
  sessions: SessionSnapshot[],
  createPaneId: () => string
): { tabs: Record<string, WorkbenchTab>; layouts: Record<string, WorkspaceLayout> } {
  const tabs: Record<string, WorkbenchTab> = {}
  const layouts: Record<string, WorkspaceLayout> = {}
  for (const workspace of config.workspaces) {
    const workspaceTabIds = sessions.flatMap((session) => {
      if (session.hostId !== workspace.hostId || session.workspacePath !== workspace.path) return []
      const tab: AgentWorkbenchTab | TerminalWorkbenchTab = {
        id: sessionTabId(session.id),
        kind: session.kind,
        phase: 'attached',
        workspaceId: workspace.id,
        sessionId: session.id
      }
      tabs[tab.id] = tab
      return [tab.id]
    })
    layouts[workspace.id] = createWorkspaceLayout(createPaneId(), workspaceTabIds)
  }
  return { tabs, layouts }
}

export function tabStillOpen(layouts: Record<string, WorkspaceLayout>, tabId: string): boolean {
  return Object.values(layouts).some((layout) =>
    layout.groups.some((group) => group.tabOrder.includes(tabId))
  )
}

export function paneForTab(layout: WorkspaceLayout | undefined, tabId: string): string | null {
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
      const paneId = paneForTab(layout, tabId)
      return [workspaceId, paneId ? removeTab(layout, paneId, tabId) : layout]
    }))
  }
  return next
}
