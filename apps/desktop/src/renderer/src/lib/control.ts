import {
  type AgentMuxArrangeMode,
  type AgentMuxControlCaller,
  type AgentMuxInspectedRegion,
  type AgentMuxInspectedTab,
  type AgentMuxMessageTargetCandidate,
  type AgentMuxOpenDestination,
  type AgentMuxRegion,
  type AgentMuxRegionAnchor,
  type AgentMuxTabAnchor
} from '@agentmux/core/control'
import type { SessionSnapshot } from '../../../shared/contracts'
import {
  activateTab,
  findGroupForTab,
  insertTabAfter,
  removeTab,
  type WorkspaceLayout
} from './workbench-layout'
import {
  applyWorkbenchRegionLayoutPreset,
  balanceWorkbenchRegionLayout,
  placeActiveWorkbenchRegionFirst,
  workbenchRegionBounds,
  workbenchRegionPresetSize
} from './workbench-view-layout'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  findWorkbenchRegion,
  removeWorkbenchRegion,
  replaceWorkbenchRegion,
  tabGroupForTab,
  type LauncherWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'

export type WorkbenchControlState = {
  sessions: readonly SessionSnapshot[]
  tabs: Readonly<Record<string, WorkbenchTab>>
  layouts: Readonly<Record<string, WorkspaceLayout>>
}

export type ControlOpenPlan = {
  workspaceId: string
  tabId: string
  regionId: string
  kind: 'launcher' | 'split' | 'tab'
  launcher: LauncherWorkbenchSurface
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
}

function error(code: string, message: string, extra?: object): Error & { code: string } {
  return Object.assign(new Error(message), { code }, extra)
}

function projectSurface(
  tab: WorkbenchTab,
  surface: WorkbenchSurface,
  sessions: ReadonlyMap<string, SessionSnapshot>
): AgentMuxRegion {
  const base = { tabId: tab.id, regionId: surface.regionId, workspaceId: tab.workspaceId }
  if (surface.kind === 'agent' && surface.phase === 'attached') {
    const session = sessions.get(surface.sessionId)
    if (session?.kind === 'agent') {
      return {
        ...base,
        kind: 'agent',
        agentSessionId: session.id,
        providerId: session.providerId,
        executorId: session.executorId
      }
    }
  }
  if (surface.kind === 'terminal' && surface.phase === 'attached') {
    const session = sessions.get(surface.sessionId)
    if (session?.kind === 'terminal') return { ...base, kind: 'terminal', runId: session.control.run.runId }
  }
  if (surface.kind === 'browser') return { ...base, kind: 'browser', browserId: surface.browserId }
  if (surface.kind === 'file') return { ...base, kind: 'file', path: surface.path }
  if (surface.kind === 'launcher') return { ...base, kind: 'launcher' }
  throw error('CONTROL_OWNER_LOST', 'Region content is changing and has no stable Control projection.')
}

function projectTabRegions(
  tab: WorkbenchTab,
  sessions: ReadonlyMap<string, SessionSnapshot>
): AgentMuxRegion[] {
  return workbenchRegionBounds(tab.layout.root).map(({ regionId }) => {
    const surface = tab.regions[regionId]
    if (!surface) throw error('CONTROL_OWNER_LOST', 'Tab layout contains an unknown Region.')
    return projectSurface(tab, surface, sessions)
  })
}

export function listWorkbenchControlRegions(input: WorkbenchControlState): AgentMuxRegion[] {
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const regions: AgentMuxRegion[] = []
  for (const tab of Object.values(input.tabs)) {
    const layout = input.layouts[tab.workspaceId]
    if (!layout || !findGroupForTab(layout, tab.id)) continue
    regions.push(...projectTabRegions(tab, sessions))
  }
  return regions
}

function selfRegions(input: WorkbenchControlState, caller: AgentMuxControlCaller | undefined): AgentMuxRegion[] {
  if (!caller) throw error('INVALID_CONTROL_REQUEST', 'A self selector requires a managed caller.')
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  return Object.values(input.tabs).flatMap((tab) => {
    const layout = input.layouts[tab.workspaceId]
    if (!layout || !findGroupForTab(layout, tab.id)) return []
    return workbenchRegionBounds(tab.layout.root).flatMap(({ regionId }) => {
      const surface = tab.regions[regionId]
      if (surface?.kind !== 'agent' || surface.phase !== 'attached' || surface.sessionId !== caller.agentSessionId) return []
      const region = projectSurface(tab, surface, sessions)
      return region.kind === 'agent' ? [region] : []
    })
  })
}

