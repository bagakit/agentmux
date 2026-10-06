import { scratchTopicsForConfig } from './scratch-topic-snapshots'
import type { AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { isAgentActivityStatusSource } from '@agentmux/core/agent-status'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { scratchTopicIdFromWorkspacePath } from '../../../shared/scratch-topics'
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
  recap: LauncherRecap | null
  detailIsRecap: boolean
  detailKind?: 'activity' | 'message' | 'service'
  activitySemantic?: AgentObservation['semantic']
}
export function groupFocusContexts(rows: readonly FocusContext[]): Record<FocusBucket, FocusContext[]> {
  const groups: Record<FocusBucket, FocusContext[]> = { attention: [], working: [], results: [], idle: [] }
  for (const row of rows) groups[row.bucket].push(row)
  return groups
}
type Inputs = { sessions: readonly SessionSnapshot[]; timelines: Record<string, AgentTimelineSnapshot>; agentNames: Record<string, string>; config: AppConfig | null; scratchTopicSnapshots: Record<string, ScratchTopicsSnapshot> }
function activityEntryTime(session: SessionSnapshot): number | undefined {
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
  if (turnWorking(state) && (state === 'starting' || session.kind !== 'agent' || observeAgentSession(session, now).semantic === 'active')) return 'working'
  if (hasCurrentResult && state === 'done') return 'results'
  return 'idle'
}
/** The neutral column is a presentation group, not evidence that every member is idle. */
export function focusNeutralGroupSummary(rows: readonly FocusContext[]): { label: string; detail: string } {
  let idle = 0, unknown = 0, recovery = 0
  for (const row of rows) {
    if (row.processState !== 'running') recovery++
    else if (row.activitySemantic === 'unknown' || row.activitySemantic === 'unsupported' || row.state === 'running') unknown++
    else idle++
  }
  const label = recovery ? 'Idle / Recovery' : unknown && !idle ? 'Activity unknown'
    : unknown ? 'Idle / Unknown' : 'Idle / Recovery'
  return { label, detail: `Idle ${idle} · Activity unknown ${unknown} · Recovery ${recovery}` }
}
/** Read-only Agent facts shared by Focus and the scoped Space directory. No eligibility policy or IO. */
export function agentContextForSession(session: SessionSnapshot, timeline: AgentTimelineSnapshot | undefined, userName: string | undefined, workspace: WorkspaceRecord | undefined, topicId: string | null): FocusContext {
  const state = session.status.state, items = timeline?.items ?? []
  const latest = [...items].reverse().find(item => item.kind !== 'lifecycle')
  const result = latest?.kind === 'assistant_message' && latest.status === 'complete' && latest.content?.trim() ? latest : null
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
      ? 'Activity not reported' : sessionStatusLabel(session)
  const name = session.kind === 'agent' ? agentDisplayName({ userName, firstPrompt: firstPromptFromTimeline(timeline), fallbackLabel: session.label, providerLabel: session.providerId }) : userName ?? session.label
  const lastActivityAt = focusLastTaskActivityAt(items, activityEntryTime(session), now)
  const stateEnteredAt = agentStateEnteredAt(session, now)
  const recap = items.length ? launcherTimelineRecap(timeline) : null
  let detail = 'No activity details observed', detailIsMessage = false
  let detailKind: FocusContext['detailKind'] = pending || bucket === 'attention' || state === 'disconnected' || state === 'exited' ? 'service' : 'activity'
  if (bucket === 'idle' && (session.runUnobserved || session.processState === 'interrupted')) {
    detail = `${session.runUnobserved ? 'Run not observed' : 'Run interrupted'} · ${session.status.detail?.trim() || (session.runUnobserved ? 'Original Run state is unknown' : 'Cause unknown')}`
    detailKind = 'service'
  } else if (bucket === 'idle' && activityExplanation) {
    detail = `${activityExplanation.label} · ${activityExplanation.detail}`
    detailKind = 'service'
  } else if (session.kind === 'terminal' && (state === 'error' || state === 'exited' || state === 'disconnected')) {
    const facts = [session.status.exitReason === 'user-stopped' ? 'Stopped by you' : null,
      session.status.detail?.trim(), session.status.exitCode === undefined ? null : `Exit code ${session.status.exitCode}`].filter(Boolean)
    detail = facts.length ? facts.join(' · ') : session.processState === 'running'
      ? 'Run is alive · Connection status unknown' : session.processState === 'interrupted'
        ? 'Run interrupted · Cause unknown' : 'Process exited · Cause unknown'
  } else if (result && (bucket === 'results' || bucket === 'idle' && state === 'running')) {
    const response = clampStep(result.content!.replace(/\s+/g, ' ').trim(), 'head', 140)
    detail = state === 'running' ? `Response · ${response}` : response
    detailIsMessage = true
    detailKind = 'message'
  }
  else {
    const activity = sessionRecentActivity(session, items, session.workspacePath)
    if (activity !== state) detail = activity
    else if (session.kind === 'agent' && latest?.content && (latest.kind === 'user_message' || latest.kind === 'assistant_message')) {
      const label = latest.kind === 'user_message' ? 'Prompt' : 'Response'
      detail = `${label} · ${clampStep(latest.content.replace(/\s+/g, ' ').trim(), 'head', 140)}`
      detailIsMessage = true
      detailKind = 'message'
    } else if (state === 'running') detail = session.kind === 'agent' ? 'Run is alive · No current work signal' : 'Terminal context · No task signal'
    else if (state === 'done') detail = 'Ready for another prompt · No result observed'
  }
  // The latest non-lifecycle record can only be the recap's record if its kind matches
  // the helper's chosen kind and it is nonempty. A newer prompt is a different fact.
  const detailIsRecap = Boolean(detailIsMessage && recap && latest?.content?.trim()
    && latest.kind === (recap.source === 'Last assistant message' ? 'assistant_message' : 'user_message'))
  const retainedRunIds = [...new Set(items.flatMap(item => item.activityState ? [item.activityState.run.runId] : []))]
  return { ...(retainedRunIds.length ? { retainedRunIds } : {}), id: session.id, ...(session.kind === 'agent' && (session.nativeHandle?.sessionId ?? session.nativeSessionId) ? { nativeSessionId: session.nativeHandle?.sessionId ?? session.nativeSessionId } : {}), name, detail, state: state === 'working' && activitySemantic !== 'active' ? 'running' : state, stateLabel, processState: session.processState, runUnobserved: session.runUnobserved === true, bucket, kind: session.kind, providerId: session.providerId,
    ...(session.kind === 'agent' ? { executorId: session.executorId } : {}),
    hostId: session.hostId, topicId, workspace, workspaceId: workspace?.id ?? `${session.hostId}:${session.workspacePath}`, workspaceName: workspace?.name ?? session.workspacePath.split('/').filter(Boolean).at(-1) ?? 'Unassigned', workspacePath: session.workspacePath,
    liveAgent: session.kind === 'agent' && session.processState === 'running', actionable: pending || isNeedsYouState(state) || session.kind === 'agent' && state === 'error', lastActivityAt,
    runId: session.control.run.runId, ...(stateEnteredAt === undefined ? {} : { stateEnteredAt }), workingEnteredAt: activitySemantic === 'unknown' || activitySemantic === 'unsupported' ? null : workingEntryTime(session), recap, detailIsRecap, detailKind,
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
    && (a.kind !== 'terminal' || a.status.exitCode === b.status.exitCode && a.status.exitReason === b.status.exitReason)
    && activityEntryTime(a) === activityEntryTime(b)
    && a.control.run.runId === b.control.run.runId && workingEntryTime(a) === workingEntryTime(b)
    && agentStateEnteredAt(a, now) === agentStateEnteredAt(b, now)
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
  let groupSequence = 0
  const cache = new Map<string, { group: { key: string; enteredAt: number | null; sequence: number } | null; session: SessionSnapshot; activitySemantic: AgentObservation['semantic']; timeline: AgentTimelineSnapshot | undefined; name: string | undefined; config: AppConfig | null; workspace: WorkspaceRecord | undefined; topicId: string | null; lane: AgentFocusLane | null; model: FocusContext | null; laneModel: FocusContext | null }>()
  let previous: Inputs | undefined
  let result: FocusProjection = {contexts: [], laneContexts: [], pmoAttention: []}
  const select = (input: Inputs): FocusProjection => {
    if (previous && previous.sessions === input.sessions && previous.timelines === input.timelines && previous.agentNames === input.agentNames && previous.config === input.config && previous.scratchTopicSnapshots === input.scratchTopicSnapshots) return result
    const rows: FocusContext[] = []
    const laneRows: FocusContext[] = []
    const pmoAttention: string[] = []
    const retained = new Set<string>()
    const now = Date.now()
    for (const session of input.sessions) {
      // Focus scans Agent work; plain Terminals keep their original workbench and history.
      if (session.kind !== 'agent') continue
      retained.add(session.id)
      const activitySemantic = observeAgentSession(session, now).semantic
      const timeline = input.timelines[session.id], name = input.agentNames[session.id], old = cache.get(session.id)
      if (old && old.activitySemantic === activitySemantic && sameSessionPresentation(old.session, session, now) && old.timeline === timeline && old.name === name && old.config === input.config && previous?.scratchTopicSnapshots === input.scratchTopicSnapshots) {
        if (old.model) { rows.push(old.model); laneRows.push(old.laneModel!) }
        else if (old.lane === 'pmo' && focusBucketForSession(session, false) === 'attention') pmoAttention.push(session.id)
        continue
      }
      const sameOwner = old && previous?.scratchTopicSnapshots === input.scratchTopicSnapshots && old.config === input.config && old.session.hostId === session.hostId && old.session.workspacePath === session.workspacePath
      const workspace = sameOwner ? old.workspace : workspaceForSession(input.config, session, scratchTopicsForConfig(input.config, input.scratchTopicSnapshots))
      const topicId = sameOwner ? old.topicId : workspace ? scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath, scratchTopicsForConfig(input.config, input.scratchTopicSnapshots)) : null
      let group: { key: string; enteredAt: number | null; sequence: number } | null = null
      let model: FocusContext | null = null
      let laneModel: FocusContext | null = null
      const lane = focusLaneForSession(topicId, scratchTopicsForWorkspace(input.scratchTopicSnapshots, workspace))
      if (lane === 'pmo') {
        if (focusBucketForSession(session, false) === 'attention') pmoAttention.push(session.id)
      } else {
        const next = agentContextForSession(session, timeline, name, workspace, topicId)
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
        model = old?.model && Object.keys(next).every(key => next[key as keyof FocusContext] === old.model![key as keyof FocusContext]) ? old.model : next
        rows.push(model)
        laneModel = old?.laneModel && sameLaneFacts(old.laneModel, model) ? old.laneModel : model
        laneRows.push(laneModel)
      }
      cache.set(session.id, { group, session, activitySemantic, timeline, name, config: input.config, workspace, topicId, lane, model, laneModel })
    }
    for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id)
    // Only Focus card order changes. Lane facts keep their original input order and priorities.
    rows.sort((a, b) => {
      const first = cache.get(a.id)!.group!, second = cache.get(b.id)!.group!
      return (second.enteredAt ?? -Infinity) - (first.enteredAt ?? -Infinity) || first.sequence - second.sequence
    })
    result = {contexts: sameItems(result.contexts, rows) ? result.contexts : rows, laneContexts: sameItems(result.laneContexts, laneRows) ? result.laneContexts : laneRows, pmoAttention: sameItems(result.pmoAttention, pmoAttention) ? result.pmoAttention : pmoAttention}
    previous = {sessions: input.sessions, timelines: input.timelines, agentNames: input.agentNames, config: input.config, scratchTopicSnapshots: input.scratchTopicSnapshots}
    return result
  }
  return select
}

export function createFocusProjectionSelector() {
  return createFocusProjectionCache()
}
