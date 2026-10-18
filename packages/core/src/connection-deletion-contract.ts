import type { ConnectionApplication } from './connections-contract.js'

/** Remove one exact local identity; remote applications and immutable receipts are retained. */
export type ConnectionDeleteInput = { operationId: string; connectionId: string; expectedRevision: number }
export type ConnectionDeleteOperation = {
  operationId: string
  status: 'deleted'
  connectionId: string
  application: ConnectionApplication
  deletedRevision: number
}
export type ConnectionDeletionParamsMap = {
  'connection.delete': ConnectionDeleteInput
  'connection.delete.inspect': { operationId: string }
}
export type ConnectionDeletionResultMap = {
  'connection.delete': ConnectionDeleteOperation
  'connection.delete.inspect': { operation: ConnectionDeleteOperation | null }
}
export type ConnectionDeletionMethod = keyof ConnectionDeletionParamsMap
