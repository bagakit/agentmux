import type { SessionControl, SessionSnapshot } from '../../../shared/contracts'
import { activeTopicIdFromLayout, tabEligibilityForActiveTopic } from './scratch-topic-layout'
import { removeTab, type WorkspaceLayout } from '@agentmux/layout'
import {
  removeWorkbenchRegion,
  gitDiffIdentity,
  tabStillOpen,
  workbenchSurfaces,
  type BrowserWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { assertUnreachableSurface, isSessionSurface } from './workbench-surface-kinds'

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
    /** Every resource this Region's removal waits on: its own, plus the Agent a Browser binds. */
    resourceKeys: ReadonlyArray<WorkbenchViewCloseResource['key']>
  }>
  resources: readonly WorkbenchViewCloseResource[]
  reservedSessionIds: readonly string[]
}

/** Transient approved machine targets; the same close owner produces Tab and Region targets. */
export type WorkbenchViewCloseTarget = Pick<WorkbenchViewClosePlan, 'tabId' | 'surfaces' | 'resources'>

/**
 * What a close in progress holds. A Tab close stores its whole plan; a split close holds only its
 * Region (`regionId`) and the Sessions it is stopping.
 */
export type WorkbenchViewCloseReservation = {
  tabId: string
  regionId?: string
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
  | { regionId: string; kind: 'file'; workspaceId: string; path: string }
  | { regionId: string; kind: 'launcher' }
  | { regionId: string; kind: 'git'; identity: string }
  | { regionId: string; kind: 'git-diff'; identity: string }

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
  /** Views other closes in progress are already removing. */
  closing?: WorkbenchViewClosing
}): WorkbenchViewClosePlan | null {
  const tab = input.tabs[input.tabId]
  const layout = input.layouts[input.workspaceId]
  if (!tab || !layout) return null
  const nextLayouts = {
    ...input.layouts,
    [input.workspaceId]: removeTab(layout, input.tabGroupId, input.tabId)
  }
  const closesView = !tabStillOpen(nextLayouts, input.tabId)
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  if (!closesView) {
    return freezePlan({
      workspaceId: input.workspaceId,
      tabGroupId: input.tabGroupId,
      tabId: input.tabId,
      closesView,
      surfaces: workbenchSurfaces(tab).map(surface => ({ owner: surfaceOwner(surface, sessions, true), resourceKeys: [] })),
      resources: [],
      reservedSessionIds: []
    })
  }

  const attachedOutsideView = sessionsShownOutsideClosingViews({
    tabs: input.tabs,
    sessions: input.sessions,
    isClosing: (candidate, regionId) => candidate.id === input.tabId || input.closing?.(candidate, regionId) === true
  })
  const resources = new Map<WorkbenchViewCloseResource['key'], WorkbenchViewCloseResource>()
  const stopResource = (session: SessionSnapshot | undefined, kind: 'agent' | 'terminal'): WorkbenchViewCloseResource['key'] | null => {
    if (!session || attachedOutsideView.has(session.id) || session.processState === 'exited') return null
    if (kind === 'agent' && input.keepAgentSessions) return null
    const resource = workbenchSessionCloseResource(session)
    resources.set(resource.key, resource)
    return resource.key
  }
  const surfaces = workbenchSurfaces(tab).map((surface) => {
    if (surface.kind === 'browser') {
      const key = `browser:${surface.browserId}` as const
      resources.set(key, { key, kind: 'browser', browserId: surface.browserId })
      const binding = browserAgentBinding(surface)
      const bound = binding ? stopResource(boundAgentSession(binding, input.sessions), 'agent') : null
      return { owner: surfaceOwner(surface, sessions), resourceKeys: bound ? [key, bound] : [key] }
    }
    if (!isSessionSurface(surface)) {
      return { owner: surfaceOwner(surface, sessions), resourceKeys: [] }
    }
    if (surface.phase !== 'attached' || attachedOutsideView.has(surface.sessionId)) {
      return { owner: surfaceOwner(surface, sessions), resourceKeys: [] }
    }
    const key = stopResource(sessions.get(surface.sessionId), surface.kind)
    return { owner: surfaceOwner(surface, sessions, true), resourceKeys: key ? [key] : [] }
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

export function workbenchRegionCloseTarget(input: {
  tabs: Readonly<Record<string, WorkbenchTab>>; sessions: readonly SessionSnapshot[]
  tabId: string; regionId: string; keepAgentSessions?: boolean | undefined; closing?: WorkbenchViewClosing
}): WorkbenchViewCloseTarget | null {
  const surface = input.tabs[input.tabId]?.regions[input.regionId]
  if (!surface) return null
  const closing = closingWorkbenchRegion(input.tabId, input.regionId)
  const resources: WorkbenchViewCloseResource[] = input.keepAgentSessions ? [] : agentSessionsWithoutViewsAfterClosing({
    tabs: input.tabs, sessions: input.sessions, isClosing: (tab, regionId) =>
      closing(tab, regionId) || input.closing?.(tab, regionId) === true
  }).sessions.map(workbenchSessionCloseResource)
  if (surface.kind === 'browser') resources.push({ key: `browser:${surface.browserId}`, kind: 'browser', browserId: surface.browserId })
  return freezeCloseTarget({ tabId: input.tabId,
    surfaces: [{ owner: surfaceOwner(surface, new Map(input.sessions.map(session => [session.id, session])), true), resourceKeys: resources.map(resource => resource.key) }], resources })
}

/** Metadata may change and new outside views may reduce work; neither authorizes a new resource target. */
export function workbenchViewCloseStillApproved(approved: WorkbenchViewCloseTarget, current: WorkbenchViewCloseTarget,
  tab: WorkbenchTab | undefined): boolean {
  if (approved.tabId !== current.tabId || approved.surfaces.length !== current.surfaces.length) return false
  const byId = new Map<string, SessionSnapshot>() // View identity does not require an old Run observation.
  if (!approved.surfaces.every(({ owner }) => current.surfaces.some(surface => surface.owner.regionId === owner.regionId) &&
    sameSurfaceOwner(tab?.regions[owner.regionId], owner.kind === 'agent' || owner.kind === 'terminal' ? { ...owner, runId: null } : owner, byId))) return false
  const sameControl = (left: SessionControl, right: SessionControl): boolean => left.kind === right.kind &&
    left.hostId === right.hostId && left.run.runId === right.run.runId &&
    (left.kind === 'agent' ? right.kind === 'agent' && left.agentSessionId === right.agentSessionId : right.kind === 'terminal' && left.runId === right.runId)
  return current.resources.every(resource => approved.resources.some(original => original.key === resource.key &&
    (resource.kind === 'browser' ? original.kind === 'browser' && original.browserId === resource.browserId
      : original.kind === 'session' && sameControl(original.control, resource.control))))
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
    if (planned.resourceKeys.some((key) => receiptByKey.get(key)?.status !== 'fulfilled')) continue
    tab = removeWorkbenchRegion(tab, planned.owner.regionId)
  }
  if (tab) {
    const plannedRegionIds = new Set(input.plan.surfaces.map(({ owner }) => owner.regionId))
    if (workbenchSurfaces(tab).some((surface) => !plannedRegionIds.has(surface.regionId))) {
      changedWhileClosing = true
    }
  }
  const retainedResourceKeys = new Set(input.plan.surfaces.flatMap((planned) => (
    sameSurfaceOwner(tab?.regions[planned.owner.regionId], planned.owner, currentSessions)
      ? planned.resourceKeys
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
  Object.freeze(plan.reservedSessionIds)
  return freezeCloseTarget(plan)
}

function freezeCloseTarget<T extends WorkbenchViewCloseTarget>(plan: T): T {
  for (const surface of plan.surfaces) {
    Object.freeze(surface.owner)
    Object.freeze(surface)
  }
  for (const resource of plan.resources) Object.freeze(resource)
  Object.freeze(plan.surfaces)
  Object.freeze(plan.resources)
  return Object.freeze(plan)
}

function freezeSessionControl(control: SessionControl): SessionControl {
  const run = Object.freeze({ ...control.run })
  return Object.freeze({ ...control, run })
}

export function workbenchViewCloseAllowsView(
  plans: Readonly<Record<string, WorkbenchViewCloseReservation>>,
  viewId: string
): boolean {
  return plans[viewId] === undefined
}

export function workbenchViewCloseAllowsSession(
  plans: Readonly<Record<string, WorkbenchViewCloseReservation>>,
  sessionId: string
): boolean {
  return !Object.values(plans).some((plan) => plan.reservedSessionIds.includes(sessionId))
}

/** Which Views a close removes: whole Tabs or one Region inside one. */
export type WorkbenchViewClosing = (tab: WorkbenchTab, regionId: string) => boolean

export function closingWorkbenchTabs(tabIds: Iterable<string>): WorkbenchViewClosing {
  const closing = new Set(tabIds)
  return (tab) => closing.has(tab.id)
}

export function closingWorkbenchRegion(tabId: string, regionId: string): WorkbenchViewClosing {
  return (tab, candidate) => tab.id === tabId && candidate === regionId
}

/** The Views closes in progress hold: a Tab reservation covers the Tab, a split one only its Region. */
export function closingWorkbenchReservations(
  plans: Readonly<Record<string, WorkbenchViewCloseReservation>>
): WorkbenchViewClosing {
  return (tab, regionId) => {
    const plan = plans[tab.id]
    return plan !== undefined && (plan.regionId === undefined || plan.regionId === regionId)
  }
}

type BrowserAgentBinding = { hostId: string; agentSessionId: string }

/** Current control facts outrank cold metadata. `null` is a confirmed "no Agent"; `undefined` is unknown. */
export function browserAgentBinding(surface: BrowserWorkbenchSurface): BrowserAgentBinding | null | undefined {
  return surface.control ? surface.control.agent : surface.agent
}

function boundAgentSession(
  binding: BrowserAgentBinding,
  sessions: readonly SessionSnapshot[]
): SessionSnapshot | undefined {
  return sessions.find((session) => session.kind === 'agent' &&
    session.control.hostId === binding.hostId &&
    session.control.agentSessionId === binding.agentSessionId)
}

/**
 * The Sessions a View outside the closing set still shows: attached Agent/Terminal Regions, and Browsers
 * bound to an exact Agent of `sessions`. An unknown binding is never guessed to be another View.
 * This is the one "is there another View" judgment; the last-View confirmation, the close plan and the
 * pre-stop recheck all read it.
 */
export function sessionsShownOutsideClosingViews(input: {
  tabs: Readonly<Record<string, WorkbenchTab>>
  sessions: readonly SessionSnapshot[]
  isClosing: WorkbenchViewClosing
}): Set<string> {
  const shown = new Set<string>()
  for (const tab of Object.values(input.tabs)) {
    for (const surface of workbenchSurfaces(tab)) {
      if (input.isClosing(tab, surface.regionId)) continue
      if (isSessionSurface(surface)) {
        if (surface.phase === 'attached') shown.add(surface.sessionId)
        continue
      }
      if (surface.kind !== 'browser') continue
      const binding = browserAgentBinding(surface)
      const session = binding ? boundAgentSession(binding, input.sessions) : undefined
      if (session) shown.add(session.id)
    }
  }
  return shown
}

export function hasAttachedSessionOutsideClosingViews(input: {
  tabs: Readonly<Record<string, WorkbenchTab>>
  sessions: readonly SessionSnapshot[]
  isClosing: WorkbenchViewClosing
  sessionId: string
}): boolean {
  return sessionsShownOutsideClosingViews(input).has(input.sessionId)
}

/** A closing View names an Agent whose Session cannot be confirmed: asked about, named, never stopped. */
export type UnconfirmedAgentView = {
  key: string
  regionId: string
  /** `null`: the closing Browser's Agent binding itself is unknown. */
  agentSessionId: string | null
}

export type AgentLastViewClose = {
  /** Agent Sessions whose Run has not exited and whose last View this close removes. */
  sessions: SessionSnapshot[]
  unconfirmed: UnconfirmedAgentView[]
}

/** "This close removes the last View of these Agents", for Tab close and split close alike. */
export function agentSessionsWithoutViewsAfterClosing(input: {
  tabs: Readonly<Record<string, WorkbenchTab>>
  sessions: readonly SessionSnapshot[]
  isClosing: WorkbenchViewClosing
}): AgentLastViewClose {
  const shown = sessionsShownOutsideClosingViews(input)
  const byId = new Map(input.sessions.map((session) => [session.id, session]))
  const closing = new Map<string, SessionSnapshot>()
  const unconfirmed = new Map<string, UnconfirmedAgentView>()
  const unknownAgent = (regionId: string, agentSessionId: string): void => {
    const key = `agent:${agentSessionId}`
    if (!unconfirmed.has(key)) unconfirmed.set(key, { key, regionId, agentSessionId })
  }
  for (const tab of Object.values(input.tabs)) {
    for (const surface of workbenchSurfaces(tab)) {
      if (!input.isClosing(tab, surface.regionId)) continue
      if (surface.kind === 'agent') {
        if (surface.phase !== 'attached' || shown.has(surface.sessionId)) continue
        const session = byId.get(surface.sessionId)
        if (session) closing.set(session.id, session)
        else unknownAgent(surface.regionId, surface.sessionId)
        continue
      }
      if (surface.kind !== 'browser') continue
      const binding = browserAgentBinding(surface)
      if (binding === null) continue
      if (binding === undefined) {
        const key = `browser:${surface.browserId}`
        unconfirmed.set(key, { key, regionId: surface.regionId, agentSessionId: null })
        continue
      }
      const session = boundAgentSession(binding, input.sessions)
      if (!session) unknownAgent(surface.regionId, binding.agentSessionId)
      else if (!shown.has(session.id)) closing.set(session.id, session)
    }
  }
  return {
    sessions: [...closing.values()].filter((session) => session.processState !== 'exited'),
    unconfirmed: [...unconfirmed.values()]
  }
}

export function workbenchSessionCloseResource(
  session: SessionSnapshot
): Extract<WorkbenchViewCloseResource, { kind: 'session' }> {
  return { key: `session:${session.id}`, kind: 'session', sessionId: session.id, control: freezeSessionControl(session.control) }
}

export function sameWorkbenchSurfaceOwner(
  left: WorkbenchSurface | undefined,
  right: WorkbenchSurface
): boolean {
  return sameWorkbenchSurfaceOwnerReference(left, workbenchSurfaceOwner(right))
}

/** Frozen operation identities, without copying content or topology into a recovery intent. */
export function workbenchSurfaceOwner(surface: WorkbenchSurface): WorkbenchViewCloseSurfaceOwner {
  return surfaceOwner(surface, new Map<string, SessionSnapshot>())
}
export function sameWorkbenchSurfaceOwnerReference(surface: WorkbenchSurface | undefined, owner: WorkbenchViewCloseSurfaceOwner): boolean {
  return sameSurfaceOwner(surface, owner, new Map<string, SessionSnapshot>())
}

function surfaceOwner(
  surface: WorkbenchSurface,
  sessions: ReadonlyMap<string, SessionSnapshot>,
  includeRun = false
): WorkbenchViewCloseSurfaceOwner {
  // Every kind projects to exactly one owner descriptor, classified once. The old tail was a bare
  // `return { regionId, kind }` fall-through that any unhandled kind silently took — so a new kind
  // would get a launcher-shaped owner (no session teardown, no browser release) with nothing going
  // red. `assertUnreachableSurface` at the default forces a new kind to be placed here before it can
  // compile. Not a `Record`: agent/terminal/browser/file each carry different owner fields.
  switch (surface.kind) {
    case 'agent':
    case 'terminal':
      return {
        regionId: surface.regionId,
        kind: surface.kind,
        phase: surface.phase,
        sessionId: surface.sessionId,
        runId: includeRun ? (sessions.get(surface.sessionId)?.control.run.runId ?? null) : null
      }
    case 'browser':
      return { regionId: surface.regionId, kind: surface.kind, browserId: surface.browserId }
    case 'file':
      return { regionId: surface.regionId, kind: surface.kind, workspaceId: surface.workspaceId, path: surface.path }
    case 'git':
      return { regionId: surface.regionId, kind: surface.kind, identity: JSON.stringify([surface.workspaceId, surface.scope]) }
    case 'git-diff':
      return { regionId: surface.regionId, kind: surface.kind, identity: gitDiffIdentity(surface.workspaceId, surface.comparison) }
    case 'launcher':
      return { regionId: surface.regionId, kind: surface.kind }
    default:
      return assertUnreachableSurface(surface)
  }
}

function sameSurfaceOwner(
  left: WorkbenchSurface | undefined,
  right: WorkbenchViewCloseSurfaceOwner,
  sessions: ReadonlyMap<string, SessionSnapshot>
): boolean {
  if (!left || left.kind !== right.kind || left.regionId !== right.regionId) return false
  // Identity comparison per kind, exhaustive. The old tail `return left.kind === 'launcher' && …` was
  // the catch-all a new kind would silently take, reporting "different owner" for two identical new
  // surfaces. `assertUnreachableSurface` forces the new kind to declare how it compares.
  switch (left.kind) {
    case 'agent':
    case 'terminal':
      return (
        (right.kind === 'agent' || right.kind === 'terminal') &&
        left.phase === right.phase &&
        left.sessionId === right.sessionId &&
        (right.runId === null ||
          (sessions.get(left.sessionId)?.control.run.runId ?? null) === right.runId)
      )
    case 'browser':
      return right.kind === 'browser' && left.browserId === right.browserId
    case 'file':
      return right.kind === 'file' && left.workspaceId === right.workspaceId && left.path === right.path
    case 'git':
      return right.kind === 'git' && JSON.stringify([left.workspaceId, left.scope]) === right.identity
    case 'git-diff':
      return right.kind === 'git-diff' && gitDiffIdentity(left.workspaceId, left.comparison) === right.identity
    case 'launcher':
      return right.kind === 'launcher'
    default:
      return assertUnreachableSurface(left)
  }
}
