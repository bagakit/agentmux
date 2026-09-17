import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID } from '../../../shared/scratch-topics'
import { agentDisplayName, firstPromptFromTimeline, topicIdForSession, workspaceForSession } from './workbench-tabs'
import { isNeedsYouState } from './attention-vocabulary'
import { turnWorking } from './activity-working-state'
import { clampStep, stepSummary } from './activity-step-summary'

export type FocusBucket = 'attention' | 'working' | 'results' | 'idle'
export type FocusContext = {
  id: string; name: string; detail: string; state: SessionSnapshot['status']['state']; stateLabel: string
  bucket: FocusBucket; kind: SessionSnapshot['kind']; providerId: string | null
  workspaceId: string; workspaceName: string; workspacePath: string; liveAgent: boolean; actionable: boolean
}
type Inputs = { sessions: readonly SessionSnapshot[]; timelines: Record<string, AgentTimelineSnapshot>; agentNames: Record<string, string>; config: AppConfig | null }
export function focusBucketForSession(session: SessionSnapshot, hasCurrentResult: boolean): FocusBucket {
  const state = session.status.state
  if ((session.kind === 'agent' && session.pendingInteraction) || isNeedsYouState(state) || state === 'error') return 'attention'
  if (turnWorking(state)) return 'working'
  if (hasCurrentResult && (state === 'done' || state === 'running')) return 'results'
  return 'idle'
}
function context(session: SessionSnapshot, timeline: AgentTimelineSnapshot | undefined, userName: string | undefined, config: AppConfig | null): FocusContext {
  const state = session.status.state, items = timeline?.items ?? []
  const latest = [...items].reverse().find(item => item.kind !== 'lifecycle')
  const result = latest?.kind === 'assistant_message' && latest.status === 'complete' && latest.content?.trim() ? latest : null
  const pending = session.kind === 'agent' && Boolean(session.pendingInteraction)
  const bucket = focusBucketForSession(session, Boolean(result))
  const stateLabel = state === 'error' ? 'Failed' : pending ? 'Request pending' : isNeedsYouState(state) ? (state === 'blocked' ? 'Blocked' : 'Needs reply')
    : state === 'done' ? 'Idle' : state === 'running' ? (session.kind === 'agent' ? 'Status unknown' : 'Shell open')
    : state === 'disconnected' ? 'Disconnected' : state === 'exited' ? 'Stopped' : state === 'starting' ? 'Starting' : 'Working'
  const name = session.kind === 'agent' ? agentDisplayName({ userName, firstPrompt: firstPromptFromTimeline(timeline), fallbackLabel: session.label, providerLabel: session.providerId }) : userName ?? session.label
  const workspace = workspaceForSession(config, session)
  let detail = 'No activity details observed'
  if (bucket === 'results' && result) detail = clampStep(result.content!.replace(/\s+/g, ' ').trim(), 'head', 140)
  else if (pending) detail = session.pendingInteraction!.kind === 'permission' ? 'Review permission request' : 'Review request in context'
  else if (latest?.kind === 'tool_call') detail = stepSummary(latest.toolName, latest.toolInput, 140, session.workspacePath) ?? latest.title
  else if (latest?.content) detail = clampStep(latest.content.replace(/\s+/g, ' ').trim(), 'head', 140)
  else if (latest) detail = latest.title
  else if (state === 'running') detail = session.kind === 'agent' ? 'Run is alive · No current work signal' : 'Terminal context · No task signal'
  else if (state === 'done') detail = 'Ready for another prompt · No result observed'
  return { id: session.id, name, detail, state, stateLabel, bucket, kind: session.kind, providerId: session.providerId,
    workspaceId: workspace?.id ?? `${session.hostId}:${session.workspacePath}`, workspaceName: workspace?.name ?? session.workspacePath.split('/').filter(Boolean).at(-1) ?? 'Unassigned', workspacePath: session.workspacePath,
    liveAgent: session.kind === 'agent' && session.processState === 'running', actionable: pending || isNeedsYouState(state) }
}
function sameSessionPresentation(a: SessionSnapshot, b: SessionSnapshot): boolean {
  return a.kind === b.kind && a.label === b.label && a.providerId === b.providerId && a.hostId === b.hostId
    && a.workspacePath === b.workspacePath && a.processState === b.processState && a.status.state === b.status.state
    && (a.kind === 'agent' ? a.pendingInteraction : undefined) === (b.kind === 'agent' ? b.pendingInteraction : undefined)
}
/** Cache only held presentation facts. A change to one Session never re-derives its neighbours. */
export function createFocusContextSelector() {
  const cache = new Map<string, { session: SessionSnapshot; timeline: AgentTimelineSnapshot | undefined; name: string | undefined; config: AppConfig | null; model: FocusContext }>()
  return (input: Inputs): FocusContext[] => {
    const rows: FocusContext[] = []
    for (const session of input.sessions) {
      if (topicIdForSession(input.config, session) === PMO_TEAMS_TOPIC_ID) continue
      const timeline = input.timelines[session.id], name = input.agentNames[session.id], old = cache.get(session.id)
      if (old && sameSessionPresentation(old.session, session) && old.timeline === timeline && old.name === name && old.config === input.config) { rows.push(old.model); continue }
      const next = context(session, timeline, name, input.config)
      const model = old && Object.keys(next).every(key => next[key as keyof FocusContext] === old.model[key as keyof FocusContext]) ? old.model : next
      cache.set(session.id, { session, timeline, name, config: input.config, model }); rows.push(model)
    }
    const retained = new Set(input.sessions.map(session => session.id))
    for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id)
    return rows
  }
}
