import { COLLECTED_REPLY_TITLE } from '@agentmux/client-ui/conversation-sources'
import { projectConversationSummary } from '@agentmux/core/conversation'
import { scratchTopicsForConfig } from './scratch-topic-snapshots'
import type { AgentSessionHistoryDescriptor, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { isAgentActivityStatusSource } from '@agentmux/core/agent-status'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { type ScratchTopicSnapshot, scratchTopicIdFromWorkspacePath } from '../../../shared/scratch-topics'
import { focusLaneForSession, type AgentFocusLane } from './agent-focus'
import { scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { agentDisplayName, firstPromptFromTimeline, workspaceForSession } from './workbench-tabs'
import { isNeedsYouState } from './attention-vocabulary'
import { turnWorking } from './activity-working-state'
import { clampStep } from '@agentmux/client-ui/activity-step-summary'
import { sessionRecentActivity } from './session-recency'
import { sessionStatusLabel } from './session-presentation'
import { agentStateEnteredAt } from './agent-state-time'
import { launcherTimelineRecap, type LauncherRecap } from './launcher-resume'
import { observeAgentSession, activityObservationPresentation } from './agent-observation'
import type { AgentObservation } from '@agentmux/core/agent-status'

export const FOCUS_BUCKETS = ['attention', 'working', 'results', 'idle'] as const
export type FocusBucket = typeof FOCUS_BUCKETS[number]
export type FocusContext = {
  /** Original semantic control, independent of a client's presentation id. */
  control?: Extract<SessionSnapshot, { kind: 'agent' }>['control']
  id: string; name: string; detail: string; state: SessionSnapshot['status']['state']; stateLabel: string
  processState: SessionSnapshot['processState']
  runUnobserved?: boolean
  bucket: FocusBucket; kind: SessionSnapshot['kind']; providerId: string | null
  executorId?: string
  hostId: string; topicId: string | null; workspaceId: string; workspaceName: string; workspacePath: string; liveAgent: boolean; actionable: boolean
  lastActivityAt: number | null
  runId: string; workingEnteredAt: number | null
  stateEnteredAt?: number
  workspace: WorkspaceRecord | undefined
  retainedRunIds?: readonly string[]
  nativeSessionId?: string
  originAddress?: string
  /** undefined is a deferred retained-card read, never evidence of no history. */
  recap: LauncherRecap | null | undefined
  detailIsRecap: boolean
  detailKind?: 'activity' | 'message' | 'service' | 'observation'
  activitySemantic?: AgentObservation['semantic']
}
/** A retained descriptor supplies reading metadata, never a synthetic Session or current Run. */
export function retainedFocusContext(source: AgentSessionHistoryDescriptor, name?: string): FocusContext {
  return { id: source.agentSessionId, hostId: source.hostId, name: name ?? source.agentSessionId,
    kind: 'agent', providerId: source.history?.providerId ?? null, ...(source.history?.executorId ? { executorId: source.history.executorId } : {}),
    workspacePath: source.history?.workspacePath ?? '', workspace: undefined, workspaceId: '', workspaceName: 'Retained Session', topicId: null,
    runId: '', runUnobserved: true, processState: 'interrupted', state: 'disconnected', stateLabel: source.state === 'retired' ? 'Retired' : 'Unobserved', bucket: 'idle',
    liveAgent: false, actionable: false, lastActivityAt: null, workingEnteredAt: null,
    detail: `${source.state === 'retired' ? 'Retired' : 'Retained'} Session · Current Run is unconfirmed`, detailIsRecap: false, detailKind: 'service', recap: null }
}

export function groupFocusContexts(rows: readonly FocusContext[]): Record<FocusBucket, FocusContext[]> {
  const groups: Record<FocusBucket, FocusContext[]> = { attention: [], working: [], results: [], idle: [] }
  for (const row of rows) groups[row.bucket].push(row)
  return groups
}
type Inputs = { sessions: readonly SessionSnapshot[]; timelines: Record<string, AgentTimelineSnapshot>; agentNames: Record<string, string>; config: AppConfig | null; scratchTopicSnapshots: Record<string, ScratchTopicsSnapshot> }
function sameFocusInputs(previous: Inputs | undefined, input: Inputs): boolean {
  return Boolean(previous && previous.sessions === input.sessions && previous.timelines === input.timelines && previous.agentNames === input.agentNames && previous.config === input.config && previous.scratchTopicSnapshots === input.scratchTopicSnapshots)
}
function focusInputs({ sessions, timelines, agentNames, config, scratchTopicSnapshots }: Inputs): Inputs {
  return { sessions, timelines, agentNames, config, scratchTopicSnapshots }
}
function focusScopeForSession(input: Pick<Inputs, 'config' | 'scratchTopicSnapshots'>, session: SessionSnapshot) {
  const topics = scratchTopicsForConfig(input.config, input.scratchTopicSnapshots)
  const workspace = workspaceForSession(input.config, session, topics)
  const topicId = workspace ? scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath, topics) : null
  return { workspace, topicId }
}
export function focusNavigationSummary(input: Pick<Inputs, 'sessions' | 'config' | 'scratchTopicSnapshots'>, now = Date.now()) {
  let working = 0, requests = 0, errors = 0
  for (const session of input.sessions) {
    if (session.kind !== 'agent') continue
    // Results and Idle both contribute zero: counts need no conversation result or recap.
    const bucket = focusBucketForSession(session, false, now)
    if (bucket !== 'working' && bucket !== 'attention') continue
    const { workspace, topicId } = focusScopeForSession(input, session)
    if (focusLaneForSession(topicId, scratchTopicsForWorkspace(input.scratchTopicSnapshots, workspace)) === 'pmo') continue
    if (bucket === 'working') working++
    else {
      if (session.pendingInteraction || isNeedsYouState(session.status.state)) requests++
      if (session.status.state === 'error') errors++
    }
  }
  return { working, requests, errors }
}
export function createFocusNavigationSummarySelector() {
  let previous: Inputs | undefined
  let summary = { working: 0, requests: 0, errors: 0 }
  return (input: Inputs) => {
    if (sameFocusInputs(previous, input)) return summary
    summary = focusNavigationSummary(input)
    previous = focusInputs(input)
    return summary
  }
}
export function focusActivityEntryTime(session: SessionSnapshot): number | undefined {
  const activity = session.kind === 'agent' ? session.semanticStatus : undefined
  if (!activity || !isAgentActivityStatusSource(activity.source)) return undefined
  const now = Date.now()
  const held = [activity.stateEnteredAt, activity.aggregateActivityAt].filter((at): at is number => at !== undefined && Number.isFinite(at) && at > 0 && at <= now)
  return held.length ? Math.max(...held) : undefined
}
/** Held task timestamps only; visits, output bytes and repeated observations are absent. */
export function focusLastTaskActivityAt(items: readonly AgentTimelineItem[], enteredAt?: number, now = Date.now()): number | null {
  let latest: number | null = null
  const remember = (at: number | undefined) => {
    if (at !== undefined && Number.isFinite(at) && at > 0 && at <= now) latest = Math.max(latest ?? 0, at)
  }
  remember(enteredAt)
  for (const item of items) {
    if (item.kind !== 'lifecycle') remember(item.updatedAt)
    else if (item.activityState && 'state' in item.activityState && isAgentActivityStatusSource(item.source)) remember(item.activityState.stateEnteredAt)
  }
  return latest
}
function workingEntryTime(session: SessionSnapshot): number | null {
  const activity = session.kind === 'agent' ? session.semanticStatus : undefined
  const time = activity?.stateEnteredAt
  return session.processState === 'running' && session.status.state === 'working'
    && activity?.state === 'working' && isAgentActivityStatusSource(activity.source)
    && time !== undefined && Number.isFinite(time) && time > 0 ? time : null
}
export function focusBucketForSession(session: SessionSnapshot, hasCurrentResult: boolean, now = Date.now()): FocusBucket {
  const state = session.status.state
  if ((session.kind === 'agent' && session.pendingInteraction) || isNeedsYouState(state) || state === 'error') return 'attention'
  if (session.runUnobserved || session.processState !== 'running') return 'idle'
  const activity = session.kind === 'agent' ? observeAgentSession(session, now).semantic : undefined
  if (activity === 'active' || turnWorking(state) && (state === 'starting' || session.kind !== 'agent')) return 'working'
  if (hasCurrentResult && state === 'done' && (session.kind !== 'agent' || !session.currentActivity)) return 'results'
  return 'idle'
}
/** The neutral column is a presentation group, not evidence that every member is idle. */
export function focusNeutralGroupSummary(rows: readonly FocusContext[]): { label: string; detail: string } {
  let idle = 0, unknown = 0, recovery = 0
  for (const row of rows) {
    if (row.processState !== 'running') recovery++
    else if (row.activitySemantic === 'unknown' || row.activitySemantic === 'unsupported' || row.activitySemantic === undefined && row.state === 'running') unknown++
    else idle++
  }
  const label = recovery ? 'Idle / Recovery' : unknown && !idle ? 'Activity unknown'
    : unknown ? 'Idle / Unknown' : 'Idle / Recovery'
  return { label, detail: `Idle ${idle} · Activity unknown ${unknown} · Recovery ${recovery}` }
}
type FocusTimelineStamp = {
  revision: number | undefined; sourceHostId: string | undefined; agentSessionId: string | undefined; streamEpoch: string | undefined
  items: AgentTimelineSnapshot['items'] | undefined; stream: AgentTimelineSnapshot['stream']
}
/** Scalar copies also detect accepted in-place Timeline/source updates. */
export function focusTimelineStamp(timeline: AgentTimelineSnapshot | undefined): FocusTimelineStamp {
  return { items: timeline?.items, stream: timeline?.stream,
    revision: timeline?.revision, sourceHostId: timeline?.sourceHostId,
    agentSessionId: timeline?.agentSessionId, streamEpoch: timeline?.stream?.epoch }
}
function sameTimelineStamp(before: FocusTimelineStamp | undefined, timeline: AgentTimelineSnapshot | undefined): boolean {
  const current = focusTimelineStamp(timeline)
  return Boolean(before && Object.keys(current).every(key => before[key as keyof FocusTimelineStamp] === current[key as keyof FocusTimelineStamp]))
}
type FocusConversationFacts = FocusTimelineStamp & {
  recap: LauncherRecap | null
  latest: { detail: string; text: string; currentResult: boolean; matchesRecap: boolean } | null
}
function sameConversationFacts(facts: FocusConversationFacts, timeline: AgentTimelineSnapshot | undefined): boolean {
  return facts.revision === timeline?.revision && facts.sourceHostId === timeline?.sourceHostId && facts.agentSessionId === timeline?.agentSessionId && facts.streamEpoch === timeline?.stream?.epoch
}
// Focus, its transient navigation preview and the Space directory read the same
// accepted Timeline. Share only its small derived text facts, never row order or
// Session state; weak keys do not retain a retired Timeline or another reader.
const conversationFactsByTimeline = new WeakMap<AgentTimelineSnapshot, FocusConversationFacts>()
function focusConversationFacts(timeline: AgentTimelineSnapshot | undefined, previous?: { timeline: AgentTimelineSnapshot | undefined; conversation: FocusConversationFacts | undefined }): FocusConversationFacts {
  const held = timeline && conversationFactsByTimeline.get(timeline) || previous?.conversation
  if (held && held.items === timeline?.items && held.stream === timeline?.stream && sameConversationFacts(held, timeline)) {
    if (timeline) conversationFactsByTimeline.set(timeline, held)
    return held
  }
  const items = timeline?.items ?? []
  const latest = [...items].reverse().find(item => item.kind !== 'lifecycle')
  const records = timeline ? projectConversationSummary({ agentSessionId: timeline.agentSessionId, timeline }) : []
  const latestRecord = records.filter(record => record.role === 'message' || record.role === 'observation').at(-1)
  const recap = items.length ? launcherTimelineRecap(records) : null
  const text = latestRecord?.content ? clampStep(latestRecord.content.replace(/\s+/g, ' ').trim(), 'head', 140) : ''
  const label = latestRecord?.role === 'observation' ? COLLECTED_REPLY_TITLE : latestRecord?.author?.kind === 'agent' ? 'Response' : 'Prompt'
  const facts: FocusConversationFacts = { items: timeline?.items, stream: timeline?.stream, revision: timeline?.revision, sourceHostId: timeline?.sourceHostId, agentSessionId: timeline?.agentSessionId, streamEpoch: timeline?.stream?.epoch, recap,
    latest: latestRecord?.content ? { detail: `${label} · ${text}`, text,
      currentResult: Boolean((latestRecord.role === 'observation' || latestRecord.role === 'message' && latestRecord.author?.kind === 'agent') && latestRecord.rawId === latest?.id && latestRecord.original.kind === 'captured' && latestRecord.original.item.status === 'complete' && latestRecord.content.trim()),
      matchesRecap: Boolean(recap && latestRecord.content.trim() && (recap.source === 'Last reply observation' ? latestRecord.role === 'observation' : latestRecord.role === 'message' && (recap.source === 'Last assistant message') === (latestRecord.author?.kind === 'agent'))) } : null }
  if (timeline) conversationFactsByTimeline.set(timeline, facts)
  return facts
}
/** Read-only Agent facts shared by Focus and the scoped Space directory. No eligibility policy or IO. */
export function agentContextForSession(session: SessionSnapshot, timeline: AgentTimelineSnapshot | undefined, userName: string | undefined, workspace: WorkspaceRecord | undefined, topicId: string | null): FocusContext {
  return agentContextWithConversation(session, timeline, userName, workspace, topicId, focusConversationFacts(timeline))
}
function agentContextWithConversation(session: SessionSnapshot, timeline: AgentTimelineSnapshot | undefined, userName: string | undefined, workspace: WorkspaceRecord | undefined, topicId: string | null, conversation: FocusConversationFacts | undefined): FocusContext {
  const state = session.status.state, items = timeline?.items ?? [], recap = conversation?.recap, latest = conversation?.latest
  const result = latest?.currentResult
  const pending = session.kind === 'agent' && Boolean(session.pendingInteraction)
  const now = Date.now()
  const bucket = focusBucketForSession(session, Boolean(result), now)
  const observation = session.kind === 'agent' ? observeAgentSession(session, now) : undefined
  const activitySemantic = observation?.semantic
  const activityExplanation = observation ? activityObservationPresentation(observation, state !== 'disconnected') : null
  const stateLabel = session.runUnobserved && bucket === 'idle' ? 'Run not observed'
    : session.processState === 'interrupted' && bucket === 'idle' ? 'Interrupted'
    : session.processState === 'running' && bucket === 'idle' && activitySemantic === 'unknown'
    ? activityExplanation!.label
    : session.processState === 'running' && bucket === 'idle' && activitySemantic === 'unsupported'
      ? 'Activity not reported' : session.processState === 'running' && bucket === 'idle' && activitySemantic === 'idle'
        ? 'Idle' : bucket === 'working' && activitySemantic === 'active' ? 'Working' : sessionStatusLabel(session)
  const name = session.kind === 'agent' ? agentDisplayName({ userName, firstPrompt: firstPromptFromTimeline(timeline), fallbackLabel: session.label, providerLabel: session.providerId }) : userName ?? session.label
  const lastActivityAt = focusLastTaskActivityAt(items, focusActivityEntryTime(session), now)
  const stateEnteredAt = session.kind === 'agent' && session.currentActivity ? undefined : agentStateEnteredAt(session, now)
  let detail = 'No activity details observed', detailIsMessage = false
  let detailKind: FocusContext['detailKind'] = pending || bucket === 'attention' || state === 'disconnected' || state === 'exited' ? 'service' : 'activity'
  if (bucket === 'idle' && (session.runUnobserved || session.processState === 'interrupted')) {
    detail = `${session.runUnobserved ? 'Run not observed' : 'Run interrupted'} · ${session.status.detail?.trim() || (session.runUnobserved ? 'Original Run state is unknown' : 'Cause unknown')}`
    detailKind = 'service'
  } else if (state === 'disconnected' && session.status.detail?.trim()) {
    detail = session.status.detail.trim()
    detailKind = 'service'
  } else if (bucket === 'idle' && activityExplanation) {
    detail = `${activityExplanation.label} · ${activityExplanation.detail}`
    detailKind = session.processState === 'running' && state !== 'disconnected' ? 'observation' : 'service'
  } else if (session.kind === 'terminal' && (state === 'error' || state === 'exited' || state === 'disconnected')) {
    const facts = [session.status.exitReason === 'user-stopped' ? 'Stopped by you' : null,
      session.status.detail?.trim(), session.status.exitCode === undefined ? null : `Exit code ${session.status.exitCode}`].filter(Boolean)
    detail = facts.length ? facts.join(' · ') : session.processState === 'running'
      ? 'Run is alive · Connection status unknown' : session.processState === 'interrupted'
        ? 'Run interrupted · Cause unknown' : 'Process exited · Cause unknown'
  } else if (result && (bucket === 'results' || bucket === 'idle' && state === 'running')) {
    detail = state === 'running' ? latest.detail : latest.text
    detailIsMessage = true
    detailKind = 'message'
  }
  else {
    const activity = sessionRecentActivity(session, items, session.workspacePath)
    if (activity !== state) detail = activity
    else if (session.kind === 'agent' && latest) {
      detail = latest.detail
      detailIsMessage = true
      detailKind = 'message'
    } else if (state === 'running') detail = session.kind === 'agent' ? 'Run is alive · No current work signal' : 'Terminal context · No task signal'
    else if (state === 'done') detail = 'Ready for another prompt · No result observed'
  }
  // The latest non-lifecycle record can only be the recap's record if its kind matches
  // the helper's chosen kind and it is nonempty. A newer prompt is a different fact.
  const detailIsRecap = Boolean(detailIsMessage && latest?.matchesRecap)
  const displayState = bucket === 'working' && activitySemantic === 'active' ? 'working'
    : state === 'working' && activitySemantic !== 'active' || bucket === 'idle' && activitySemantic === 'idle' && session.kind === 'agent' && session.currentActivity
      ? 'running' : state
  const retainedRunIds = [...new Set(items.flatMap(item => item.activityState ? [item.activityState.run.runId] : []))]
  return { ...(retainedRunIds.length ? { retainedRunIds } : {}), id: session.id, ...(session.kind === 'agent' && (session.nativeHandle?.sessionId ?? session.nativeSessionId) ? { nativeSessionId: session.nativeHandle?.sessionId ?? session.nativeSessionId } : {}), name, detail, state: displayState, stateLabel, processState: session.processState, runUnobserved: session.runUnobserved === true, bucket, kind: session.kind, providerId: session.providerId,
    ...(session.kind === 'agent' ? { executorId: session.executorId, control: session.control } : {}),
    hostId: session.hostId, topicId, workspace, workspaceId: workspace?.id ?? `${session.hostId}:${session.workspacePath}`, workspaceName: workspace?.name ?? session.workspacePath.split('/').filter(Boolean).at(-1) ?? 'Unassigned', workspacePath: session.workspacePath,
    liveAgent: session.kind === 'agent' && session.processState === 'running', actionable: pending || isNeedsYouState(state) || session.kind === 'agent' && state === 'error', lastActivityAt,
    runId: session.control.run.runId, ...(stateEnteredAt === undefined ? {} : { stateEnteredAt }), workingEnteredAt: activitySemantic === 'active' && !(session.kind === 'agent' && session.currentActivity) ? workingEntryTime(session) : null, recap, detailIsRecap, detailKind,
    ...(activitySemantic === undefined ? {} : { activitySemantic }) }
}
function sameSessionPresentation(a: SessionSnapshot, b: SessionSnapshot, now: number): boolean {
  return (a.kind === 'agent' ? a.nativeHandle?.sessionId ?? a.nativeSessionId : null) === (b.kind === 'agent' ? b.nativeHandle?.sessionId ?? b.nativeSessionId : null)
    && a.kind === b.kind && a.label === b.label && a.providerId === b.providerId && a.hostId === b.hostId
    && (a.kind === 'agent' ? a.executorId : null) === (b.kind === 'agent' ? b.executorId : null)
    && a.workspacePath === b.workspacePath && a.processState === b.processState && a.status.state === b.status.state
    && a.status.detail === b.status.detail && a.runUnobserved === b.runUnobserved
    && a.status.source === b.status.source
    && (a.kind === 'agent' ? a.semanticStatus : undefined) === (b.kind === 'agent' ? b.semanticStatus : undefined)
    && (a.kind === 'agent' ? a.currentActivity : undefined) === (b.kind === 'agent' ? b.currentActivity : undefined)
    && (a.kind !== 'terminal' || a.status.exitCode === b.status.exitCode && a.status.exitReason === b.status.exitReason)
    && focusActivityEntryTime(a) === focusActivityEntryTime(b)
    && a.control.run.runId === b.control.run.runId && a.control.hostId === b.control.hostId
    && (a.control.kind === 'agent' ? a.control.agentSessionId : null) === (b.control.kind === 'agent' ? b.control.agentSessionId : null)
    && workingEntryTime(a) === workingEntryTime(b)
    && agentStateEnteredAt(a, now) === agentStateEnteredAt(b, now)
    && (a.kind === 'agent' ? a.pendingInteraction : undefined) === (b.kind === 'agent' ? b.pendingInteraction : undefined)
}
/** Stable presentation for a caller-owned workspace membership; no Focus lane policy or IO. */
export function createWorkspaceAgentContextsSelector() {
  const cache = new Map<string, { session: SessionSnapshot; timeline: AgentTimelineSnapshot | undefined; conversation: FocusConversationFacts; name: string | undefined; semantic: AgentObservation['semantic'] | undefined; model: FocusContext }>()
  let result: FocusContext[] = []
  return (sessions: readonly SessionSnapshot[], timelines: Record<string, AgentTimelineSnapshot | undefined>, names: Record<string, string | undefined>, workspace: WorkspaceRecord, topics: readonly ScratchTopicSnapshot[] | null): FocusContext[] => {
    const retained = new Set<string>(), now = Date.now()
    const rows = sessions.map(session => {
      const key = JSON.stringify([session.hostId, session.id]), old = cache.get(key)
      retained.add(key)
      const timeline = timelines[session.id], name = names[session.id]
      const semantic = session.kind === 'agent' ? observeAgentSession(session, now).semantic : undefined
      const topicId = scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath, topics)
      if (old && old.semantic === semantic && sameSessionPresentation(old.session, session, now) && old.timeline === timeline && sameConversationFacts(old.conversation, timeline) && old.name === name && old.model.workspace === workspace && old.model.topicId === topicId) return old.model
      const conversation = focusConversationFacts(timeline, old)
      const model = agentContextWithConversation(session, timeline, name, workspace, topicId, conversation)
      cache.set(key, { session, timeline, conversation, name, semantic, model })
      return model
    })
    for (const key of cache.keys()) if (!retained.has(key)) cache.delete(key)
    if (!sameItems(result, rows)) result = rows
    return result
  }
}
export type FocusProjection = { contexts: FocusContext[]; laneContexts: FocusContext[]; pmoAttention: string[]; coordinationContexts: FocusContext[] }
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean { return a.length === b.length && a.every((item, index) => item === b[index]) }
function sameLaneFacts(a: FocusContext, b: FocusContext): boolean {
  return a.workspace === b.workspace && a.hostId === b.hostId && a.workspacePath === b.workspacePath && a.topicId === b.topicId
    && a.workspaceId === b.workspaceId && a.workspaceName === b.workspaceName && a.liveAgent === b.liveAgent && a.bucket === b.bucket && a.lastActivityAt === b.lastActivityAt
}
/** One per-surface cache owns execution, the compact PMO reminder and explicitly
 * requested coordination metadata. Coordination never enters execution history. */
