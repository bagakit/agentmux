import type { SessionSnapshot } from '../../../shared/contracts'
import { groupIds, regionIds, type WorkspaceLayout } from '@agentmux/layout'
import {
  workbenchSurfaces,
  type WorkbenchTab
} from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'

/**
 * An exact durable display occurrence of a Session surface, resolved at placement time.
 * workspaceId is the display Workspace; the Tab's resource Workspace is independent.
 */
export type SessionPlacement = {
  kind: 'resolved'
  sessionId: string
  workspaceId: string
  tabId: string
  regionId: string
  tabGroupId: string
}

export type SessionPlacementFailure = {
  kind: 'unresolved'
  sessionId: string
  reason:
    | 'session-not-found'
    | 'surface-not-found'
    | 'surface-ambiguous'
    | 'origin-mismatch'
    | 'workspace-layout-missing'
    | 'tab-group-missing'
  message: string
}

export type SessionPlacementResult = SessionPlacement | SessionPlacementFailure

export type SessionPlacementOrigin = {
  workspaceId?: string
  tabId?: string
  regionId?: string
  tabGroupId?: string
}

export type SessionPlacementInput = {
  sessionId: string
  sessions: readonly SessionSnapshot[]
  tabs: Readonly<Record<string, WorkbenchTab>>
  layouts: Readonly<Record<string, WorkspaceLayout>>
  origin?: SessionPlacementOrigin
}

/**
 * Resolve an explicit Session to one exact durable Workbench display occurrence.
 *
 * A supplied origin is a claim about the requested Session surface, not a hint from which another
 * surface may be guessed.  If it is stale, this returns an actionable failure instead of silently
 * falling back to the active workspace or another view of the same Session.  Without an origin,
 * exactly one reachable occurrence is required; ambient focus cannot choose between locations.
 */
export function resolveSessionPlacement(input: SessionPlacementInput): SessionPlacementResult {
  const { sessionId, sessions, tabs, layouts, origin } = input
  if (!sessions.some((session) => session.id === sessionId)) {
    return unresolved(sessionId, 'session-not-found', 'The target Session is no longer available.')
  }

  const owners: Array<{ tab: WorkbenchTab; regionId: string }> = []
  for (const tab of Object.values(tabs)) {
    const reachableRegions = new Set(regionIds(tab.layout.root))
    for (const surface of workbenchSurfaces(tab)) {
      if (isSessionSurface(surface) && surface.sessionId === sessionId && reachableRegions.has(surface.regionId)) {
        owners.push({ tab, regionId: surface.regionId })
      }
    }
  }

  if (owners.length === 0) {
    return unresolved(
      sessionId,
      'surface-not-found',
      'The target Session has no visible Workbench surface to own this placement.'
    )
  }

  const occurrences: SessionPlacement[] = []
  for (const [workspaceId, layout] of Object.entries(layouts)) {
    if (origin?.workspaceId !== undefined && origin.workspaceId !== workspaceId) continue
    const reachableGroups = new Set(groupIds(layout.root))
    for (const group of layout.groups) {
      if (!reachableGroups.has(group.id) || origin?.tabGroupId !== undefined && origin.tabGroupId !== group.id) continue
      for (const { tab, regionId } of owners) {
        if (!group.tabOrder.includes(tab.id) ||
          origin?.tabId !== undefined && origin.tabId !== tab.id ||
          origin?.regionId !== undefined && origin.regionId !== regionId) continue
        occurrences.push({ kind: 'resolved', sessionId, workspaceId, tabId: tab.id, regionId, tabGroupId: group.id })
      }
    }
  }

  if (occurrences.length !== 1) {
    return unresolved(
      sessionId,
      origin && occurrences.length === 0 ? 'origin-mismatch' : 'surface-ambiguous',
      origin && occurrences.length === 0
        ? 'The target Session surface moved or was closed before placement; choose the Session again.'
        : 'The target Session has more than one surface and no explicit owner was supplied.'
    )
  }

  return occurrences[0]!
}

function unresolved(
  sessionId: string,
  reason: SessionPlacementFailure['reason'],
  message: string
): SessionPlacementFailure {
  return { kind: 'unresolved', sessionId, reason, message }
}
