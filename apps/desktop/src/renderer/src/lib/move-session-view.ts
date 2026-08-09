import { addTab, activateTab, createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  findWorkbenchRegion,
  removeTabsFromLayouts,
  removeWorkbenchRegion,
  tabGroupForTab,
  workbenchSurfaces,
  type AgentWorkbenchSurface,
  type TerminalWorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'

// Moving a Session to another worktree moves only its DISPLAY IDENTITY — the Region that projects it
// into a View. The Agent's cwd is `session.workspacePath` (Core, the working directory of an already
// running process); it is not part of a layout and is deliberately absent from every input and output
// here. This reducer never reads, copies, or emits a workspacePath. It relocates one projection and
// nothing else.

type SessionSurface = AgentWorkbenchSurface | TerminalWorkbenchSurface

export type MoveSessionViewInput = {
  tabs: Readonly<Record<string, WorkbenchTab>>
  layouts: Readonly<Record<string, WorkspaceLayout>>
  // The projection to move, keyed by its globally-unique Region id. A Session may project into many
  // Views; keying by Region moves exactly the one the user pointed at and leaves the rest untouched.
  regionId: string
  // Cross-checked against the projection's own Session so a stale caller cannot move the wrong one.
  sessionId: string
  targetWorkspaceId: string
  // The workspaces that actually exist (from config). Guards against landing a projection in — or
  // minting a layout for — a workspace that is not real.
  workspaceIds: readonly string[]
  // Fresh ids the reducer may consume when the target has no View carrying this Session yet. Injected
  // so the function stays pure; unused when an existing target View is reused.
  mint: { tabId: string; tabGroupId: string; regionId: string }
}

export type MoveSessionViewResult =
  | { kind: 'unchanged' }
  | {
      kind: 'moved'
      sessionId: string
      tabs: Record<string, WorkbenchTab>
      layouts: Record<string, WorkspaceLayout>
      // Where the projection now lives, so the caller can navigate with the existing focus actions.
      target: { workspaceId: string; tabId: string; regionId: string }
      // True when the target had no View carrying this Session and one had to be created; false when
      // an existing target View was reused. This is how "no View can host it" is expressed rather than
      // silently dropped.
      createdView: boolean
    }

function sessionSurfaceOf(surface: WorkbenchTab['regions'][string]): SessionSurface | null {
  return isSessionSurface(surface) ? surface : null
}

function findSessionViewInWorkspace(
  tabs: Readonly<Record<string, WorkbenchTab>>,
  workspaceId: string,
  sessionId: string
): { tabId: string; regionId: string } | null {
  for (const tab of Object.values(tabs)) {
    if (tab.workspaceId !== workspaceId) continue
    for (const surface of workbenchSurfaces(tab)) {
      const session = sessionSurfaceOf(surface)
      if (session && session.sessionId === sessionId) return { tabId: tab.id, regionId: session.regionId }
    }
  }
  return null
}

export function moveSessionViewToWorkspace(input: MoveSessionViewInput): MoveSessionViewResult {
  const owner = findWorkbenchRegion(input.tabs, input.regionId)
  if (!owner) return { kind: 'unchanged' }
  const sourceSurface = sessionSurfaceOf(owner.surface)
  if (!sourceSurface || sourceSurface.sessionId !== input.sessionId) return { kind: 'unchanged' }
  if (!input.workspaceIds.includes(input.targetWorkspaceId)) return { kind: 'unchanged' }
  // The View's workspace is the source of truth for "where this projection currently is".
  if (owner.tab.workspaceId === input.targetWorkspaceId) return { kind: 'unchanged' }

  // Detach the source projection first. If it was the View's last Region, the empty View is disposed
  // exactly the way closing its last Region does — no bespoke View lifecycle for moves.
  const detachedTab = removeWorkbenchRegion(owner.tab, input.regionId)
  const tabs: Record<string, WorkbenchTab> = { ...input.tabs }
  const removedTabIds: string[] = []
  if (!detachedTab) {
    delete tabs[owner.tab.id]
    removedTabIds.push(owner.tab.id)
  } else {
    tabs[owner.tab.id] = detachedTab
  }

  const existing = findSessionViewInWorkspace(tabs, input.targetWorkspaceId, input.sessionId)
  let layouts: Record<string, WorkspaceLayout> = removedTabIds.length > 0
    ? removeTabsFromLayouts({ ...input.layouts }, removedTabIds)
    : { ...input.layouts }

  if (existing) {
    // The target already projects this Session — reuse that View instead of minting a duplicate.
    const layout = layouts[input.targetWorkspaceId]
    const groupId = layout ? tabGroupForTab(layout, existing.tabId) : null
    if (layout && groupId) {
      layouts = { ...layouts, [input.targetWorkspaceId]: activateTab(layout, groupId, existing.tabId) }
    }
    return {
      kind: 'moved',
      sessionId: input.sessionId,
      tabs,
      layouts,
      target: { workspaceId: input.targetWorkspaceId, tabId: existing.tabId, regionId: existing.regionId },
      createdView: false
    }
  }

  // No target View can host it yet — create one. The projection keeps its Session identity and takes on
  // the target workspace as its DISPLAY identity only; the Session's own workspacePath is never touched.
  const landing: SessionSurface = {
    ...sourceSurface,
    regionId: input.mint.regionId,
    workspaceId: input.targetWorkspaceId
  }
  tabs[input.mint.tabId] = createWorkbenchTab(input.mint.tabId, landing)
  const targetLayout = layouts[input.targetWorkspaceId]
  layouts = {
    ...layouts,
    [input.targetWorkspaceId]: targetLayout
      ? addTab(targetLayout, targetLayout.activeGroupId, input.mint.tabId)
      : createWorkspaceLayout(input.mint.tabGroupId, [input.mint.tabId])
  }
  return {
    kind: 'moved',
    sessionId: input.sessionId,
    tabs,
    layouts,
    target: { workspaceId: input.targetWorkspaceId, tabId: input.mint.tabId, regionId: input.mint.regionId },
    createdView: true
  }
}
