import { projectHostGoal, publicGoalRecord } from '@agentmux/host/goal-projection'
import type { AgentMuxRpcGoal, ContinuousProgressLoop } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { SessionHistoryDescriptor } from '../../../src/shared/contracts'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import type { DemandRecord } from '../../../src/renderer/src/lib/global-demand-board'

/** Supplementary synthetic scenes, never installed in the real-source replay. */
export function goalRealWorkSynthetic(render: () => void) {
  let loops: ContinuousProgressLoop[] = []
  const record = (goal: DemandRecord) => publicGoalRecord({ ...goal, executorId: null,
    assigneeSessionIds: goal.assigneeSessionIds ?? [], supervisorSessionId: goal.supervisorSessionId ?? null,
    participations: goal.participations ?? [], tags: goal.tags ?? [], activities: goal.activities ?? [], decisions: goal.decisions ?? [],
    plannedStartAt: goal.plannedStartAt ?? null, targetAt: goal.targetAt ?? null,
    parentGoalId: goal.parentDemandId ?? null, phaseIndex: goal.phaseIndex ?? null } as AgentMuxRpcGoal)
  return {
    observe(nextLoops: ContinuousProgressLoop[] = []) {
      loops = nextLoops
      api.goals.execute = async request => {
        const state = useAppStore.getState()
        if (request.operation === 'demand.list') return { operation: request.operation, demands: Object.values(state.demands).map(goal => projectHostGoal(record(goal))) }
        if (request.operation === 'demand.show') {
          const goal = state.demands[request.demandId]
          if (!goal) throw new Error('No synthetic Goal record for that exact read.')
          return { operation: request.operation, demand: projectHostGoal(record(goal)), goalContinuations: structuredClone(loops) }
        }
        throw new Error('Private synthetic save receipt is unavailable. The original draft and operation are kept.')
      }
    },
    /** Explicit private product-fixture input; original user Goal replay uses its separate source port. */
    restoreProductSnapshot(input: Pick<ReturnType<typeof useAppStore.getState>, 'config' | 'sessions' | 'tabs' | 'layouts'> & { goal: DemandRecord }) {
      const current = useAppStore.getState()
      useAppStore.setState({ config: { ...current.config!, ...input.config, appearance: { ...current.config!.appearance, ...input.config?.appearance } },
        sessions: structuredClone(input.sessions), tabs: structuredClone(input.tabs), layouts: structuredClone(input.layouts),
        demands: { [input.goal.id]: structuredClone(input.goal) }, selectedDemandId: input.goal.id, mainSurface: 'board', loading: false,
        activeWorkspaceId: null, goalFiniteStartIntents: {}, goalDiscussionRequests: {}, agentNames: {}, timelines: {}, error: null })
      api.demands.delegation = async (method, reference) => {
        const goal = useAppStore.getState().demands[input.goal.id]
        if (!goal || reference.goalId !== goal.id || !['goal.delegations', 'goal.plan'].includes(method))
          throw new Error('This private snapshot provides only its exact Goal observation; it never sends input.')
        return { goalId: goal.id, goalUpdatedAt: goal.updatedAt, diskDurability: 'confirmed' as const,
          delegations: goal.delegations ?? [], observations: goal.delegationObservations ?? [], dispatches: goal.dispatches ?? [],
          startObservations: goal.startObservations ?? [], patrols: goal.patrols ?? [], patrolObservations: goal.patrolObservations ?? [],
          ...(goal.responsibility ? { responsibility: goal.responsibility } : {}) }
      }
      render()
    },
    patch(patch: Partial<DemandRecord>) {
      const state = useAppStore.getState(), goal = state.demands[state.selectedDemandId!]!
      useAppStore.setState({ demands: { ...state.demands, [goal.id]: { ...goal, ...patch } } })
      render()
    },
    metadata(sources: SessionHistoryDescriptor[]) {
      api.sessions.historySource = async reference => ({ reference,
        source: 'hostId' in reference ? structuredClone(sources.find(source => source.hostId === reference.hostId && source.agentSessionId === reference.agentSessionId) ?? null) : null,
        issue: null })
    },
    facts() {
      const state = useAppStore.getState()
      return { goal: state.demands[state.selectedDemandId!], selected: state.selectedDemandId,
        drafts: state.goalEditDrafts, loops, sessions: state.sessions }
    }
  }
}

