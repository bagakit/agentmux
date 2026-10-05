import type { AgentMuxControlRequest } from '@agentmux/core/control'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { useAppStore } from '../store'
import type { DemandProjection } from './global-demand-board'
import { agentDisplayName, firstPromptFromTimeline, topicIdForSession, workspaceForSession } from './workbench-tabs'
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
/** Business selection uses canonical Core identities; original presentation IDs remain navigation facts. */
export function goalAgentRows(state: Inputs, goal: DemandProjection, retainedIds: readonly string[] = []): GoalAgentRow[] {
  const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)
  const projects = projectWorkspaces(state.config?.workspaces.filter(workspace => workspace.id !== '__scratch__') ?? [])
  const hasProject = projects.some(project => project.id === goal.projectId)
  const agents = state.sessions.filter((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent' && session.control.kind === 'agent')
  const counts = new Map<string, number>()
  for (const session of agents) counts.set(session.control.agentSessionId, (counts.get(session.control.agentSessionId) ?? 0) + 1)
  const seen = new Set<string>()
  const rows: GoalAgentRow[] = []
  for (const session of agents) {
    const id = session.control.agentSessionId
    if (seen.has(id)) continue
    seen.add(id)
    const workspace = workspaceForSession(state.config, session, topics), topicId = topicIdForSession(state.config, session, topics)
    const projectId = workspace && workspace.id !== '__scratch__' ? workspaceProjectId(workspace) : null
    const project = projects.find(project => project.id === projectId), topic = topics?.find(topic => topic.id === topicId)
    const name = agentDisplayName({ userName: state.agentNames[session.id], firstPrompt: firstPromptFromTimeline(state.timelines[session.id]), fallbackLabel: session.label, providerLabel: session.providerId })
    rows.push({ id, session, name, context: `${topic?.title ?? project?.name ?? 'No registered Project'} · ${session.workspacePath}`,
      status: counts.get(id) === 1 ? sessionStatusLabel(session) : 'Session owner is ambiguous', selectable: counts.get(id) === 1,
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
