import type { AgentFocusContext } from './agent-focus'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from './pmo-teams-topic-floating'
import { useAppStore } from '../store'

type PresentationIntent = {
  surface: string
  selected: string | null
  workspace: string | null
  pmo: AgentFocusContext['pmo']
  floating: ReturnType<typeof readPmoTeamsTopicFloatingState>
}
type DirectGoalRequest = {
  id: string
  phase: 'save' | 'pmo'
  pending: boolean
  error: string | null
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

/** One finite click retains only its caller ID. Goal and PMO facts stay in their original owners. */
function runDirectGoal(current: DirectGoalRequest, intent: PresentationIntent, create?: { projectId: string | null; projectName: string | null }): Promise<void> {
  if (flight) return flight
  publish({ ...current, pending: true, error: null })
  flight = Promise.resolve().then(async () => {
    try {
      if (current.phase === 'save') {
        if (create !== undefined) {
          try {
            await useAppStore.getState().createDemand({ id: current.id, title: DIRECT_GOAL_TITLE, description: '', status: 'backlog',
              projectId: create.projectId, projectName: create.projectName, source: 'default-topic' })
          } catch {
            // A rejected IPC receipt does not establish that the durable write failed.
            await useAppStore.getState().refreshDemand(current.id)
          }
        } else await useAppStore.getState().refreshDemand(current.id)
        publish({ ...current, phase: 'pmo', pending: true, error: null, notSaved: false })
      }
      if (!mayPresent(intent, current.id)) {
        publish({ id: current.id, phase: 'pmo', pending: false, error: '你已切换工作面。目标已保存，需要时可继续此目标的专属讨论。' })
        return
      }
      useAppStore.getState().setSelectedDemand(current.id)
      const tabId = await useAppStore.getState().requestDemandPmoTask(current.id, 'grill')
      if (mayPresent(intent, current.id, tabId)) requestPmoTeamsTopicFloatingOpen({ targetTabId: tabId })
      publish(null)
    } catch (cause) {
      publish({ ...(request ?? current), pending: false, error: cause instanceof Error ? cause.message : String(cause),
        ...((request ?? current).phase === 'save' ? { notSaved: (cause as { code?: unknown })?.code === 'GOAL_OWNER_NOT_FOUND' } : {}) })
      const tabId = useAppStore.getState().demandPmoTabIds[current.id]
      if (request?.phase === 'pmo' && tabId && mayPresent(intent, current.id, tabId)) requestPmoTeamsTopicFloatingOpen({ targetTabId: tabId })
    }
  }).finally(() => { flight = null })
  return flight
}
export function startDirectGoal(project?: { id: string; name: string }): Promise<void> {
  if (flight) return flight
  if (request) return retryDirectGoal()
  return runDirectGoal({ id: `demand_${crypto.randomUUID()}`, phase: 'save', pending: false, error: null, ...(project ? { project: { id: project.id, name: project.name } } : {}) }, presentationIntent(),
    { projectId: project?.id ?? null, projectName: project?.name ?? null })
}
export function retryDirectGoal(): Promise<void> {
  if (flight) return flight
  return request ? runDirectGoal(request, presentationIntent()) : Promise.resolve()
}
/** A complete owner read proved absence. Only this explicit action saves again, using the same ID. */
export function saveDirectGoal(): Promise<void> {
  if (flight) return flight
  return request?.phase === 'save' && request.notSaved ? runDirectGoal(request, presentationIntent(),
    { projectId: request.project?.id ?? null, projectName: request.project?.name ?? null }) : Promise.resolve()
}
