import { parseGoalRelationAccesses, type GoalRelationAccess } from '@agentmux/core/goal-agent-reference'
import { parseDemandAgentReference, demandAgentReferenceKey, goalSupervisorHostWitnesses, mergeDemandAgentReferences, type DemandAgentReference } from '@agentmux/demand/relations'
import type { AgentMuxControlRequest } from '@agentmux/core/control'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { useAppStore } from '../store'
import type { DemandRecord } from './global-demand-board'
import { agentDisplayName, topicIdForSession, workspaceForSession } from './workbench-tabs'
import { compactReferenceId, firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import { projectWorkspaces, workspaceProjectId } from './workspace-projects'
import { scratchTopicsForConfig, scratchTopicKind } from './scratch-topic-snapshots'
import { sessionStatusLabel } from './session-presentation'

export type GoalAgentRole = 'assignees' | 'related' | 'supervisor'
export function goalSupervisorPresentationHosts(goal: DemandRecord): readonly string[] {
  const witnesses = goalSupervisorHostWitnesses(goal)
  const observed = goal.responsibility?.supervisor
  return observed?.hostId && observed.agentSessionId === goal.supervisorSessionId && !witnesses.includes(observed.hostId)
    ? [...witnesses, observed.hostId] : witnesses
}
export type GoalAgentCreationDraft = {
  goalId: string
  role: 'assignees' | 'related'
  operationId: string
  phase: 'not-dispatched' | 'may-have-dispatched'
  request: Extract<AgentMuxControlRequest, { operation: 'agent.open' }>
}
export type GoalAgentSelectionDraft = { goalId: string; role: GoalAgentRole; selected: DemandAgentReference[]; expectedUpdatedAt: number; replacement?: DemandAgentReference; relationAccess?: GoalRelationAccess[] }
export const goalCreationDraftKey = (goalId: string, role: GoalAgentRole): string => JSON.stringify([goalId, role])
export function restoredGoalAgentCreationDrafts(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value as Record<string, unknown> }
}
/** Legacy Mote and already submitted spatial requests keep their original owner. */
export function readGoalAgentCreationDraft(entry: unknown, goalId: string, role: GoalAgentRole): GoalAgentCreationDraft | undefined {
    try {
      const draft = entry as GoalAgentCreationDraft, request = draft.request
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['goalId', 'role', 'operationId', 'phase', 'request'].includes(key)) ||
        draft.goalId !== goalId || draft.role !== role || !['assignees', 'related'].includes(draft.role) || request?.operation !== 'agent.open' ||
        request.schemaVersion !== AGENTMUX_CONTROL_SCHEMA_VERSION || request.content?.kind !== 'new-agent' ||
        typeof request.content.executorId !== 'string' || !request.content.executorId || !request.destination ||
        request.content.prompt !== undefined || request.focus !== false || typeof draft.operationId !== 'string' || !draft.operationId ||
        request.requestId !== draft.operationId || !['not-dispatched', 'may-have-dispatched'].includes(draft.phase)) return
      return draft
    } catch { return } // The leaf retains unreadable input; it is never dispatched here.
}
/** The private leaf keeps unrecognized entries verbatim. A typed reader never owns their bytes. */
export function restoredGoalAgentSelectionDrafts(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value as Record<string, unknown> }
}
export function readGoalAgentSelectionDraft(value: unknown, goalId: string, role: GoalAgentRole): GoalAgentSelectionDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const draft = value as Record<string, unknown>
  if (Object.keys(draft).some(key => !['goalId', 'role', 'selected', 'expectedUpdatedAt', 'replacement', 'relationAccess'].includes(key)) ||
      draft.goalId !== goalId || draft.role !== role || !Array.isArray(draft.selected) || typeof draft.expectedUpdatedAt !== 'number' || !Number.isFinite(draft.expectedUpdatedAt)) return
  try { return { goalId, role, selected: mergeDemandAgentReferences(draft.selected.map(parseDemandAgentReference)), expectedUpdatedAt: draft.expectedUpdatedAt,
    ...(draft.replacement === undefined ? {} : { replacement: draft.replacement === '' ? '' : parseDemandAgentReference(draft.replacement) }),
    ...(draft.relationAccess === undefined ? {} : { relationAccess: parseGoalRelationAccesses(draft.relationAccess) }) } }
  catch { return } // Keep the original opaque entry; this reader cannot edit or dispatch it.
}
type Inputs = Pick<ReturnType<typeof useAppStore.getState>, 'sessions' | 'config' | 'agentNames' | 'timelines' | 'scratchTopicSnapshots'>
export type GoalAgentRow = {
  id: string; reference: DemandAgentReference; name: string; context: string; status: string; selectable: boolean
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
export function goalAgentRows(state: Inputs, goal: DemandRecord, retainedIds: readonly DemandAgentReference[] = []): GoalAgentRow[] {
  const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)
  const projects = projectWorkspaces(state.config?.workspaces.filter(workspace => workspace.id !== '__scratch__') ?? [])
  const hasProject = projects.some(project => project.id === goal.projectId)
  const agents = state.sessions.filter((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent' && session.control.kind === 'agent')
  const grouped = new Map<string, typeof agents>()
  for (const session of agents) { const id = session.control.agentSessionId; grouped.set(id, [...grouped.get(id) ?? [], session]) }
  const seen = new Set<string>()
  const rows: GoalAgentRow[] = []
  for (const [id, candidates] of grouped) {
    const viewKey = demandAgentReferenceKey(id)
    seen.add(viewKey)
    const session = goalAgentPresentation(candidates, id)
    if (!session) {
      rows.push({ id: viewKey, reference: id, name: id, context: `Original reference · Hosts ${[...new Set(candidates.map(source => source.control.hostId))].join(', ')}`,
        status: 'Session owner or Run is ambiguous · reference retained', selectable: false, related: goal.sessionIds.includes(id),
        participated: Boolean(goal.participations?.some(source => source.agentSessionId === id)), project: false, mote: false })
      continue
    }
    const workspace = workspaceForSession(state.config, session, topics), topicId = topicIdForSession(state.config, session, topics)
    const projectId = workspace && workspace.id !== '__scratch__' ? workspaceProjectId(workspace) : null
    const project = projects.find(project => project.id === projectId), topic = topics?.find(topic => topic.id === topicId)
    const name = agentDisplayName({ userName: state.agentNames[session.id], firstPrompt: firstPromptFromTimeline(state.timelines[session.id]), fallbackLabel: session.label, providerLabel: session.providerId })
    rows.push({ id: viewKey, reference: id, session, name, context: `${topic?.title ?? project?.name ?? 'No registered Project'} · ${session.workspacePath}`,
      status: sessionStatusLabel(session), selectable: true,
      related: goal.sessionIds.includes(id) || goal.sessionIds.includes(session.id), participated: Boolean(goal.participations?.some(source => source.agentSessionId === id)), project: hasProject && projectId === goal.projectId,
      mote: Boolean(topic && scratchTopicKind(topic.id, topics) === 'mote') })
  }
  const rank = (row: GoalAgentRow): number => (row.related || row.participated) && row.selectable ? 0 : hasProject && row.project && row.selectable ? 1 : !hasProject && row.mote && row.selectable ? 1 : row.selectable ? 2 : 3
  rows.sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  for (const reference of retainedIds) {
    if (typeof reference !== 'string') {
      const id = demandAgentReferenceKey(reference)
      if (!seen.has(id)) { seen.add(id); rows.push({ id, reference, name: compactReferenceId(reference.execution.agentSessionId),
        context: `Runtime ${compactReferenceId(reference.execution.runtimeId)} · Space ${compactReferenceId(reference.source.spaceId)}`,
        status: 'Saved Source member · current execution not observed', selectable: true, related: goal.sessionIds.some(ref => demandAgentReferenceKey(ref) === id), participated: false, project: false, mote: false }) }
      continue
    }
    const id = reference, viewKey = demandAgentReferenceKey(reference)
    if (!seen.has(viewKey)) {
    seen.add(viewKey)
    const original = agents.find(session => session.id === id)
    rows.push({ id: viewKey, reference: id, name: original ? agentDisplayName({ userName: state.agentNames[original.id], firstPrompt: firstPromptFromTimeline(state.timelines[original.id]), fallbackLabel: original.label, providerLabel: original.providerId }) : id, context: id, status: original ? 'Retained presentation reference' : 'Identity unavailable · reference retained', selectable: false, related: goal.sessionIds.includes(id), participated: Boolean(goal.participations?.some(source => source.agentSessionId === id)), project: false, mote: false })
  }
  }
  return rows
}

export const goalAgentRowReference = (row: GoalAgentRow): DemandAgentReference => row.reference
export const goalAgentSelectionKey = demandAgentReferenceKey

/** Dirty relationship inputs only; the original Goal owner still qualifies each addition. */
export function addedGoalSourceReferences(goal: DemandRecord, patch: Partial<Pick<DemandRecord, 'sessionIds' | 'assigneeSessionIds' | 'supervisorSessionId'>>) {
  const added: DemandAgentReference[] = []
  const refs = (value: DemandRecord['supervisorSessionId'] | DemandRecord['sessionIds'] | undefined): DemandAgentReference[] => value == null ? [] : Array.isArray(value) ? value : [value]
  for (const field of ['sessionIds', 'assigneeSessionIds', 'supervisorSessionId'] as const) {
    if (!Object.hasOwn(patch, field)) continue
    const original = new Set(refs(goal[field]).map(demandAgentReferenceKey))
    added.push(...refs(patch[field]).filter(ref => typeof ref !== 'string' && !original.has(demandAgentReferenceKey(ref))))
  }
  return mergeDemandAgentReferences(added).filter((ref): ref is Exclude<DemandAgentReference, string> => typeof ref !== 'string')
}