export function resolveWorkbenchControlRegion(
  input: WorkbenchControlState,
  target: AgentMuxRegionAnchor,
  caller?: AgentMuxControlCaller
): AgentMuxRegion {
  if (target.kind === 'self') {
    const matches = selfRegions(input, caller)
    if (matches.length === 0) throw error('CALLER_NOT_OPEN', 'Managed caller is not displayed in a Region.')
    if (matches.length !== 1) throw error('AMBIGUOUS_REGION_TARGET', 'Managed caller is displayed in multiple Regions.')
    return matches[0]!
  }
  const matches = Object.values(input.tabs).flatMap((tab) => {
    const layout = input.layouts[tab.workspaceId]
    if (!layout || !findGroupForTab(layout, tab.id)) return []
    const surface = tab.regions[target.regionId]
    return surface ? [{ tab, surface }] : []
  })
  if (matches.length === 0) throw error('REGION_NOT_OPEN', 'Region target is not currently open.')
  if (matches.length !== 1) throw error('AMBIGUOUS_REGION_TARGET', 'Region target is ambiguous.')
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  return projectSurface(matches[0]!.tab, matches[0]!.surface, sessions)
}

export function resolveWorkbenchControlTab(
  input: WorkbenchControlState,
  target: AgentMuxTabAnchor,
  caller?: AgentMuxControlCaller
): WorkbenchTab {
  if (target.kind === 'tab') {
    const tab = input.tabs[target.tabId]
    if (!tab || !input.layouts[tab.workspaceId] || !findGroupForTab(input.layouts[tab.workspaceId]!, tab.id)) {
      throw error('TAB_NOT_OPEN', 'Tab target is not currently open.')
    }
    return tab
  }
  const ids = [...new Set(selfRegions(input, caller).map(({ tabId }) => tabId))]
  if (ids.length === 0) throw error('CALLER_NOT_OPEN', 'Managed caller is not displayed in a Tab.')
  if (ids.length !== 1) throw error('AMBIGUOUS_TAB_TARGET', 'Managed caller is displayed in multiple Tabs.')
  return input.tabs[ids[0]!]!
}

export function inspectWorkbenchControlTab(input: WorkbenchControlState, tab: WorkbenchTab): AgentMuxInspectedTab {
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const regions = new Map(projectTabRegions(tab, sessions).map((region) => [region.regionId, region]))
  return {
    tabId: tab.id,
    workspaceId: tab.workspaceId,
    regions: workbenchRegionBounds(tab.layout.root).map(({ regionId, bounds }) => {
      const region = regions.get(regionId)
      if (!region) throw error('CONTROL_OWNER_LOST', 'Tab Region has no stable Control projection.')
      return { ...region, bounds }
    })
  }
}

export function inspectWorkbenchControlRegion(
  input: WorkbenchControlState,
  region: AgentMuxRegion
): AgentMuxInspectedRegion {
  const tab = input.tabs[region.tabId]
  const bounds = tab && workbenchRegionBounds(tab.layout.root).find((item) => item.regionId === region.regionId)?.bounds
  if (!bounds) throw error('REGION_NOT_OPEN', 'Region target is not currently open.')
  return { ...region, bounds }
}

export function messageTargetCandidates(
  input: WorkbenchControlState,
  tabId: string
): AgentMuxMessageTargetCandidate[] {
  const candidates = new Map<string, string[]>()
  const tab = input.tabs[tabId]
  if (!tab) throw error('TAB_NOT_OPEN', 'Tab target is not currently open.')
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  for (const region of projectTabRegions(tab, sessions)) {
    if (region.kind !== 'agent') continue
    candidates.set(region.agentSessionId, [...(candidates.get(region.agentSessionId) ?? []), region.regionId])
  }
  return [...candidates].map(([agentSessionId, regionIds]) => ({ agentSessionId, regionIds }))
}

