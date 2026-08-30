import type { SessionSnapshot } from '../../../shared/contracts'
import type { WorkspaceLayout } from '@agentmux/layout'
import {
  tabGroupForTab,
  workbenchSurfaces,
  type WorkbenchTab
} from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'

/**
 * The durable owner of a Session surface.  This is deliberately resolved from the layout tree at
 * the moment a placement is committed; a focused Region is only a UI hint and is never an owner.
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
 * Resolve an explicit Session to its current durable Workbench owner.
 *
 * A supplied origin is a claim about the requested Session surface, not a hint from which another
 * surface may be guessed.  If it is stale, this returns an actionable failure instead of silently
 * falling back to the active workspace or another view of the same Session.  Without an origin,
 * exactly one visible Session surface is required; ambiguity is also a failure because ambient focus
 * cannot choose between owners.
 */
export function resolveSessionPlacement(input: SessionPlacementInput): SessionPlacementResult {
  const { sessionId, sessions, tabs, layouts, origin } = input
  if (!sessions.some((session) => session.id === sessionId)) {
    return unresolved(sessionId, 'session-not-found', 'The target Session is no longer available.')
  }

  const owners: Array<{ tab: WorkbenchTab; regionId: string }> = []
  for (const tab of Object.values(tabs)) {
    for (const surface of workbenchSurfaces(tab)) {
      if (isSessionSurface(surface) && surface.sessionId === sessionId) {
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

  const selected = origin
    ? owners.find(({ tab, regionId }) => (
        (origin.workspaceId === undefined || tab.workspaceId === origin.workspaceId) &&
        (origin.tabId === undefined || tab.id === origin.tabId) &&
        (origin.regionId === undefined || regionId === origin.regionId) &&
        (origin.tabGroupId === undefined || tabGroupForTab(layouts[tab.workspaceId], tab.id) === origin.tabGroupId)
      ))
    : owners.length === 1
      ? owners[0]
      : undefined

  if (!selected) {
    return unresolved(
      sessionId,
      origin ? 'origin-mismatch' : 'surface-ambiguous',
      origin
        ? 'The target Session surface moved or was closed before placement; choose the Session again.'
        : 'The target Session has more than one surface and no explicit owner was supplied.'
    )
  }

  const { tab, regionId } = selected
  const layout = layouts[tab.workspaceId]
  if (!layout) {
    return unresolved(
      sessionId,
      'workspace-layout-missing',
      'The target Session workspace layout is unavailable; its Workbench was kept intact.'
    )
  }
  const tabGroupId = tabGroupForTab(layout, tab.id)
  if (!tabGroupId) {
    return unresolved(
      sessionId,
      'tab-group-missing',
      'The target Session Tab is no longer attached to a Tab Group; choose the Session again.'
    )
  }

  return {
    kind: 'resolved',
    sessionId,
    workspaceId: tab.workspaceId,
    tabId: tab.id,
    regionId,
    tabGroupId
  }
}

function unresolved(
  sessionId: string,
  reason: SessionPlacementFailure['reason'],
  message: string
): SessionPlacementFailure {
  return { kind: 'unresolved', sessionId, reason, message }
}
