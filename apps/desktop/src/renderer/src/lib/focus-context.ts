import type { AgentTimelineSnapshot } from '@agentmux/core'
import { isAgentActivityStatusSource } from '@agentmux/core/agent-status'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, scratchTopicIdFromWorkspacePath } from '../../../shared/scratch-topics'
import { agentDisplayName, firstPromptFromTimeline, workspaceForSession, workbenchSurfaces, type WorkbenchTab } from './workbench-tabs'
import { regionIds } from '@agentmux/layout'
import { regionDisplayNames, regionSurfaceLabel } from './region-display-name'
import { isSessionSurface } from './workbench-surface-kinds'
import { isNeedsYouState } from './attention-vocabulary'
import { turnWorking } from './activity-working-state'
import { clampStep } from './activity-step-summary'
import { sessionRecentActivity } from './session-recency'

export type FocusBucket = 'attention' | 'working' | 'results' | 'idle'
export type FocusContext = {
  id: string; name: string; detail: string; state: SessionSnapshot['status']['state']; stateLabel: string
  processState: SessionSnapshot['processState']
  bucket: FocusBucket; kind: SessionSnapshot['kind']; providerId: string | null
  hostId: string; topicId: string | null; workspaceId: string; workspaceName: string; workspacePath: string; liveAgent: boolean; actionable: boolean
  lastActivityAt: number | null
  runId: string; workingEnteredAt: number | null
  workspace: WorkspaceRecord | undefined
  originAddress?: string
}
type Inputs = { sessions: readonly SessionSnapshot[]; timelines: Record<string, AgentTimelineSnapshot>; agentNames: Record<string, string>; config: AppConfig | null }
function activityEntryTime(session: SessionSnapshot): number | undefined {
  const activity = session.kind === 'agent' ? session.semanticStatus : undefined
  return activity && isAgentActivityStatusSource(activity.source) ? activity.stateEnteredAt : undefined
}
function workingEntryTime(session: SessionSnapshot): number | null {
  const activity = session.kind === 'agent' ? session.semanticStatus : undefined
  const time = activity?.stateEnteredAt
  return session.processState === 'running' && session.status.state === 'working'
    && activity?.state === 'working' && isAgentActivityStatusSource(activity.source)
    && time !== undefined && Number.isFinite(time) && time > 0 ? time : null
}
export function focusBucketForSession(session: SessionSnapshot, hasCurrentResult: boolean): FocusBucket {
  const state = session.status.state
  if ((session.kind === 'agent' && session.pendingInteraction) || isNeedsYouState(state) || state === 'error') return 'attention'
  if (turnWorking(state)) return 'working'
  if (hasCurrentResult && state === 'done') return 'results'
  return 'idle'
}
function context(session: SessionSnapshot, timeline: AgentTimelineSnapshot | undefined, userName: string | undefined, workspace: WorkspaceRecord | undefined, topicId: string | null): FocusContext {
  const state = session.status.state, items = timeline?.items ?? []
  const latest = [...items].reverse().find(item => item.kind !== 'lifecycle')
  const result = latest?.kind === 'assistant_message' && latest.status === 'complete' && latest.content?.trim() ? latest : null
  const pending = session.kind === 'agent' && Boolean(session.pendingInteraction)
  const bucket = focusBucketForSession(session, Boolean(result))
  const stateLabel = state === 'error' ? 'Failed' : pending ? 'Request pending' : isNeedsYouState(state) ? (state === 'blocked' ? 'Blocked' : 'Needs reply')
    : state === 'done' ? 'Idle' : state === 'running' ? (session.kind === 'agent' ? 'Status unknown' : 'Shell open')
    : state === 'disconnected' ? 'Disconnected' : state === 'exited' ? (session.kind === 'terminal' && session.status.exitReason !== 'user-stopped' ? 'Exited' : 'Stopped') : state === 'starting' ? 'Starting' : 'Working'
  const name = session.kind === 'agent' ? agentDisplayName({ userName, firstPrompt: firstPromptFromTimeline(timeline), fallbackLabel: session.label, providerLabel: session.providerId }) : userName ?? session.label
  const activityTimes = items.filter(item => item.kind !== 'lifecycle').map(item => item.updatedAt)
  const enteredAt = activityEntryTime(session)
  if (enteredAt !== undefined) activityTimes.push(enteredAt)
  const lastActivityAt = activityTimes.reduce<number | null>((last, time) => Number.isFinite(time) && time > 0 ? Math.max(last ?? 0, time) : last, null)
  let detail = 'No activity details observed'
  if (session.kind === 'terminal' && (state === 'error' || state === 'exited' || state === 'disconnected')) {
    const facts = [session.status.exitReason === 'user-stopped' ? 'Stopped by you' : null,
      session.status.detail?.trim(), session.status.exitCode === undefined ? null : `Exit code ${session.status.exitCode}`].filter(Boolean)
    detail = facts.length ? facts.join(' · ') : session.processState === 'running'
      ? 'Run is alive · Connection status unknown' : session.processState === 'interrupted'
        ? 'Run interrupted · Cause unknown' : 'Process exited · Cause unknown'
  } else if (result && (bucket === 'results' || bucket === 'idle' && state === 'running')) {
    const response = clampStep(result.content!.replace(/\s+/g, ' ').trim(), 'head', 140)
    detail = state === 'running' ? `Response · ${response}` : response
  }
  else {
    const activity = sessionRecentActivity(session, items, session.workspacePath)
    if (activity !== state) detail = activity
    else if (session.kind === 'agent' && latest?.content && (latest.kind === 'user_message' || latest.kind === 'assistant_message')) {
      const label = latest.kind === 'user_message' ? 'Prompt' : 'Response'
      detail = `${label} · ${clampStep(latest.content.replace(/\s+/g, ' ').trim(), 'head', 140)}`
    } else if (state === 'running') detail = session.kind === 'agent' ? 'Run is alive · No current work signal' : 'Terminal context · No task signal'
    else if (state === 'done') detail = 'Ready for another prompt · No result observed'
  }
  return { id: session.id, name, detail, state, stateLabel, processState: session.processState, bucket, kind: session.kind, providerId: session.providerId,
    hostId: session.hostId, topicId, workspace, workspaceId: workspace?.id ?? `${session.hostId}:${session.workspacePath}`, workspaceName: workspace?.name ?? session.workspacePath.split('/').filter(Boolean).at(-1) ?? 'Unassigned', workspacePath: session.workspacePath,
    liveAgent: session.kind === 'agent' && session.processState === 'running', actionable: pending || isNeedsYouState(state), lastActivityAt,
    runId: session.control.run.runId, workingEnteredAt: workingEntryTime(session) }
}
function sameSessionPresentation(a: SessionSnapshot, b: SessionSnapshot): boolean {
  return a.kind === b.kind && a.label === b.label && a.providerId === b.providerId && a.hostId === b.hostId
    && a.workspacePath === b.workspacePath && a.processState === b.processState && a.status.state === b.status.state
    && a.status.detail === b.status.detail
    && (a.kind !== 'terminal' || a.status.exitCode === b.status.exitCode && a.status.exitReason === b.status.exitReason)
    && activityEntryTime(a) === activityEntryTime(b)
    && a.control.run.runId === b.control.run.runId && workingEntryTime(a) === workingEntryTime(b)
    && (a.kind === 'agent' ? a.pendingInteraction : undefined) === (b.kind === 'agent' ? b.pendingInteraction : undefined)
}
export type FocusProjection = { contexts: FocusContext[]; laneContexts: FocusContext[]; pmoAttention: string[] }
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean { return a.length === b.length && a.every((item, index) => item === b[index]) }
function sameLaneFacts(a: FocusContext, b: FocusContext): boolean {
  return a.workspace === b.workspace && a.hostId === b.hostId && a.workspacePath === b.workspacePath && a.topicId === b.topicId
    && a.workspaceId === b.workspaceId && a.workspaceName === b.workspaceName && a.liveAgent === b.liveAgent && a.bucket === b.bucket && a.lastActivityAt === b.lastActivityAt
}
/** One existing per-surface cache owns execution rows and the separate PMO attention projection. */
function createFocusProjectionCache() {
  const cache = new Map<string, { session: SessionSnapshot; timeline: AgentTimelineSnapshot | undefined; name: string | undefined; config: AppConfig | null; workspace: WorkspaceRecord | undefined; topicId: string | null; model: FocusContext | null; laneModel: FocusContext | null }>()
  let previous: Inputs | undefined
  let result: FocusProjection = {contexts: [], laneContexts: [], pmoAttention: []}
  const select = (input: Inputs): FocusProjection => {
    if (previous && previous.sessions === input.sessions && previous.timelines === input.timelines && previous.agentNames === input.agentNames && previous.config === input.config) return result
    const rows: FocusContext[] = []
    const laneRows: FocusContext[] = []
    const pmoAttention: string[] = []
    for (const session of input.sessions) {
      const timeline = input.timelines[session.id], name = input.agentNames[session.id], old = cache.get(session.id)
      if (old && sameSessionPresentation(old.session, session) && old.timeline === timeline && old.name === name && old.config === input.config) {
        if (old.model) { rows.push(old.model); laneRows.push(old.laneModel!) }
        else if (focusBucketForSession(session, false) === 'attention') pmoAttention.push(session.id)
        continue
      }
      const sameOwner = old && old.config === input.config && old.session.hostId === session.hostId && old.session.workspacePath === session.workspacePath
      const workspace = sameOwner ? old.workspace : workspaceForSession(input.config, session)
      const topicId = sameOwner ? old.topicId : workspace ? scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath) : null
      let model: FocusContext | null = null
      let laneModel: FocusContext | null = null
      if (topicId === PMO_TEAMS_TOPIC_ID) {
        if (focusBucketForSession(session, false) === 'attention') pmoAttention.push(session.id)
      } else {
        const next = context(session, timeline, name, workspace, topicId)
        model = old?.model && Object.keys(next).every(key => next[key as keyof FocusContext] === old.model![key as keyof FocusContext]) ? old.model : next
        rows.push(model)
        laneModel = old?.laneModel && sameLaneFacts(old.laneModel, model) ? old.laneModel : model
        laneRows.push(laneModel)
      }
      cache.set(session.id, { session, timeline, name, config: input.config, workspace, topicId, model, laneModel })
    }
    const retained = new Set(input.sessions.map(session => session.id))
    for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id)
    result = {contexts: sameItems(result.contexts, rows) ? result.contexts : rows, laneContexts: sameItems(result.laneContexts, laneRows) ? result.laneContexts : laneRows, pmoAttention: sameItems(result.pmoAttention, pmoAttention) ? result.pmoAttention : pmoAttention}
    previous = {sessions: input.sessions, timelines: input.timelines, agentNames: input.agentNames, config: input.config}
    return result
  }
  return { select, session: (id: string) => cache.get(id)?.session }
}

