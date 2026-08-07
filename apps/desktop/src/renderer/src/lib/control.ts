import {
  type AgentMuxArrangeMode,
  type AgentMuxControlCaller,
  type AgentMuxInspectedRegion,
  type AgentMuxInspectedTab,
  type AgentMuxMessageTargetCandidate,
  type AgentMuxOpenDestination,
  type AgentMuxRegion,
  type AgentMuxRegionAnchor,
  type AgentMuxRegionNeighbors,
  type AgentMuxTabAnchor
} from '@agentmux/core/control'
import type { SessionSnapshot } from '../../../shared/contracts'
import { directionalNeighbor, type DirectionalNeighborInput } from './directional-addressing'
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
  assertRegionInvariant,
  createWorkbenchTab,
  findWorkbenchRegion,
  removeWorkbenchRegion,
  replaceWorkbenchRegion,
  tabGroupForTab,
  type LauncherWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { assertUnreachableSurface } from './workbench-surface-kinds'

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
  // Attached sessions with a live snapshot returned above. Everything that reaches here is classified
  // once, exhaustively: the pure presentation kinds each get a projection, while a launching-phase or
  // session-lost agent/terminal has no stable Control projection and keeps its existing loud failure.
  // The `assertNever` default is why this is safe against a new kind: an `if`-chain ending in a bare
  // `throw` would silently route a 6th kind into CONTROL_OWNER_LOST at runtime; here it fails to
  // compile until the new kind is explicitly placed. Not a `Record`: the arms build different shapes
  // and two of them (agent/terminal) must throw, not return a value.
  switch (surface.kind) {
    case 'browser':
      return { ...base, kind: 'browser', browserId: surface.browserId }
    case 'file':
      return { ...base, kind: 'file', path: surface.path }
    case 'launcher':
      return { ...base, kind: 'launcher' }
    case 'agent':
    case 'terminal':
      throw error('CONTROL_OWNER_LOST', 'Region content is changing and has no stable Control projection.')
    default:
      return assertUnreachableSurface(surface)
  }
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

/**
 * 一个 Region 四个方向的邻居。
 *
 * 序列真相全部取自既有结构：几何来自 `workbenchRegionBounds`，Tab 顺序来自
 * `findGroupForTab(...).tabOrder`。不为方向另建第二份布局真相——那会在分屏拖动后立刻对不上。
 */
function regionNeighbors(
  input: WorkbenchControlState,
  tab: WorkbenchTab,
  regionId: string
): AgentMuxRegionNeighbors {
  const layout = input.layouts[tab.workspaceId]
  const resolverInput: DirectionalNeighborInput = {
    regionId,
    regions: workbenchRegionBounds(tab.layout.root),
    tabId: tab.id,
    tabOrder: (layout && findGroupForTab(layout, tab.id)?.tabOrder) ?? []
  }
  return {
    left: directionalNeighbor(resolverInput, 'left'),
    right: directionalNeighbor(resolverInput, 'right'),
    up: directionalNeighbor(resolverInput, 'up'),
    down: directionalNeighbor(resolverInput, 'down')
  }
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
      return { ...region, bounds, neighbors: regionNeighbors(input, tab, regionId) }
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
  return { ...region, bounds, neighbors: regionNeighbors(input, tab, region.regionId) }
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
    const target = resolveWorkbenchControlRegion(input, {
      kind: 'region',
      regionId: destination.regionId
    }, caller)
    if (target.kind !== 'launcher') throw error('LAUNCHER_REGION_REQUIRED', 'Target Region is not an open Launcher.')
    const tab = tabs[target.tabId]
    const launcher = tab?.regions[target.regionId]
    if (!tab || launcher?.kind !== 'launcher') {
      throw error('CONTROL_OWNER_LOST', 'Launcher Region owner changed while planning Control open.')
    }
    return {
      workspaceId: tab.workspaceId,
      tabId: tab.id,
      regionId: launcher.regionId,
      kind: 'launcher',
      launcher,
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
  // A Control `placement=tab` is still a new View opened from an existing work line. Preserve the
  // anchor Tab's explicit Topic binding; the Tab id is not a Topic and must never become one.
  const createdTab = createWorkbenchTab(tabId, launcher)
  const tab = anchor.topicId ? { ...createdTab, topicId: anchor.topicId } : createdTab
  const nextLayout = insertTabAfter(layout, anchor.id, tab.id)
  if (nextLayout === layout) throw error('CONTROL_FAILED', 'Tab destination could not be created.')
  tabs[tab.id] = tab
  layouts[anchor.workspaceId] = nextLayout
  return { workspaceId: anchor.workspaceId, tabId: tab.id, regionId, kind: 'tab', launcher, tabs, layouts }
}

/**
 * 把一个 Tab 的 Region 摆成预设布局（或均分 / 把当前格挪到第一位）。
 *
 * `mintRegionId` 而不是 `addedRegionIds`：预设要补几个 Region 是从 `preset` 和当前格数**推导**出来的，
 * 不是调用方的自由参数。此前它是个入参，于是那次推导住在调用方——只有控制协议一个调用方时看不出问题，
 * 但接第二个调用方（GUI 菜单）时那段推导就必须被抄一份，而两份必漂移：抄错的那侧算出的数量与这里
 * `required - current` 的校验不符，用户点了预设只会收到 'Preset Launcher count is invalid.'，
 * 而正确的一侧照旧工作——症状是"同一个预设从菜单点没反应、从命令行却好用"。
 *
 * 收进来之后，"补几个"这件事只有这里一处，调用方连数都数不着，也就没有可漂移的余地。
 */
export function arrangeWorkbenchControlTab(
  tab: WorkbenchTab,
  mode: AgentMuxArrangeMode,
  mintRegionId: () => string
): WorkbenchTab {
  if (mode.kind === 'balance') {
    const next = { ...tab, layout: balanceWorkbenchRegionLayout(tab.layout) }
    assertRegionInvariant(next)
    return next
  }
  if (mode.kind === 'active-first') {
    const next = { ...tab, layout: placeActiveWorkbenchRegionFirst(tab.layout) }
    assertRegionInvariant(next)
    return next
  }
  const required = workbenchRegionPresetSize(mode.preset)
  const present = workbenchRegionBounds(tab.layout.root)
  if (present.length > required) throw error('LAYOUT_CAPACITY_EXCEEDED', 'Tab contains more Regions than the requested preset.')
  const addedRegionIds = Array.from({ length: required - present.length }, mintRegionId)
  // 铸出来的 id 必须互不相同，也不能撞上已在场的。applyWorkbenchRegionLayoutPreset 撞名时会原样
  // 返回旧 layout（它自己那道 Set 检查），那样一来 regions 多了几格、layout 却没变——多出来的格子
  // 不在树上，永远画不出来也永远回收不掉。与其静默留下这种半成品，不如在这里响亮地拒绝。
  const ids = [...present.map((region) => region.regionId), ...addedRegionIds]
  if (new Set(ids).size !== ids.length) {
    throw error('CONTROL_FAILED', 'Preset Region ids collided; the layout was left untouched.')
  }
  const regions = { ...tab.regions }
  for (const regionId of addedRegionIds) {
    regions[regionId] = { regionId, kind: 'launcher', workspaceId: tab.workspaceId }
  }
  const next = {
    ...tab,
    regions,
    layout: applyWorkbenchRegionLayoutPreset(tab.layout, mode.preset, addedRegionIds)
  }
  assertRegionInvariant(next)
  return next
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
