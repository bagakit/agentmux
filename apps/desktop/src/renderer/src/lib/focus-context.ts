import type { AgentTimelineSnapshot } from '@agentmux/core'
import { isAgentActivityStatusSource } from '@agentmux/core/agent-status'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { scratchTopicIdFromWorkspacePath } from '../../../shared/scratch-topics'
import { focusLaneForSession, type AgentFocusLane } from './agent-focus'
import { scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { agentDisplayName, firstPromptFromTimeline, workspaceForSession } from './workbench-tabs'
import { isNeedsYouState } from './attention-vocabulary'
import { turnWorking } from './activity-working-state'
import { clampStep } from './activity-step-summary'
import { sessionRecentActivity } from './session-recency'
import { sessionStatusLabel } from './session-presentation'

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
type Inputs = { sessions: readonly SessionSnapshot[]; timelines: Record<string, AgentTimelineSnapshot>; agentNames: Record<string, string>; config: AppConfig | null; scratchTopicSnapshots: Record<string, ScratchTopicsSnapshot> }
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
  const stateLabel = sessionStatusLabel(session)
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
  const cache = new Map<string, { session: SessionSnapshot; timeline: AgentTimelineSnapshot | undefined; name: string | undefined; config: AppConfig | null; workspace: WorkspaceRecord | undefined; topicId: string | null; lane: AgentFocusLane | null; model: FocusContext | null; laneModel: FocusContext | null }>()
  let previous: Inputs | undefined
  let result: FocusProjection = {contexts: [], laneContexts: [], pmoAttention: []}
  const select = (input: Inputs): FocusProjection => {
    if (previous && previous.sessions === input.sessions && previous.timelines === input.timelines && previous.agentNames === input.agentNames && previous.config === input.config && previous.scratchTopicSnapshots === input.scratchTopicSnapshots) return result
    const rows: FocusContext[] = []
    const laneRows: FocusContext[] = []
    const pmoAttention: string[] = []
    const retained = new Set<string>()
    for (const session of input.sessions) {
      // Focus scans Agent work; plain Terminals keep their original workbench and history.
      if (session.kind !== 'agent') continue
      retained.add(session.id)
      const timeline = input.timelines[session.id], name = input.agentNames[session.id], old = cache.get(session.id)
      if (old && sameSessionPresentation(old.session, session) && old.timeline === timeline && old.name === name && old.config === input.config && previous?.scratchTopicSnapshots === input.scratchTopicSnapshots) {
        if (old.model) { rows.push(old.model); laneRows.push(old.laneModel!) }
        else if (old.lane === 'pmo' && focusBucketForSession(session, false) === 'attention') pmoAttention.push(session.id)
        continue
      }
      const sameOwner = old && old.config === input.config && old.session.hostId === session.hostId && old.session.workspacePath === session.workspacePath
      const workspace = sameOwner ? old.workspace : workspaceForSession(input.config, session)
      const topicId = sameOwner ? old.topicId : workspace ? scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath) : null
      let model: FocusContext | null = null
      let laneModel: FocusContext | null = null
      const lane = focusLaneForSession(topicId, scratchTopicsForWorkspace(input.scratchTopicSnapshots, workspace))
      if (lane === 'pmo') {
        if (focusBucketForSession(session, false) === 'attention') pmoAttention.push(session.id)
      } else {
        const next = context(session, timeline, name, workspace, topicId)
        if (lane === null) next.detail = 'Mote identity is not confirmed · ' + next.detail
        model = old?.model && Object.keys(next).every(key => next[key as keyof FocusContext] === old.model![key as keyof FocusContext]) ? old.model : next
        rows.push(model)
        laneModel = old?.laneModel && sameLaneFacts(old.laneModel, model) ? old.laneModel : model
        laneRows.push(laneModel)
      }
      cache.set(session.id, { session, timeline, name, config: input.config, workspace, topicId, lane, model, laneModel })
    }
    for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id)
    result = {contexts: sameItems(result.contexts, rows) ? result.contexts : rows, laneContexts: sameItems(result.laneContexts, laneRows) ? result.laneContexts : laneRows, pmoAttention: sameItems(result.pmoAttention, pmoAttention) ? result.pmoAttention : pmoAttention}
    previous = {sessions: input.sessions, timelines: input.timelines, agentNames: input.agentNames, config: input.config, scratchTopicSnapshots: input.scratchTopicSnapshots}
    return result
  }
  return select
}

export function createFocusProjectionSelector() {
  return createFocusProjectionCache()
}