export function createFocusProjectionSelector() {
  return createFocusProjectionCache().select
}

/** Current Terminals retain their original working surface; ended unowned Runs remain in Runtime history. */
export function createTerminalFocusProjectionSelector() {
  const { select: project, session: sessionForId } = createFocusProjectionCache()
  const members = new Map<string, { tab: WorkbenchTab; sessions: Array<{ sessionId: string; regionId: string }> }>()
  const names = new Map<string, { tab: WorkbenchTab; regions: WorkbenchTab['regions']; root: WorkbenchTab['layout']['root']; labels: Map<string, string | undefined>; sessions: readonly SessionSnapshot[]; names: Map<string, string> }>()
  const rows = new Map<string, { base: FocusContext; tab: WorkbenchTab; regionName: string; regionId: string; model: FocusContext }>()
  let owners = new Map<string, { tabId: string; regionId: string }>()
  let order: string[] = []
  let previousTabs: Readonly<Record<string, WorkbenchTab>> | undefined
  let previousContexts: readonly FocusContext[] | undefined
  let result: FocusProjection = { contexts: [], laneContexts: [], pmoAttention: [] }
  return (input: Inputs & { tabs: Readonly<Record<string, WorkbenchTab>> }): FocusProjection => {
    const base = project(input)
    const labelsChanged = (cached: { sessions: readonly SessionSnapshot[]; labels: ReadonlyMap<string, string | undefined> }) => {
      if (cached.sessions === input.sessions || cached.labels.size === 0) return false
      for (const [id, label] of cached.labels) if (sessionForId(id)?.label !== label) return true
      cached.sessions = input.sessions
      return false
    }
    if (previousContexts === base.contexts && previousTabs === input.tabs && !Array.from(names.values()).some(labelsChanged)) {
      if (result.pmoAttention !== base.pmoAttention) result = { ...result, pmoAttention: base.pmoAttention }
      return result
    }

    if (previousTabs !== input.tabs) {
      const nextOrder = Object.keys(input.tabs)
      let changed = !sameItems(order, nextOrder)
      for (const tabId of nextOrder) {
        const tab = input.tabs[tabId]!, old = members.get(tabId)
        if (old?.tab === tab) continue
        const sessions = old?.tab.regions === tab.regions ? old.sessions : workbenchSurfaces(tab).flatMap(surface => isSessionSurface(surface) ? [{ sessionId: surface.sessionId, regionId: surface.regionId }] : [])
        if (!old || old.sessions.length !== sessions.length || old.sessions.some((surface, index) => surface.sessionId !== sessions[index]!.sessionId || surface.regionId !== sessions[index]!.regionId)) changed = true
        members.set(tabId, { tab, sessions })
      }
      for (const id of members.keys()) if (!input.tabs[id]) { members.delete(id); names.delete(id) }
      if (changed) {
        owners = new Map()
        // Match tabForFocusedSession/selectSession: first Tab, then first session surface in record order.
        for (const tabId of nextOrder) for (const surface of members.get(tabId)!.sessions) {
          if (!owners.has(surface.sessionId)) owners.set(surface.sessionId, { tabId, regionId: surface.regionId })
        }
      }
      order = nextOrder
    }

    const checked = new Map<string, Map<string, string>>()
    const contextRows = base.contexts.flatMap(context => {
      if (context.kind !== 'terminal') return [context]
      const owner = owners.get(context.id), tab = owner ? input.tabs[owner.tabId] : undefined
      if (!owner && context.processState !== 'running') { rows.delete(context.id); return [] }
      if (!owner || !tab) { rows.delete(context.id); return [context] }
      let regionNames = checked.get(tab.id)
      if (!regionNames) {
        const old = names.get(tab.id)
        if (old && (old.tab === tab || old.regions === tab.regions && old.root === tab.layout.root) && !labelsChanged(old)) {
          old.tab = tab
          regionNames = old.names
        } else {
          const labels = new Map<string, string | undefined>()
          const regions = regionIds(tab.layout.root).map(regionId => {
            const surface = tab.regions[regionId]!
            const session = surface.kind === 'agent' ? sessionForId(surface.sessionId) : undefined
            if (surface.kind === 'agent') labels.set(surface.sessionId, session?.label)
            return { regionId, label: regionSurfaceLabel(surface, session ? [session] : []) }
          })
          regionNames = new Map(regionDisplayNames(regions).map(region => [region.regionId, region.name]))
          names.set(tab.id, { tab, regions: tab.regions, root: tab.layout.root, labels, sessions: input.sessions, names: regionNames })
        }
        checked.set(tab.id, regionNames)
      }
      const regionName = regionNames.get(owner.regionId)
      if (!regionName) { rows.delete(context.id); return [context] }
      const old = rows.get(context.id)
      if (old?.base === context && old.tab === tab && old.regionName === regionName && old.regionId === owner.regionId) return [old.model]
      const name = tab.name ? `${tab.name} · ${regionName}` : regionName
      const originAddress = `Tab ${tab.id}\nRegion ${owner.regionId}`
      const model = old?.base === context && old.model.name === name && old.model.originAddress === originAddress ? old.model : { ...context, name, originAddress }
      rows.set(context.id, { base: context, tab, regionName, regionId: owner.regionId, model })
      return [model]
    })
    if (previousContexts !== base.contexts) {
      const retained = new Set(base.contexts.map(context => context.id))
      for (const id of rows.keys()) if (!retained.has(id)) rows.delete(id)
    }
    const visibleIds = new Set(contextRows.map(context => context.id))
    const laneRows = base.laneContexts.filter(context => visibleIds.has(context.id))
    result = { ...base, contexts: sameItems(result.contexts, contextRows) ? result.contexts : contextRows,
      laneContexts: sameItems(result.laneContexts, laneRows) ? result.laneContexts : laneRows }
    previousContexts = base.contexts
    previousTabs = input.tabs
    return result
  }
}
