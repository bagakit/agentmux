import type { AgentMuxControlRequest } from '@agentmux/core/control'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { useAppStore } from '../store'
import type { DemandRecord } from './global-demand-board'
import { agentDisplayName, topicIdForSession, workspaceForSession } from './workbench-tabs'
import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import { projectWorkspaces, workspaceProjectId } from './workspace-projects'
import { scratchTopicsForConfig, scratchTopicKind } from './scratch-topic-snapshots'
import { sessionStatusLabel } from './session-presentation'

export type GoalAgentRole = 'assignees' | 'related' | 'supervisor'
export type GoalAgentCreationDraft = {
  goalId: string
  role: 'assignees' | 'related'
  operationId: string
  phase: 'not-dispatched' | 'may-have-dispatched'
  request: Extract<AgentMuxControlRequest, { operation: 'agent.open' }>
}
export type GoalAgentSelectionDraft = { goalId: string; role: GoalAgentRole; selected: string[]; expectedUpdatedAt: number; replacement?: string }
export const goalCreationDraftKey = (goalId: string, role: GoalAgentRole): string => JSON.stringify([goalId, role])
export function restoredGoalAgentCreationDrafts(value: unknown): Record<string, GoalAgentCreationDraft> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const retained: Record<string, GoalAgentCreationDraft> = {}
  for (const [key, entry] of Object.entries(value)) {
    try {
      const draft = entry as GoalAgentCreationDraft, request = draft.request
      if (typeof draft.goalId !== 'string' || !draft.goalId || !['assignees', 'related'].includes(draft.role) ||
        key !== goalCreationDraftKey(draft.goalId, draft.role) || request?.operation !== 'agent.open' ||
        request.schemaVersion !== AGENTMUX_CONTROL_SCHEMA_VERSION || request.content?.kind !== 'new-agent' ||
        typeof request.content.executorId !== 'string' || !request.content.executorId || !request.destination ||
        request.content.prompt !== undefined || request.focus !== false || typeof draft.operationId !== 'string' || !draft.operationId ||
        request.requestId !== draft.operationId) continue
      retained[key] = { goalId: draft.goalId, role: draft.role, operationId: draft.operationId, phase: draft.phase === 'not-dispatched' ? 'not-dispatched' : 'may-have-dispatched', request }
    } catch { /* Invalid UI intent is never dispatched; original spatial bindings remain intact. */ }
  }
  return retained
}
export function restoredGoalAgentSelectionDrafts(value: unknown): Record<string, GoalAgentSelectionDraft> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const retained: Record<string, GoalAgentSelectionDraft> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object') continue
    const draft = entry as GoalAgentSelectionDraft
    if (typeof draft.goalId !== 'string' || !draft.goalId || !['assignees', 'related', 'supervisor'].includes(draft.role) ||
      key !== goalCreationDraftKey(draft.goalId, draft.role) || !Array.isArray(draft.selected) ||
      !draft.selected.every(id => typeof id === 'string' && id.length > 0) || !Number.isFinite(draft.expectedUpdatedAt) ||
      draft.replacement !== undefined && typeof draft.replacement !== 'string') continue
    retained[key] = { goalId: draft.goalId, role: draft.role, selected: [...new Set(draft.selected)], expectedUpdatedAt: draft.expectedUpdatedAt,
      ...(draft.replacement !== undefined ? { replacement: draft.replacement } : {}) }
  }
  return retained
}
type Inputs = Pick<ReturnType<typeof useAppStore.getState>, 'sessions' | 'config' | 'agentNames' | 'timelines' | 'scratchTopicSnapshots'>
export type GoalAgentRow = {
  id: string; name: string; context: string; status: string; selectable: boolean
  participated: boolean; session?: Extract<SessionSnapshot, { kind: 'agent' }>; related: boolean; project: boolean; mote: boolean
}
/** Several original presentations can describe the same Actor and Run. Choose a
 * stable existing presentation only after that exact identity is established. */
