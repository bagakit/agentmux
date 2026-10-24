import { presentError } from '@agentmux/client-ui/error-presentation'
import { parseConnectionServiceResult, type ConnectionServiceState } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { api } from './api'

export type ConnectorServiceObservation = {
  source: typeof api.connections.call
  generation: number
  state: ConnectionServiceState | null
  issue: string
}
export type ConnectorServiceObservations = Record<string, ConnectorServiceObservation>

/** Only an exact captured Host/Runtime names a presentation scope. */
export const connectorServiceScope = (target: ConnectionHostingTarget, adapterId?: string): string => JSON.stringify(adapterId === undefined ? [target.hostId, target.runtimeId] : [target.hostId, target.runtimeId, adapterId])
export function selectConnectorServiceObservation(observations: ConnectorServiceObservations, target?: ConnectionHostingTarget | null, adapterId?: string): ConnectorServiceObservation | null {
  if (!target) return null
  const observed = observations[connectorServiceScope(target, adapterId)]
  return observed?.source === api.connections.call && (!observed.state || observed.state.adapterId === adapterId) ? observed : null
}

/** Transient projections in the original AppStore; ConnectionHost alone owns configuration. */
export function observeConnectorService(state: ConnectionServiceState, source: typeof api.connections.call, target: ConnectionHostingTarget): void {
  const key = connectorServiceScope(target, state.adapterId)
  useAppStore.setState(current => {
    if (source !== api.connections.call) return current
    const previous = current.connectorServiceObservation[key]
    if (previous?.source === source && previous.state && previous.state.revision > state.revision) return current
    return { connectorServiceObservation: { ...current.connectorServiceObservation,
      [key]: { source, generation: (previous?.generation ?? 0) + 1, state, issue: '' } } }
  })
}

/** Opening or explicitly checking reads configuration only; no Agent or receiver work is started. */
export async function readConnectorService(isCurrent = () => true, target?: ConnectionHostingTarget, adapterId?: string): Promise<ConnectionServiceState> {
  const source = api.connections.call
  const original = target ?? await api.connections.hostingTarget()
  const key = connectorServiceScope(original, adapterId)
  const previous = useAppStore.getState().connectorServiceObservation[key]
  const generation = (previous?.generation ?? 0) + 1
  useAppStore.setState(current => isCurrent() && source === api.connections.call ? ({ connectorServiceObservation: { ...current.connectorServiceObservation, [key]: {
    source, generation, state: previous?.source === source ? previous.state : null,
    issue: previous?.source === source ? previous.issue : ''
  } } }) : current)
  try {
    const input = adapterId === undefined ? {} : { adapterId }
    const state = parseConnectionServiceResult('connection.service.get', await source('connection.service.get', input, original), input)
    const current = useAppStore.getState().connectorServiceObservation[key]
    if (isCurrent() && current?.source === source && current.generation === generation) observeConnectorService(state, source, original)
    return state
  } catch (error) {
    useAppStore.setState(current => {
      const observed = current.connectorServiceObservation[key]
      return isCurrent() && source === api.connections.call && observed?.source === source && observed.generation === generation
        ? { connectorServiceObservation: { ...current.connectorServiceObservation, [key]: { ...observed, issue: presentError(error) } } } : current
    })
    throw error
  }
}
