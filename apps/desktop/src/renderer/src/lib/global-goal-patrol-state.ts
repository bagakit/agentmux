import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { useAppStore } from '../store'
import { desktopUserFragments } from './desktop-user-state'

type Request = { operationId?: string; pending: boolean; issue?: string; report?: AgentMuxSpaceMutationReport }
let current: Request | null = null, initialized = false, flight: Promise<void> | null = null
let unknown: Request = { pending: false, issue: '原巡查引用尚未读取；当前 Agent 和原工作面保持可用。' }
const listeners = new Set<() => void>()
export const globalGoalPatrolSnapshot = () => initialized ? current : unknown
export const subscribeGlobalGoalPatrol = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const notify = () => { for (const listener of listeners) listener() }
function publish(value: Request) { current = value; notify() }
export async function initializeGlobalGoalPatrol(): Promise<void> {
  if (initialized) return
  const operationId = await desktopUserFragments.load('globalGoalPatrolOperation', value => {
    if (value !== null && (typeof value !== 'string' || !value.trim())) throw new Error('原巡查引用无法读取；原字节保留。')
  })
  current = operationId ? { operationId, pending: false } : null
  initialized = true; notify()
}

/** Only an explicitly invoked action consumes this reference; hydration never dispatches it. */
export async function requestGlobalGoalPatrol(fresh = false): Promise<void> {
  if (flight) return flight
  flight = Promise.resolve().then(async () => {
    let operationId: string | undefined
    try {
      await initializeGlobalGoalPatrol()
      operationId = !fresh && current?.operationId ? current.operationId : mintObjectId()
      publish({ operationId, pending: true })
      desktopUserFragments.write('globalGoalPatrolOperation', operationId)
      await desktopUserFragments.checkpoint('globalGoalPatrolOperation')
      const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: operationId, operation: 'demand.patrol-all' })
      if (result.operation !== 'demand.patrol-all') throw new Error('The original global inspection returned another operation.')
      publish({ operationId, pending: false, report: result })
    } catch (error) {
      const issue = (error instanceof Error ? error.message : String(error)) + ' 原操作与当前输入保留；不会自动重发。'
      if (initialized) publish({ ...(operationId ? { operationId } : current), pending: false, issue })
      else { unknown = { pending: false, issue }; notify() }
    }
  }).finally(() => { flight = null })
  return flight
}
