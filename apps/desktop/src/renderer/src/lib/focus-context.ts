import type { AgentTimelineSnapshot } from '@agentmux/core'
import { isAgentActivityStatusSource } from '@agentmux/core/agent-status'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, scratchTopicIdFromWorkspacePath } from '../../../shared/scratch-topics'
import { agentDisplayName, firstPromptFromTimeline, workspaceForSession } from './workbench-tabs'
import { isNeedsYouState } from './attention-vocabulary'
import { turnWorking } from './activity-working-state'
import { clampStep, stepSummary } from './activity-step-summary'

export type FocusBucket = 'attention' | 'working' | 'results' | 'idle'
export type FocusContext = {
  id: string; name: string; detail: string; state: SessionSnapshot['status']['state']; stateLabel: string
  bucket: FocusBucket; kind: SessionSnapshot['kind']; providerId: string | null
  hostId: string; topicId: string | null; workspaceId: string; workspaceName: string; workspacePath: string; liveAgent: boolean; actionable: boolean
  lastActivityAt: number | null
  workspace: WorkspaceRecord | undefined
}
type Inputs = { sessions: readonly SessionSnapshot[]; timelines: Record<string, AgentTimelineSnapshot>; agentNames: Record<string, string>; config: AppConfig | null }
function activityEntryTime(session: SessionSnapshot): number | undefined {
  const activity = session.kind === 'agent' ? session.semanticStatus : undefined
  return activity && isAgentActivityStatusSource(activity.source) ? activity.stateEnteredAt : undefined
}
export function focusBucketForSession(session: SessionSnapshot, hasCurrentResult: boolean): FocusBucket {
  const state = session.status.state
  if ((session.kind === 'agent' && session.pendingInteraction) || isNeedsYouState(state) || state === 'error') return 'attention'
  if (turnWorking(state)) return 'working'
  if (hasCurrentResult && (state === 'done' || state === 'running')) return 'results'
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
    : state === 'disconnected' ? 'Disconnected' : state === 'exited' ? 'Stopped' : state === 'starting' ? 'Starting' : 'Working'
  const name = session.kind === 'agent' ? agentDisplayName({ userName, firstPrompt: firstPromptFromTimeline(timeline), fallbackLabel: session.label, providerLabel: session.providerId }) : userName ?? session.label
  const activityTimes = items.filter(item => item.kind !== 'lifecycle').map(item => item.updatedAt)
  const enteredAt = activityEntryTime(session)
  if (enteredAt !== undefined) activityTimes.push(enteredAt)
  const lastActivityAt = activityTimes.reduce<number | null>((last, time) => Number.isFinite(time) && time > 0 ? Math.max(last ?? 0, time) : last, null)
  let detail = 'No activity details observed'
  if (bucket === 'results' && result) detail = clampStep(result.content!.replace(/\s+/g, ' ').trim(), 'head', 140)
  else if (pending) detail = session.pendingInteraction!.kind === 'permission' ? 'Review permission request' : 'Review request in context'
  else if (latest?.kind === 'tool_call') detail = stepSummary(latest.toolName, latest.toolInput, 140, session.workspacePath) ?? latest.title
  else if (latest?.content) detail = clampStep(latest.content.replace(/\s+/g, ' ').trim(), 'head', 140)
  else if (latest) detail = latest.title
  else if (state === 'running') detail = session.kind === 'agent' ? 'Run is alive · No current work signal' : 'Terminal context · No task signal'
  else if (state === 'done') detail = 'Ready for another prompt · No result observed'
  return { id: session.id, name, detail, state, stateLabel, bucket, kind: session.kind, providerId: session.providerId,
    hostId: session.hostId, topicId, workspace, workspaceId: workspace?.id ?? `${session.hostId}:${session.workspacePath}`, workspaceName: workspace?.name ?? session.workspacePath.split('/').filter(Boolean).at(-1) ?? 'Unassigned', workspacePath: session.workspacePath,
    liveAgent: session.kind === 'agent' && session.processState === 'running', actionable: pending || isNeedsYouState(state), lastActivityAt }
}
function sameSessionPresentation(a: SessionSnapshot, b: SessionSnapshot): boolean {
  return a.kind === b.kind && a.label === b.label && a.providerId === b.providerId && a.hostId === b.hostId
    && a.workspacePath === b.workspacePath && a.processState === b.processState && a.status.state === b.status.state
    && activityEntryTime(a) === activityEntryTime(b)
    && (a.kind === 'agent' ? a.pendingInteraction : undefined) === (b.kind === 'agent' ? b.pendingInteraction : undefined)
}
export type FocusProjection = { contexts: FocusContext[]; laneContexts: FocusContext[]; pmoAttention: string[] }
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean { return a.length === b.length && a.every((item, index) => item === b[index]) }
function sameLaneFacts(a: FocusContext, b: FocusContext): boolean {
  return a.workspace === b.workspace && a.hostId === b.hostId && a.workspacePath === b.workspacePath && a.topicId === b.topicId
    && a.workspaceId === b.workspaceId && a.workspaceName === b.workspaceName && a.liveAgent === b.liveAgent && a.bucket === b.bucket && a.lastActivityAt === b.lastActivityAt
}
/** One existing per-surface cache owns execution rows and the separate PMO attention projection. */
export function createFocusProjectionSelector() {
  const cache = new Map<string, { session: SessionSnapshot; timeline: AgentTimelineSnapshot | undefined; name: string | undefined; config: AppConfig | null; workspace: WorkspaceRecord | undefined; topicId: string | null; model: FocusContext | null; laneModel: FocusContext | null }>()
  let previous: Inputs | undefined
  let result: FocusProjection = {contexts: [], laneContexts: [], pmoAttention: []}
  return (input: Inputs): FocusProjection => {
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
}