type DelegationResult = Awaited<ReturnType<typeof api.demands.delegation>>
export interface GoalRealWorkInput {
  goal: AgentMuxRpcGoal
  inventory: AgentMuxRpcGoal[]
  delegations: DelegationResult
  plan: DelegationResult
  historySources: SessionHistoryDescriptor[]
  goalContinuations: Extract<Awaited<ReturnType<typeof api.goals.execute>>, { operation: 'demand.show' }>['goalContinuations']
  source: { manifestPath: string; manifestSHA256: string; inputs: Record<string, string> }
}

/** Explicit runtime input only. This module contains no original user Goal or Agent data. */
export function installGoalRealWorkReplay() {
  const input = (window as unknown as { goalsRealWorkInput?: GoalRealWorkInput }).goalsRealWorkInput
  if (!input) return null
  const writes: string[] = []
  const reads: { method: string; reference?: unknown }[] = []
  const reject = (method: string) => async (..._args: unknown[]): Promise<never> => {
    writes.push(method)
    throw new Error(`Private read-only replay has no ${method} owner. Original user data and operations were not changed.`)
  }
  const list = input.inventory.map(goal => publicGoalRecord(goal.id === input.goal.id ? input.goal : goal))
  // Startup observes only the exact inspected Goal. The original navigation
  // inventory enters through the normal read-control consumer after initialize.
  api.demands.list = async () => [publicGoalRecord(structuredClone(input.goal))]
  api.demands.delegation = async (method, params) => {
    reads.push({ method, reference: params })
    if (params.goalId !== input.goal.id) throw new Error('This replay has no captured read for that Goal.')
    if (method === 'goal.delegations') return structuredClone(input.delegations)
    if (method === 'goal.plan') return structuredClone(input.plan)
    return reject(method)()
  }
  const snapshot = api.sessions.snapshot
  api.sessions.snapshot = async () => ({ ...await snapshot(), sessions: [], timelines: {}, runtimeEndpointWarnings: [] })
  api.sessions.historySource = async reference => {
    reads.push({ method: 'sessions.historySource', reference })
    if (!('hostId' in reference)) throw new Error('The captured metadata has an exact original Host, not a Runtime route.')
    const source = input.historySources.find(source => source.hostId === reference.hostId && source.agentSessionId === reference.agentSessionId)
    if (!source) throw new Error('This replay has no captured metadata for that exact Host and Session.')
    return { reference, source: structuredClone(source), issue: null }
  }
  // No canonical Main or Core control bridge is connected in this private App.
  Object.assign(api.demands, Object.fromEntries(['create', 'update', 'confirmAlignment', 'reconcileDispatch', 'reconcilePmoCreation', 'reconcilePmoInput'].map(name => [name, reject(`demands.${name}`)])))
  api.goals.execute = async request => {
    reads.push({ method: request.operation, reference: request })
    if (request.operation === 'demand.list') return { operation: request.operation, demands: list.map(projectHostGoal) }
    if (request.operation === 'demand.show') {
      if (request.demandId !== input.goal.id) throw new Error('This replay has no complete inspect response for that Goal.')
      return { operation: request.operation, demand: projectHostGoal(publicGoalRecord(input.goal)), goalContinuations: structuredClone(input.goalContinuations) }
    }
    return reject(`goals.execute:${request.operation}`)()
  }
  api.goals.handoffDiscussion = reject('goals.handoffDiscussion')
  Object.assign(api.sessions, Object.fromEntries(['launchAgent', 'reopen', 'restart', 'send', 'write', 'promptAgent'].map(name => [name, reject(`sessions.${name}`)])))
  return {
    async activate() {
      await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        operation: 'demand.list', requestId: 'private-real-work-navigation-read' })
      if ((window as unknown as { goalsPlanningRestart?: { phase: string } }).goalsPlanningRestart?.phase !== 'restore')
        useAppStore.setState({ loading: false, mainSurface: 'board', selectedDemandId: input.goal.id,
          activeWorkspaceId: null, sessions: [], agentNames: {}, error: null, toolsOpen: true,
          projectRailOpen: true, layouts: {}, tabs: {} })
      Object.assign(window, { goalsRealWork: {
        facts: () => {
          const state = useAppStore.getState()
          return { source: input.source, originalGoal: input.goal, goal: state.demands[input.goal.id],
            selected: state.selectedDemandId, sessions: state.sessions, reads: [...reads], writes: [...writes] }
        },
        appearance: (value: 'light' | 'dark') => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance: value } } }))
      } })
    }
  }
}