export function goalAgentPresentation(candidates: readonly Extract<SessionSnapshot, { kind: 'agent' }>[], referenceId?: string) {
  const source = candidates[0]
  if (!source || candidates.some(session => session.hostId !== session.control.hostId ||
    session.control.hostId !== source.control.hostId || session.control.agentSessionId !== source.control.agentSessionId ||
    session.control.run.runId !== source.control.run.runId)) return undefined
  return candidates.find(session => session.id === referenceId) ?? candidates.find(session => session.id === source.control.agentSessionId)
    ?? [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0]
}
/** Business selection uses canonical Core identities; original presentation IDs remain navigation facts. */
export function goalAgentRows(state: Inputs, goal: DemandRecord, retainedIds: readonly string[] = []): GoalAgentRow[] {
  const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)
  const projects = projectWorkspaces(state.config?.workspaces.filter(workspace => workspace.id !== '__scratch__') ?? [])
  const hasProject = projects.some(project => project.id === goal.projectId)
  const agents = state.sessions.filter((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent' && session.control.kind === 'agent')
  const grouped = new Map<string, typeof agents>()
  for (const session of agents) { const id = session.control.agentSessionId; grouped.set(id, [...grouped.get(id) ?? [], session]) }
  const seen = new Set<string>()
  const rows: GoalAgentRow[] = []
  for (const [id, candidates] of grouped) {
    seen.add(id)
    const session = goalAgentPresentation(candidates, id)
    if (!session) {
      rows.push({ id, name: id, context: `Original reference · Hosts ${[...new Set(candidates.map(source => source.control.hostId))].join(', ')}`,
        status: 'Session owner or Run is ambiguous · reference retained', selectable: false, related: goal.sessionIds.includes(id),
        participated: Boolean(goal.participations?.some(source => source.agentSessionId === id)), project: false, mote: false })
      continue
    }
    const workspace = workspaceForSession(state.config, session, topics), topicId = topicIdForSession(state.config, session, topics)
    const projectId = workspace && workspace.id !== '__scratch__' ? workspaceProjectId(workspace) : null
    const project = projects.find(project => project.id === projectId), topic = topics?.find(topic => topic.id === topicId)
    const name = agentDisplayName({ userName: state.agentNames[session.id], firstPrompt: firstPromptFromTimeline(state.timelines[session.id]), fallbackLabel: session.label, providerLabel: session.providerId })
    rows.push({ id, session, name, context: `${topic?.title ?? project?.name ?? 'No registered Project'} · ${session.workspacePath}`,
      status: sessionStatusLabel(session), selectable: true,
      related: goal.sessionIds.includes(id) || goal.sessionIds.includes(session.id), participated: Boolean(goal.participations?.some(source => source.agentSessionId === id)), project: hasProject && projectId === goal.projectId,
      mote: Boolean(topic && scratchTopicKind(topic.id, topics) === 'mote') })
  }
  const rank = (row: GoalAgentRow): number => (row.related || row.participated) && row.selectable ? 0 : hasProject && row.project && row.selectable ? 1 : !hasProject && row.mote && row.selectable ? 1 : row.selectable ? 2 : 3
  rows.sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  for (const id of retainedIds) if (!seen.has(id)) {
    seen.add(id)
    const original = agents.find(session => session.id === id)
    rows.push({ id, name: original ? agentDisplayName({ userName: state.agentNames[original.id], firstPrompt: firstPromptFromTimeline(state.timelines[original.id]), fallbackLabel: original.label, providerLabel: original.providerId }) : id, context: id, status: original ? 'Retained presentation reference' : 'Identity unavailable · reference retained', selectable: false, related: goal.sessionIds.includes(id), participated: Boolean(goal.participations?.some(source => source.agentSessionId === id)), project: false, mote: false })
  }
  return rows
}
