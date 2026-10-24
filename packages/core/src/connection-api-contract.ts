import type { ConnectionApplication } from './connections-contract.js'

export type ConnectionApiJson = null | boolean | number | string | ConnectionApiJson[] | { [key: string]: ConnectionApiJson }
export type ConnectionApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
/** Caller-transmitted bytes, never a path on the executing Host. */
export type ConnectionApiFile = { field: string; name: string; contentType: string; base64: string }
export type ConnectionApiRequest = {
  method: ConnectionApiMethod
  /** Canonical relative native API path. Origin and authentication belong to the adapter. */
  path: string
  query?: Record<string, string | number | boolean>
  body?: ConnectionApiJson
  files?: ConnectionApiFile[]
}
export type ConnectionApiDescription = {
  documentationUrl: string
  requestFormats: Array<'json' | 'multipart'>
  responseFormats: Array<'json' | 'empty'>
}
export type ConnectionApiSelector = { bindingId: string; bindingRevision: number; connectionId: string; connectionRevision: number }
export type ConnectionApiIdentity = ConnectionApiSelector & {
  adapterId: string; application: ConnectionApplication; label: string
  executionHostId: string; agentSessionId: string; executionRuntimeId?: string
  externalConversationId: string
  api: ConnectionApiDescription
}
export type ConnectionApiResponseBody =
  | { format: 'json'; value: ConnectionApiJson }
  | { format: 'empty' }
  | { format: 'unavailable'; reason: 'unsupported-format' | 'too-large' | 'unreadable' }
/** HTTP response is not a claim that the native business operation succeeded. */
export type ConnectionApiResponse = { status: number; body: ConnectionApiResponseBody; redacted: boolean }
export type ConnectionApiOperation = {
  operationId: string; identity: ConnectionApiIdentity
  /** Digest binds the complete original request, including resource bytes. Bodies are not journaled. */
  request: { method: ConnectionApiMethod; path: string; digest: string }
} & ({ state: 'unknown'; code?: string } | { state: 'responded'; response: ConnectionApiResponse })
export type ConnectionApiRequestInput = { operationId: string; identity: ConnectionApiSelector; request: ConnectionApiRequest }
export type ConnectionApiCallContext = {
  actor: { kind: 'agent' | 'user' | 'device'; id: string }
  /** Authenticated original Session on the serving semantic Host, never supplied by the caller payload. */
  session?: { hostId: string; agentSessionId: string }
  assertCurrent?(): void | Promise<void>
}
export interface ConnectionApiPort {
  identities(input: { agentSessionId: string }, context: ConnectionApiCallContext): Promise<{ identities: ConnectionApiIdentity[] }>
  request(input: ConnectionApiRequestInput, context: ConnectionApiCallContext): Promise<ConnectionApiOperation>
  inspect(input: { operationId: string }, context: ConnectionApiCallContext): Promise<{ operation: ConnectionApiOperation | null }>
}
export type ConnectionApiParamsMap = {
  'connection.api.identities': { agentSessionId: string }
  'connection.api.request': ConnectionApiRequestInput
  'connection.api.inspect': { operationId: string }
}
export type ConnectionApiResultMap = {
  'connection.api.identities': { identities: ConnectionApiIdentity[] }
  'connection.api.request': ConnectionApiOperation
  'connection.api.inspect': { operation: ConnectionApiOperation | null }
}
export type ConnectionApiRpcMethod = keyof ConnectionApiParamsMap
