import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import {
  activateTab,
  addTab,
  createWorkspaceLayout,
  findGroupForTab,
  removeTab,
  type WorkspaceLayout
} from './workbench-layout'
import {
  removeWorkbenchRegion,
  workbenchSurfaces,
  type AgentWorkbenchSurface,
  type TerminalWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'

export type PersistedWorkbench = {
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
}

export function persistedAgentSessionIds(
  persisted: PersistedWorkbench | null
): Set<string> {
  return new Set(persisted ? Object.values(persisted.tabs).flatMap((tab) => (
    workbenchSurfaces(tab).flatMap((surface) => (
      surface.kind === 'agent' && surface.phase === 'attached' ? [surface.sessionId] : []
    ))
  )) : [])
}

type SessionWorkbenchSurface = AgentWorkbenchSurface | TerminalWorkbenchSurface

function sessionSurface(surface: WorkbenchSurface): surface is SessionWorkbenchSurface {
  return (
    (surface.kind === 'agent' || surface.kind === 'terminal') &&
    surface.phase === 'attached'
  )
}

function sessionOnlyTab(tab: WorkbenchTab): WorkbenchTab | null {
  let next: WorkbenchTab | null = tab
  for (const surface of workbenchSurfaces(tab)) {
    if (sessionSurface(surface)) continue
    if (tab.topicId && surface.kind === 'launcher') continue
    next = next ? removeWorkbenchRegion(next, surface.regionId) : null
  }
  return next
}

function keepTabsInLayout(
  layout: WorkspaceLayout,
  tabIds: ReadonlySet<string>
): WorkspaceLayout {
  let next = layout
  for (const group of layout.groups) {
    for (const tabId of group.tabOrder) {
      if (!tabIds.has(tabId)) next = removeTab(next, group.id, tabId)
    }
  }
  return next
}

function addTabWithoutStealingFocus(
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string
): WorkspaceLayout {
  const activeTabId = layout.groups.find((group) => group.id === groupId)?.activeTabId
  const next = addTab(layout, groupId, tabId)
  return activeTabId ? activateTab(next, groupId, activeTabId) : next
}

export function projectPersistedWorkbench(input: PersistedWorkbench): PersistedWorkbench {
  const tabs = Object.fromEntries(
    Object.values(input.tabs).flatMap((tab) => {
      const projected = sessionOnlyTab(tab)
      return projected ? [[projected.id, projected]] : []
    })
  )
  const tabIds = new Set(Object.keys(tabs))
  const layouts = Object.fromEntries(
    Object.entries(input.layouts).map(([workspaceId, layout]) => [
      workspaceId,
      keepTabsInLayout(layout, tabIds)
    ])
  )
  return { tabs, layouts }
}

function sessionBelongsToWorkspace(
  config: AppConfig,
  session: SessionSnapshot,
  workspaceId: string
): boolean {
  const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId)
  return Boolean(
    workspace && workspaceOwnsSessionPath(workspace, session)
  )
}

function restoreTab(
  config: AppConfig,
  sessions: ReadonlyMap<string, SessionSnapshot>,
  tab: WorkbenchTab,
  preserveUnknownSessionViews = false
): WorkbenchTab | null {
  let next: WorkbenchTab | null = tab
  for (const surface of workbenchSurfaces(tab)) {
    if (!sessionSurface(surface)) {
      if (tab.topicId && surface.kind === 'launcher') continue
      return null
    }
    const session = sessions.get(surface.sessionId)
    // A Runtime snapshot can be temporarily unavailable while the persisted presentation is still
    // perfectly usable. Keep the exact Region identity in that narrow fail-open state; Core remains
    // the owner of whether the Session/Run exists and SessionPane will show its neutral connecting
    // state until a later canonical snapshot arrives. Never apply this to a successful snapshot: a
    // known missing or mismatched Session must still be removed by the normal verified restore path.
    if (
      preserveUnknownSessionViews &&
      !session &&
      config.workspaces.some((workspace) => workspace.id === tab.workspaceId) &&
      surface.workspaceId === tab.workspaceId
    ) continue
    if (
      session?.kind === surface.kind &&
      sessionBelongsToWorkspace(config, session, tab.workspaceId)
    ) continue
    next = next ? removeWorkbenchRegion(next, surface.regionId) : null
  }
  return next
}

export function restorePersistedWorkbench(input: {
  config: AppConfig
  sessions: readonly SessionSnapshot[]
  persisted: PersistedWorkbench | null
  createTabGroupId(): string
  /**
   * Keep session Regions whose identities could not be checked because the Runtime snapshot failed.
   * This is a one-shot presentation projection, not a second Session truth source; callers should
   * set it only for an explicitly rejected snapshot and let the next canonical snapshot reconcile it.
   */
  preserveUnknownSessionViews?: boolean
}): PersistedWorkbench {
  if (!input.persisted) {
    return {
      tabs: {},
      layouts: Object.fromEntries(input.config.workspaces.map((workspace) => [
        workspace.id,
        createWorkspaceLayout(input.createTabGroupId())
      ]))
    }
  }

  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const tabs = Object.fromEntries(
    Object.values(input.persisted.tabs).flatMap((tab) => {
      const restored = restoreTab(
        input.config,
        sessions,
        tab,
        input.preserveUnknownSessionViews === true
      )
      return restored ? [[restored.id, restored]] : []
    })
  )
  const layouts: Record<string, WorkspaceLayout> = {}
  for (const workspace of input.config.workspaces) {
    const workspaceTabIds = new Set(
      Object.values(tabs)
        .filter((tab) => tab.workspaceId === workspace.id)
        .map((tab) => tab.id)
    )
    let layout = input.persisted.layouts[workspace.id]
      ? keepTabsInLayout(input.persisted.layouts[workspace.id]!, workspaceTabIds)
      : createWorkspaceLayout(input.createTabGroupId())
    for (const tabId of workspaceTabIds) {
      if (!findGroupForTab(layout, tabId)) {
        layout = addTabWithoutStealingFocus(layout, layout.activeGroupId, tabId)
      }
    }
    layouts[workspace.id] = layout
  }
  return { tabs, layouts }
}
