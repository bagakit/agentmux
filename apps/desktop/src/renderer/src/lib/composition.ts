import {
  resolveAgentMuxRegion,
  type AgentMuxCompositionViewRegion,
  type AgentMuxRegion,
  type AgentMuxRegionPlacement,
  type AgentMuxRegionTarget,
  type AgentMuxRelativeRegion
} from '@agentmux/core/composition'
import type { SessionSnapshot } from '../../../shared/contracts'
import {
  activateTab,
  addTab,
  findGroupForTab,
  type SplitDirection,
  type WorkspaceLayout
} from './workbench-layout'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  workbenchSurfaces,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { workbenchRegionBounds } from './workbench-view-layout'

type WorkbenchCompositionState = {
  sessions: readonly SessionSnapshot[]
  tabs: Readonly<Record<string, WorkbenchTab>>
  layouts: Readonly<Record<string, WorkspaceLayout>>
}

export function listWorkbenchRegions(input: WorkbenchCompositionState): AgentMuxRegion[] {
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const regions: AgentMuxRegion[] = []
  for (const tab of Object.values(input.tabs)) {
    const layout = input.layouts[tab.workspaceId]
    const tabGroup = layout ? findGroupForTab(layout, tab.id) : null
    if (!tabGroup) continue
    for (const surface of workbenchSurfaces(tab)) {
      if ((surface.kind !== 'agent' && surface.kind !== 'terminal') || surface.phase !== 'attached') continue
      const session = sessions.get(surface.sessionId)
      if (!session || session.kind !== surface.kind) continue
      if (surface.kind === 'agent' && session.kind === 'agent') {
        regions.push({
          viewId: tab.id,
          regionId: surface.regionId,
          kind: 'agent',
          agentSessionId: surface.sessionId,
          workspaceId: tab.workspaceId,
          tabGroupId: tabGroup.id
        })
      } else if (surface.kind === 'terminal' && session.kind === 'terminal') {
        regions.push({
          viewId: tab.id,
          regionId: surface.regionId,
          kind: 'terminal',
          runId: session.control.runId,
          workspaceId: tab.workspaceId,
          tabGroupId: tabGroup.id
        })
      }
    }
  }
  return regions
}

export function listWorkbenchViewRegions(
  input: WorkbenchCompositionState,
  viewId: string
): AgentMuxCompositionViewRegion[] {
  const tab = input.tabs[viewId]
  if (!tab) throw new Error('Composition View is no longer open.')
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  return workbenchRegionBounds(tab.layout.root).map(({ regionId, bounds }) => {
    const surface = tab.regions[regionId]
    if (!surface) throw new Error('Composition View layout contains an unknown Region.')
    if (surface.kind === 'agent' && surface.phase === 'attached') {
      const session = sessions.get(surface.sessionId)
      if (session?.kind === 'agent') {
        return {
          regionId,
          bounds,
          kind: 'agent',
          providerId: session.providerId,
          executorId: session.executorId,
          agentSessionId: session.id
        }
      }
    }
    if (surface.kind === 'terminal' && surface.phase === 'attached') {
      const session = sessions.get(surface.sessionId)
      if (session?.kind === 'terminal') {
        return {
          regionId,
          bounds,
          kind: 'terminal',
          runId: session.control.run.runId
        }
      }
    }
    return { regionId, bounds, kind: 'other' }
  })
}

export function resolveWorkbenchRegion(input: WorkbenchCompositionState & {
  target: AgentMuxRegionTarget
}): AgentMuxRegion {
  return resolveAgentMuxRegion(listWorkbenchRegions(input), input.target)
}

export function resolveRelativeWorkbenchRegion(
  input: WorkbenchCompositionState & {
    callerAgentSessionId: string
    relativeTo: AgentMuxRelativeRegion
  }
): AgentMuxRegion {
  const regions = listWorkbenchRegions(input)
  return resolveAgentMuxRegion(regions, input.relativeTo.kind === 'self'
    ? { kind: 'agent-session', agentSessionId: input.callerAgentSessionId }
    : { kind: 'region', regionId: input.relativeTo.regionId })
}

function splitDirection(placement: Exclude<AgentMuxRegionPlacement, 'tab'>): SplitDirection {
  switch (placement) {
    case 'split-left': return 'left'
    case 'split-right': return 'right'
    case 'split-up': return 'up'
    case 'split-down': return 'down'
  }
}

export function placeWorkbenchRegion(input: {
  layout: WorkspaceLayout
  tabs: Readonly<Record<string, WorkbenchTab>>
  relativeRegion: AgentMuxRegion
  newViewId: string
  surface: WorkbenchSurface
  placement: AgentMuxRegionPlacement
}): {
  layout: WorkspaceLayout
  tabs: Record<string, WorkbenchTab>
  viewId: string
  regionId: string
  tabGroupId: string
} {
  if (input.placement === 'tab') {
    const tab = createWorkbenchTab(input.newViewId, input.surface)
    const layout = addTab(input.layout, input.relativeRegion.tabGroupId, tab.id)
    const tabGroup = findGroupForTab(layout, tab.id)
    if (!tabGroup) throw new Error('Composition Region could not be added as a Tab.')
    return {
      layout,
      tabs: { ...input.tabs, [tab.id]: tab },
      viewId: tab.id,
      regionId: input.surface.regionId,
      tabGroupId: tabGroup.id
    }
  }
  const tab = input.tabs[input.relativeRegion.viewId]
  if (!tab || !tab.regions[input.relativeRegion.regionId]) {
    throw new Error('Composition relative Region is no longer open.')
  }
  const nextTab = addWorkbenchRegion(
    tab,
    input.relativeRegion.regionId,
    splitDirection(input.placement),
    input.surface
  )
  if (nextTab === tab) throw new Error('Composition Region could not be split inside its View.')
  return {
    layout: activateTab(input.layout, input.relativeRegion.tabGroupId, tab.id),
    tabs: { ...input.tabs, [tab.id]: nextTab },
    viewId: tab.id,
    regionId: input.surface.regionId,
    tabGroupId: input.relativeRegion.tabGroupId
  }
}