function createFocusProjectionCache() {
  let groupSequence = 0
  const cache = new Map<string, { group: { key: string; enteredAt: number | null; sequence: number } | null; session: SessionSnapshot; activitySemantic: AgentObservation['semantic']; timeline: AgentTimelineSnapshot | undefined; stamp: FocusTimelineStamp | undefined; deferred: boolean; conversation: FocusConversationFacts | undefined; name: string | undefined; config: AppConfig | null; workspace: WorkspaceRecord | undefined; topicId: string | null; lane: AgentFocusLane | null; model: FocusContext | null; laneModel: FocusContext | null; coordinationModel: FocusContext | null }>()
  let previous: Inputs | undefined
  let previousMode: 'full' | 'metadata' | undefined
  let previousCoordination = false
  let result: FocusProjection = {contexts: [], laneContexts: [], pmoAttention: [], coordinationContexts: []}
  const select = (input: Inputs, active = true, mode?: 'full' | 'metadata', coordination = false): FocusProjection => {
    if (!active) return result
    if (sameFocusInputs(previous, input) && previousMode === mode && previousCoordination === coordination && (mode === undefined
      || [...cache].every(([id, row]) => row.timeline === input.timelines[id] && sameTimelineStamp(row.stamp, input.timelines[id])))) return result
    const rows: FocusContext[] = []
    const laneRows: FocusContext[] = []
    const pmoAttention: string[] = []
    const coordinationRows: FocusContext[] = []
    const retained = new Set<string>()
    const now = Date.now()
    for (const session of input.sessions) {
      // Focus scans Agent work; plain Terminals keep their original workbench and history.
      if (session.kind !== 'agent') continue
      retained.add(session.id)
      const activitySemantic = observeAgentSession(session, now).semantic
      const timeline = input.timelines[session.id], name = input.agentNames[session.id], old = cache.get(session.id)
      // These exact subjects always take the original idle/service branch;
      // their result classification and detail never consume conversation text.
      const deferred = mode === 'metadata' && (session.processState === 'interrupted' || session.runUnobserved === true)
        && !session.pendingInteraction && !isNeedsYouState(session.status.state) && session.status.state !== 'error'
      if (old && (!coordination || old.lane !== 'pmo' || old.coordinationModel) && old.deferred === deferred && old.activitySemantic === activitySemantic && sameSessionPresentation(old.session, session, now) && old.timeline === timeline && (mode !== undefined ? sameTimelineStamp(old.stamp, timeline) : !old.conversation || sameConversationFacts(old.conversation, timeline)) && old.name === name && old.config === input.config && previous?.scratchTopicSnapshots === input.scratchTopicSnapshots) {
        if (old.model) { rows.push(old.model); laneRows.push(old.laneModel!) }
        else if (old.lane === 'pmo') {
          if (coordination) coordinationRows.push(old.coordinationModel!)
          if (focusBucketForSession(session, false) === 'attention') pmoAttention.push(session.id)
        }
        continue
      }
      const sameOwner = old && previous?.scratchTopicSnapshots === input.scratchTopicSnapshots && old.config === input.config && old.session.hostId === session.hostId && old.session.workspacePath === session.workspacePath
      const { workspace, topicId } = sameOwner ? old : focusScopeForSession(input, session)
      let group: { key: string; enteredAt: number | null; sequence: number } | null = null
      let model: FocusContext | null = null
      let laneModel: FocusContext | null = null
      let coordinationModel: FocusContext | null = null
      let conversation: FocusConversationFacts | undefined
      const lane = focusLaneForSession(topicId, scratchTopicsForWorkspace(input.scratchTopicSnapshots, workspace))
      if (lane === 'pmo') {
        if (focusBucketForSession(session, false) === 'attention') pmoAttention.push(session.id)
        if (coordination) {
          // Metadata only: no first prompt, retained body or new conversation
          // projection. Explicit null also prevents an unsolicited card recap read.
          const next = agentContextWithConversation(session, undefined, name, workspace, topicId, focusConversationFacts(undefined))
          coordinationModel = old?.coordinationModel && Object.keys(next).length === Object.keys(old.coordinationModel).length && Object.keys(next).every(key => next[key as keyof FocusContext] === old.coordinationModel![key as keyof FocusContext]) ? old.coordinationModel : next
          coordinationRows.push(coordinationModel)
        }
      } else {
        conversation = deferred ? undefined : focusConversationFacts(timeline, old)
        const next = agentContextWithConversation(session, timeline, name, workspace, topicId, conversation)
        if (lane === null) {
          next.detail = 'Mote identity is not confirmed · ' + next.detail
          next.detailIsRecap = false
          next.detailKind = 'service'
        }
        if (next.retainedRunIds && old?.model?.retainedRunIds && sameItems(next.retainedRunIds, old.model.retainedRunIds)) next.retainedRunIds = old.model.retainedRunIds
        const groupKey = JSON.stringify([next.runId, next.hostId, next.workspaceId, next.workspacePath, next.topicId, next.bucket])
        // State entry is an honest initial seed only when it explains this displayed group.
        // A pending request can enter Attention while the semantic state is still Working.
        const initialEntry = !session.pendingInteraction && next.state === session.status.state ? next.stateEnteredAt ?? null : null
        group = old?.group?.key === groupKey ? old.group : {
          key: groupKey, enteredAt: old ? now : initialEntry, sequence: groupSequence++
        }
        model = old?.model && Object.keys(next).length === Object.keys(old.model).length && Object.keys(next).every(key => next[key as keyof FocusContext] === old.model![key as keyof FocusContext]) ? old.model : next
        rows.push(model)
        laneModel = old?.laneModel && sameLaneFacts(old.laneModel, model) ? old.laneModel : model
        laneRows.push(laneModel)
      }
      cache.set(session.id, { group, session, activitySemantic, timeline, stamp: conversation ?? (mode !== undefined ? focusTimelineStamp(timeline) : undefined), deferred, conversation, name, config: input.config, workspace, topicId, lane, model, laneModel, coordinationModel })
    }
    for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id)
    // Only Focus card order changes. Lane facts keep their original input order and priorities.
    rows.sort((a, b) => {
      const first = cache.get(a.id)!.group!, second = cache.get(b.id)!.group!
      return (second.enteredAt ?? -Infinity) - (first.enteredAt ?? -Infinity) || first.sequence - second.sequence
    })
    result = {contexts: sameItems(result.contexts, rows) ? result.contexts : rows, laneContexts: sameItems(result.laneContexts, laneRows) ? result.laneContexts : laneRows, pmoAttention: sameItems(result.pmoAttention, pmoAttention) ? result.pmoAttention : pmoAttention,
      coordinationContexts: sameItems(result.coordinationContexts, coordinationRows) ? result.coordinationContexts : coordinationRows}
    previous = focusInputs(input)
    previousMode = mode
    previousCoordination = coordination
    return result
  }
  return select
}

export function createFocusProjectionSelector() {
  return createFocusProjectionCache()
}
