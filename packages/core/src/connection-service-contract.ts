/** Connector policy belongs to the current endpoint, independently of each application's enabled value. */
export type ConnectionServiceState = { enabled: boolean; revision: number }
export type ConnectionServiceConfigure = { operationId: string; expectedRevision: number; service: { enabled: boolean } }
export type ConnectionServiceOperation = { operationId: string; expectedRevision: number; status: 'configured'; service: ConnectionServiceState }
export type ConnectionServiceParamsMap = {
  'connection.service.get': Record<string, never>
  'connection.service.configure': ConnectionServiceConfigure
  'connection.service.inspect': { operationId: string }
}
export type ConnectionServiceResultMap = {
  'connection.service.get': ConnectionServiceState
  'connection.service.configure': ConnectionServiceOperation
  'connection.service.inspect': { operation: ConnectionServiceOperation | null }
}
export type ConnectionServiceMethod = keyof ConnectionServiceParamsMap
/** Read and recovery remain available while new automatic Connector traffic is disabled. */
export interface ConnectionServicePort {
  get(): Promise<ConnectionServiceState>
  configure(input: ConnectionServiceConfigure): Promise<ConnectionServiceOperation>
  inspect(input: { operationId: string }): Promise<{ operation: ConnectionServiceOperation | null }>
}
