import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionServiceState } from '@agentmux/core/connections'
import { useAppStore } from '../store'
import { api } from './api'

export type ConnectorServiceObservation = {
  source: typeof api.connections.call
  generation: number
  state: ConnectionServiceState | null
  issue: string
}

/** A transient projection in the original AppStore, scoped to the original connection endpoint. */
export function observeConnectorService(state: ConnectionServiceState, source = api.connections.call): void {
  useAppStore.setState(current => {
    if (source !== api.connections.call) return current
    const previous = current.connectorServiceObservation
    if (previous?.source === source && previous.state && previous.state.revision > state.revision) return current
    return { connectorServiceObservation: { source, generation: (previous?.generation ?? 0) + 1, state, issue: '' } }
  })
}

/** Opening or explicitly checking reads configuration only; no Agent or receiver work is started. */
export async function readConnectorService(isCurrent = () => true): Promise<ConnectionServiceState> {
  const source = api.connections.call, previous = useAppStore.getState().connectorServiceObservation
  const generation = (previous?.generation ?? 0) + 1
  useAppStore.setState({ connectorServiceObservation: {
    source, generation, state: previous?.source === source ? previous.state : null,
    issue: previous?.source === source ? previous.issue : ''
  } })
  try {
    const state = await source('connection.service.get', {})
    const current = useAppStore.getState().connectorServiceObservation
    if (isCurrent() && current?.source === source && current.generation === generation) observeConnectorService(state, source)
    return state
  } catch (error) {
    useAppStore.setState(current => isCurrent() && source === api.connections.call && current.connectorServiceObservation?.source === source && current.connectorServiceObservation.generation === generation
      ? { connectorServiceObservation: { ...current.connectorServiceObservation, issue: presentError(error) } } : current)
    throw error
  }
}