export function planControlOpen(
  input: WorkbenchControlState,
  destination: AgentMuxOpenDestination,
  caller: AgentMuxControlCaller | undefined,
  tabId: string,
  regionId: string
): ControlOpenPlan {
  const tabs = { ...input.tabs }
  const layouts = { ...input.layouts }
  if (destination.kind === 'launcher') {
    const owner = findWorkbenchRegion(tabs, destination.regionId)
    if (!owner || owner.surface.kind !== 'launcher') throw error('LAUNCHER_REGION_REQUIRED', 'Target Region is not an open Launcher.')
    return {
      workspaceId: owner.tab.workspaceId,
      tabId: owner.tab.id,
      regionId: owner.surface.regionId,
      kind: 'launcher',
      launcher: owner.surface,
      tabs,
      layouts
    }
  }
  if (destination.kind === 'split') {
    const anchor = resolveWorkbenchControlRegion(input, destination.region, caller)
    const tab = tabs[anchor.tabId]
    const layout = tab && layouts[tab.workspaceId]
    if (!tab || !layout) throw error('REGION_NOT_OPEN', 'Split anchor Region is not currently open.')
    const launcher: LauncherWorkbenchSurface = { regionId, kind: 'launcher', workspaceId: tab.workspaceId }
    const nextTab = addWorkbenchRegion(tab, anchor.regionId, destination.direction, launcher)
    if (nextTab === tab) throw error('CONTROL_FAILED', 'Split destination could not be created.')
    tabs[tab.id] = nextTab
    layouts[tab.workspaceId] = activateTab(layout, findGroupForTab(layout, tab.id)!.id, tab.id)
    return { workspaceId: tab.workspaceId, tabId: tab.id, regionId, kind: 'split', launcher, tabs, layouts }
  }
  const anchor = resolveWorkbenchControlTab(input, destination.after, caller)
  const layout = layouts[anchor.workspaceId]
  if (!layout) throw error('TAB_NOT_OPEN', 'Anchor Tab is not currently open.')
  const launcher: LauncherWorkbenchSurface = { regionId, kind: 'launcher', workspaceId: anchor.workspaceId }
  const tab = createWorkbenchTab(tabId, launcher)
  const nextLayout = insertTabAfter(layout, anchor.id, tab.id)
  if (nextLayout === layout) throw error('CONTROL_FAILED', 'Tab destination could not be created.')
  tabs[tab.id] = tab
  layouts[anchor.workspaceId] = nextLayout
  return { workspaceId: anchor.workspaceId, tabId: tab.id, regionId, kind: 'tab', launcher, tabs, layouts }
}

export function arrangeWorkbenchControlTab(
  tab: WorkbenchTab,
  mode: AgentMuxArrangeMode,
  addedRegionIds: readonly string[]
): WorkbenchTab {
  if (mode.kind === 'balance') return { ...tab, layout: balanceWorkbenchRegionLayout(tab.layout) }
  if (mode.kind === 'active-first') return { ...tab, layout: placeActiveWorkbenchRegionFirst(tab.layout) }
  const required = workbenchRegionPresetSize(mode.preset)
  const current = workbenchRegionBounds(tab.layout.root).length
  if (current > required) throw error('LAYOUT_CAPACITY_EXCEEDED', 'Tab contains more Regions than the requested preset.')
  if (addedRegionIds.length !== required - current) throw error('INVALID_CONTROL_REQUEST', 'Preset Launcher count is invalid.')
  const regions = { ...tab.regions }
  for (const regionId of addedRegionIds) {
    regions[regionId] = { regionId, kind: 'launcher', workspaceId: tab.workspaceId }
  }
  return {
    ...tab,
    regions,
    layout: applyWorkbenchRegionLayoutPreset(tab.layout, mode.preset, addedRegionIds)
  }
}

export function rollbackControlOpen(
  input: Pick<WorkbenchControlState, 'tabs' | 'layouts'>,
  plan: ControlOpenPlan,
  expectedSurface: WorkbenchSurface
): { tabs: Record<string, WorkbenchTab>; layouts: Record<string, WorkspaceLayout> } | null {
  const owner = findWorkbenchRegion(input.tabs, plan.regionId)
  if (!owner || owner.tab.id !== plan.tabId || owner.surface !== expectedSurface) return null
  const tabs = { ...input.tabs }
  const layouts = { ...input.layouts }
  if (plan.kind === 'launcher') {
    tabs[plan.tabId] = replaceWorkbenchRegion(owner.tab, plan.regionId, plan.launcher)
    return { tabs, layouts }
  }
  if (plan.kind === 'split') {
    const tab = removeWorkbenchRegion(owner.tab, plan.regionId)
    if (!tab) return null
    tabs[plan.tabId] = tab
    return { tabs, layouts }
  }
  const layout = layouts[plan.workspaceId]
  const tabGroupId = tabGroupForTab(layout, plan.tabId)
  if (!layout || !tabGroupId) return null
  delete tabs[plan.tabId]
  layouts[plan.workspaceId] = removeTab(layout, tabGroupId, plan.tabId)
  return { tabs, layouts }
}
