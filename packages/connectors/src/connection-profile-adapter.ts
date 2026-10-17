import type { ConnectionConfig, ConnectionProfileObservation } from '@agentmux/core/connections'

/** Current online observations only. Profile writes belong to the original Setup owner. */
export interface ConnectionProfileAdapter {
  get(config: ConnectionConfig, revision: number, credential: string, signal?: AbortSignal): Promise<ConnectionProfileObservation>
}
