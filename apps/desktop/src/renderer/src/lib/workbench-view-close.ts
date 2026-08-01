import type { SessionControl, SessionSnapshot } from '../../../shared/contracts'
import { activeTopicIdFromLayout, tabEligibilityForActiveTopic } from './scratch-topic-layout'
import { removeTab, type WorkspaceLayout } from './workbench-layout'
import {
  removeWorkbenchRegion,
  tabStillOpen,
  workbenchSurfaces,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'

export type WorkbenchViewCloseResource =
  | {
      key: `browser:${string}`
      kind: 'browser'
      browserId: string
    }
  | {
      key: `session:${string}`
      kind: 'session'
      sessionId: string
      control: SessionControl
    }

export type WorkbenchViewClosePlan = {
  workspaceId: string
  tabGroupId: string
  tabId: string
  closesView: boolean
  surfaces: ReadonlyArray<{
    owner: WorkbenchViewCloseSurfaceOwner
    resourceKey: WorkbenchViewCloseResource['key'] | null
  }>
  resources: readonly WorkbenchViewCloseResource[]
  reservedSessionIds: readonly string[]
}

export type WorkbenchViewCloseSurfaceOwner =
  | {
      regionId: string
      kind: 'agent' | 'terminal'
      phase: 'launching' | 'attached'
      sessionId: string
      runId: string | null
    }
  | { regionId: string; kind: 'browser'; browserId: string }
  | { regionId: string; kind: 'file'; path: string }
  | { regionId: string; kind: 'launcher' }

export type WorkbenchViewCloseReceipt = {
  key: WorkbenchViewCloseResource['key']
  status: 'fulfilled' | 'rejected'
  reason?: unknown
}

export type WorkbenchViewCloseReconciliation = {
  tab: WorkbenchTab | null
  changedWhileClosing: boolean
  failures: WorkbenchViewCloseReceipt[]
}

export type WorkbenchViewTopology = {
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
}

export function planWorkbenchViewClose(input: {
  tabs: Readonly<Record<string, WorkbenchTab>>
  layouts: Readonly<Record<string, WorkspaceLayout>>
  sessions: readonly SessionSnapshot[]
  workspaceId: string
  tabGroupId: string
  tabId: string
  keepAgentSessions: boolean
  closingViewIds?: ReadonlySet<string>
}): WorkbenchViewClosePlan | null {
  const tab = input.tabs[input.tabId]
  const layout = input.layouts[input.workspaceId]
  if (!tab || !layout) return null
  const nextLayouts = {
    ...input.layouts,
    [input.workspaceId]: removeTab(layout, input.tabGroupId, input.tabId)
  }
  const closesView = !tabStillOpen(nextLayouts, input.tabId)
  if (!closesView) {
    return freezePlan({
      workspaceId: input.workspaceId,
      tabGroupId: input.tabGroupId,
      tabId: input.tabId,
      closesView,
      surfaces: [],
      resources: [],
      reservedSessionIds: []
    })
  }

  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const attachedOutsideView = new Set(Object.values(input.tabs).flatMap((candidate) => (
    candidate.id === input.tabId || input.closingViewIds?.has(candidate.id)
      ? []
      : workbenchSurfaces(candidate).flatMap((surface) => (
          (surface.kind === 'agent' || surface.kind === 'terminal') && surface.phase === 'attached'
            ? [surface.sessionId]
            : []
        ))
  )))
  const resources = new Map<WorkbenchViewCloseResource['key'], WorkbenchViewCloseResource>()
  const surfaces = workbenchSurfaces(tab).map((surface) => {
    if (surface.kind === 'browser') {
      const key = `browser:${surface.browserId}` as const
      resources.set(key, { key, kind: 'browser', browserId: surface.browserId })
      return { owner: surfaceOwner(surface, sessions), resourceKey: key }
    }
    if (surface.kind !== 'agent' && surface.kind !== 'terminal') {
      return { owner: surfaceOwner(surface, sessions), resourceKey: null }
    }
    if (surface.phase !== 'attached' || attachedOutsideView.has(surface.sessionId)) {
      return { owner: surfaceOwner(surface, sessions), resourceKey: null }
    }
    const session = sessions.get(surface.sessionId)
    const shouldStop = session !== undefined && (
      surface.kind === 'agent'
        ? !input.keepAgentSessions
        : session.processState !== 'exited'
    )
    if (!shouldStop) return { owner: surfaceOwner(surface, sessions), resourceKey: null }
    const key = `session:${surface.sessionId}` as const
    resources.set(key, {
      key,
      kind: 'session',
      sessionId: surface.sessionId,
      control: freezeSessionControl(session.control)
    })
    return { owner: surfaceOwner(surface, sessions, true), resourceKey: key }
  })
  const plannedResources = [...resources.values()]
  return freezePlan({
    workspaceId: input.workspaceId,
    tabGroupId: input.tabGroupId,
    tabId: input.tabId,
    closesView,
    surfaces,
    resources: plannedResources,
    reservedSessionIds: plannedResources.flatMap((resource) => (
      resource.kind === 'session' ? [resource.sessionId] : []
    ))
  })
}

export function reconcileWorkbenchViewClose(input: {
  plan: WorkbenchViewClosePlan
  currentTab: WorkbenchTab | undefined
  currentSessions: readonly SessionSnapshot[]
  receipts: readonly WorkbenchViewCloseReceipt[]
}): WorkbenchViewCloseReconciliation {
  const receiptByKey = new Map(input.receipts.map((receipt) => [receipt.key, receipt]))
  const currentSessions = new Map(input.currentSessions.map((session) => [session.id, session]))
  const failureCandidates = [
    ...input.receipts.filter((receipt) => receipt.status === 'rejected'),
    ...input.plan.resources.flatMap((resource) => receiptByKey.has(resource.key)
      ? []
      : [{
          key: resource.key,
          status: 'rejected' as const,
          reason: new Error(`Close owner omitted its receipt: ${resource.key}`)
        }])
  ]
  let tab: WorkbenchTab | null = input.currentTab ?? null
  let changedWhileClosing = false
  for (const planned of input.plan.surfaces) {
    if (!tab) break
    const current = tab.regions[planned.owner.regionId]
    if (!sameSurfaceOwner(current, planned.owner, currentSessions)) {
      if (current) changedWhileClosing = true
      continue
    }
    const receipt = planned.resourceKey ? receiptByKey.get(planned.resourceKey) : null
    if (planned.resourceKey && receipt?.status !== 'fulfilled') continue
    tab = removeWorkbenchRegion(tab, planned.owner.regionId)
  }
  if (tab) {
    const plannedRegionIds = new Set(input.plan.surfaces.map(({ owner }) => owner.regionId))
    if (workbenchSurfaces(tab).some((surface) => !plannedRegionIds.has(surface.regionId))) {
      changedWhileClosing = true
    }
  }
  const retainedResourceKeys = new Set(input.plan.surfaces.flatMap((planned) => (
    planned.resourceKey && sameSurfaceOwner(
      tab?.regions[planned.owner.regionId],
      planned.owner,
      currentSessions
    )
      ? [planned.resourceKey]
      : []
  )))
  const failures = failureCandidates.filter((failure) => retainedResourceKeys.has(failure.key))
  return { tab, changedWhileClosing, failures }
}

/**
 * 关掉 `plan.tabId` 这一步的**唯一**出处。
 *
 * 为什么独立成一个函数而不是在 `applyWorkbenchViewCloseTopology` 里内联：那个函数有两条会改 layout
 * 的出口（`closesView` 为假的早返回、以及删掉 tab 之后的正常返回），它们本就是同一个决定。此前两处
 * 各写一份 `removeTab(...)`，于是给一处补东西另一处会静默保留旧行为，且没有任何测试会红。
 *
 * 它顺手承载了那件容易漏的事：下一活动项必须限定在当前 Topic 内。Scratch 的所有 Topic 共用一份
 * layout，`recentTabIds` 里混着别的 Topic 的 Tab，不限定就会把用户静默弹到另一个 Topic。
 *
 * `activeTopicIdFromLayout` 必须在**移除之前**问：移除之后活动 Tab 已经换人，那时再问会得到刚被选中
 * 的那张的 Topic，判据就自我循环了。
 */
function closeTabWithinActiveTopic(
  layout: WorkspaceLayout,
  tabs: Readonly<Record<string, WorkbenchTab>>,
  plan: WorkbenchViewClosePlan
): WorkspaceLayout {
  return removeTab(
    layout,
    plan.tabGroupId,
    plan.tabId,
    tabEligibilityForActiveTopic(tabs, activeTopicIdFromLayout(layout, tabs))
  )
}

export function applyWorkbenchViewCloseTopology(
  state: WorkbenchViewTopology,
  plan: WorkbenchViewClosePlan,
  tab: WorkbenchTab | null
): WorkbenchViewTopology {
  const layout = state.layouts[plan.workspaceId]
  if (!layout) return state
  const closeTab = (): WorkspaceLayout => closeTabWithinActiveTopic(layout, state.tabs, plan)
  if (!plan.closesView) {
    return {
      tabs: state.tabs,
      layouts: { ...state.layouts, [plan.workspaceId]: closeTab() }
    }
  }
  if (tab) {
    return state.tabs[plan.tabId] === tab
      ? state
      : { tabs: { ...state.tabs, [plan.tabId]: tab }, layouts: state.layouts }
  }
  if (!state.tabs[plan.tabId]) return state
  const tabs = { ...state.tabs }
  delete tabs[plan.tabId]
  return {
    tabs,
    layouts: { ...state.layouts, [plan.workspaceId]: closeTab() }
  }
}

function freezePlan(plan: WorkbenchViewClosePlan): WorkbenchViewClosePlan {
  for (const surface of plan.surfaces) {
    Object.freeze(surface.owner)
    Object.freeze(surface)
  }
  for (const resource of plan.resources) Object.freeze(resource)
  Object.freeze(plan.surfaces)
  Object.freeze(plan.resources)
  Object.freeze(plan.reservedSessionIds)
  return Object.freeze(plan)
}

function freezeSessionControl(control: SessionControl): SessionControl {
  const run = Object.freeze({ ...control.run })
  return Object.freeze({ ...control, run })
}

export function workbenchViewCloseAllowsView(
  plans: Readonly<Record<string, WorkbenchViewClosePlan>>,
  viewId: string
): boolean {
  return plans[viewId] === undefined
}

export function workbenchViewCloseAllowsSession(
  plans: Readonly<Record<string, WorkbenchViewClosePlan>>,
  sessionId: string
): boolean {
  return !Object.values(plans).some((plan) => plan.reservedSessionIds.includes(sessionId))
}

export function hasAttachedSessionOutsideClosingViews(input: {
  tabs: Readonly<Record<string, WorkbenchTab>>
  plans: Readonly<Record<string, WorkbenchViewClosePlan>>
  sessionId: string
}): boolean {
  return Object.values(input.tabs).some((tab) => (
    input.plans[tab.id] === undefined && workbenchSurfaces(tab).some((surface) => (
      (surface.kind === 'agent' || surface.kind === 'terminal') &&
      surface.phase === 'attached' &&
      surface.sessionId === input.sessionId
    ))
  ))
}

export function sameWorkbenchSurfaceOwner(
  left: WorkbenchSurface | undefined,
  right: WorkbenchSurface
): boolean {
  const sessions = new Map<string, SessionSnapshot>()
  return sameSurfaceOwner(left, surfaceOwner(right, sessions), sessions)
}

function surfaceOwner(
  surface: WorkbenchSurface,
  sessions: ReadonlyMap<string, SessionSnapshot>,
  includeRun = false
): WorkbenchViewCloseSurfaceOwner {
  if (surface.kind === 'agent' || surface.kind === 'terminal') {
    return {
      regionId: surface.regionId,
      kind: surface.kind,
      phase: surface.phase,
      sessionId: surface.sessionId,
      runId: includeRun ? (sessions.get(surface.sessionId)?.control.run.runId ?? null) : null
    }
  }
  if (surface.kind === 'browser') {
    return { regionId: surface.regionId, kind: surface.kind, browserId: surface.browserId }
  }
  if (surface.kind === 'file') {
    return { regionId: surface.regionId, kind: surface.kind, path: surface.path }
  }
  return { regionId: surface.regionId, kind: surface.kind }
}

function sameSurfaceOwner(
  left: WorkbenchSurface | undefined,
  right: WorkbenchViewCloseSurfaceOwner,
  sessions: ReadonlyMap<string, SessionSnapshot>
): boolean {
  if (!left || left.kind !== right.kind || left.regionId !== right.regionId) return false
  if (left.kind === 'agent' || left.kind === 'terminal') {
    return (
      (right.kind === 'agent' || right.kind === 'terminal') &&
      left.phase === right.phase &&
      left.sessionId === right.sessionId &&
      (right.runId === null ||
        (sessions.get(left.sessionId)?.control.run.runId ?? null) === right.runId)
    )
  }
  if (left.kind === 'browser' && right.kind === 'browser') return left.browserId === right.browserId
  if (left.kind === 'file' && right.kind === 'file') return left.path === right.path
  return left.kind === 'launcher' && right.kind === 'launcher'
}
