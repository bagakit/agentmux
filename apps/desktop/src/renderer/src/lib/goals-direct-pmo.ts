import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { AgentFocusContext } from './agent-focus'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from './pmo-teams-topic-floating'
import { useAppStore } from '../store'
import { goalDiscussionTarget } from './goal-discussion-recipient'

type PresentationIntent = {
  surface: string
  selected: string | null
  workspace: string | null
  pmo: AgentFocusContext['pmo']
  floating: ReturnType<typeof readPmoTeamsTopicFloatingState>
}
type DirectGoalRequest = {
  id?: string
  phase: 'save' | 'pmo'
  pending: boolean
  error: string | null
  creationOperationId: string
  notSaved?: boolean
  project?: { id: string; name: string }
}
export const DIRECT_GOAL_TITLE = 'Untitled goal'
let request: DirectGoalRequest | null = null
let flight: Promise<void> | null = null
const listeners = new Set<() => void>()
export const directGoalRequest = (): DirectGoalRequest | null => request
export function subscribeDirectGoalRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(next: DirectGoalRequest | null): void {
  request = next
  listeners.forEach(listener => listener())
}
function presentationIntent(): PresentationIntent {
  const state = useAppStore.getState()
  return { surface: state.mainSurface, selected: state.selectedDemandId, workspace: state.activeWorkspaceId,
    pmo: state.agentFocus.pmo, floating: readPmoTeamsTopicFloatingState() }
}
function mayPresent(intent: PresentationIntent, id: string, tabId?: string): boolean {
  const state = useAppStore.getState(), tab = tabId ? state.tabs[tabId] : undefined
  const surface = tab?.regions[tab.layout.activeRegionId]
  return state.mainSurface === intent.surface && state.activeWorkspaceId === intent.workspace &&
    (state.selectedDemandId === intent.selected || state.selectedDemandId === id) &&
    (state.agentFocus.pmo === intent.pmo || surface?.kind === 'agent' && state.agentFocus.pmo.sessionId === surface.sessionId) &&
    readPmoTeamsTopicFloatingState() === intent.floating
}

async function readSavedGoal(creationOperationId: string): Promise<string> {
  const read = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: mintObjectId(), operation: 'demand.show', creationOperationId })
  if (read.operation !== 'demand.show') throw new Error('The original Goal creation read is unconfirmed.')
  if (!read.demand) throw Object.assign(new Error('The original Goal owner confirms this operation has not saved a Goal.'), { code: 'GOAL_OWNER_NOT_FOUND' })
  return read.demand.id
}

/** Retain one creation operation until the owner returns the Goal ID. */
function runDirectGoal(current: DirectGoalRequest, intent: PresentationIntent, create?: { projectId: string | null; projectName: string | null }): Promise<void> {
  if (flight) return flight
  publish({ ...current, pending: true, error: null })
  flight = Promise.resolve().then(async () => {
    let id = current.id
    try {
      if (current.phase === 'save') {
        if (create !== undefined) {
          try {
            id = await useAppStore.getState().createDemand({ title: DIRECT_GOAL_TITLE, description: '', status: 'backlog',
              projectId: create.projectId, projectName: create.projectName, source: 'default-topic' }, current.creationOperationId)
          } catch {
            // A rejected IPC receipt does not establish that the durable write failed.
            id = await readSavedGoal(current.creationOperationId)
          }
        } else id = await readSavedGoal(current.creationOperationId)
        publish({ ...current, id, phase: 'pmo', pending: true, error: null, notSaved: false })
      }
      if (!id) throw new Error('The original Goal ID has not been read from its owner.')
      if (!mayPresent(intent, id)) {
        publish({ ...(request ?? current), phase: 'pmo', pending: false, error: '你已切换工作面。目标已保存，需要时可继续此目标的专属讨论。' })
        return
      }
      useAppStore.getState().setSelectedDemand(id)
      const tabId = await useAppStore.getState().requestDemandPmoTask(id, 'grill', { creationOperationId: current.creationOperationId })
      if (tabId && mayPresent(intent, id, tabId)) requestPmoTeamsTopicFloatingOpen({ targetTabId: tabId })
      publish(null)
    } catch (cause) {
      publish({ ...(request ?? current), pending: false, error: cause instanceof Error ? cause.message : String(cause),
        ...((request ?? current).phase === 'save' ? { notSaved: (cause as { code?: unknown })?.code === 'GOAL_OWNER_NOT_FOUND' } : {}) })
      if (id && request?.phase === 'pmo') {
        const target = goalDiscussionTarget(useAppStore.getState(), id)
        if (target.kind === 'existing' && mayPresent(intent, id, target.tabId)) requestPmoTeamsTopicFloatingOpen({ targetTabId: target.tabId })
      }
    }
  }).finally(() => { flight = null })
  return flight
}
export function startDirectGoal(project?: { id: string; name: string }): Promise<void> {
  if (flight) return flight
  if (request) return retryDirectGoal()
  return runDirectGoal({ creationOperationId: mintObjectId(), phase: 'save', pending: false, error: null, ...(project ? { project: { id: project.id, name: project.name } } : {}) }, presentationIntent(),
    { projectId: project?.id ?? null, projectName: project?.name ?? null })
}
export function retryDirectGoal(): Promise<void> {
  if (flight) return flight
  return request ? runDirectGoal(request, presentationIntent()) : Promise.resolve()
}
/** A complete owner read proved absence. Save again using the same creation operation. */
export function saveDirectGoal(): Promise<void> {
  if (flight) return flight
  return request?.phase === 'save' && request.notSaved ? runDirectGoal(request, presentationIntent(),
    { projectId: request.project?.id ?? null, projectName: request.project?.name ?? null }) : Promise.resolve()
}
