import { isDeliveryLogId } from './delivery-log-id.js'

/** Exact command failure boundary. A known prefix never authorizes replay of the remainder. */
export type AgentMuxControlFailure = {
  disposition: 'not_applied' | 'unknown'
  confirmedInputBytes: number | null
}

/** A creation receipt names the exact original operation, independently of input receipts. */
export type AgentMuxCreationFailure = {
  operationId: string
  disposition: 'not_applied' | 'unknown'
}

/** Native persistence facts are diagnostic; they do not establish process effects. */
export type AgentMuxStorageFailure = {
  stage: 'open' | 'read' | 'start' | 'append' | 'finalize' | 'maintenance' | 'checkpoint' | null
  sqlitePrimaryCode: number | null
  sqliteExtendedCode: number | null
  systemErrno: number | null
  transactionOutcome: 'not_started' | 'not_committed' | 'committed' | 'unknown'
}

export function parseAgentMuxCreationFailure(value: unknown): AgentMuxCreationFailure {
  const fields = failureRecord(value, ['operationId', 'disposition'])
  if (typeof fields.operationId !== 'string' || !fields.operationId ||
      fields.disposition !== 'not_applied' && fields.disposition !== 'unknown') return invalidFailure()
  return fields as AgentMuxCreationFailure
}

export function parseAgentMuxStorageFailure(value: unknown): AgentMuxStorageFailure {
  const fields = failureRecord(value, ['stage', 'sqlitePrimaryCode', 'sqliteExtendedCode', 'systemErrno', 'transactionOutcome'])
  if (fields.stage !== null && (typeof fields.stage !== 'string' || !['open', 'read', 'start', 'append', 'finalize', 'maintenance', 'checkpoint'].includes(fields.stage)) ||
      typeof fields.transactionOutcome !== 'string' || !['not_started', 'not_committed', 'committed', 'unknown'].includes(fields.transactionOutcome) ||
      ['sqlitePrimaryCode', 'sqliteExtendedCode', 'systemErrno'].some(key => fields[key] !== null &&
        (!Number.isSafeInteger(fields[key]) || Number(fields[key]) <= 0))) return invalidFailure()
  return fields as AgentMuxStorageFailure
}

function invalidFailure(): never { throw new AgentMuxError('Invalid original Runtime failure facts.', 'CONTROL_PROTOCOL_ERROR') }
function errorRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalidFailure()
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) return invalidFailure()
  }
  return value as Record<string, unknown>
}
function failureRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = errorRecord(value, keys)
  if (Object.keys(result).length !== keys.length) return invalidFailure()
  return result
}

/** Flat original failure data; copying it grants no input or lifecycle authority. */
export type AgentMuxErrorData = {
  code: string
  message: string
  detail?: string
  controlFailure?: AgentMuxControlFailure
  logId?: string
  creationFailure?: AgentMuxCreationFailure
  storageFailure?: AgentMuxStorageFailure
}

export function parseAgentMuxErrorData(value: unknown): AgentMuxErrorData {
  const invalid = () => { throw new AgentMuxError('Original error data is invalid.', 'CONTROL_PROTOCOL_ERROR') }
  const source = errorRecord(value, ['code', 'message', 'detail', 'controlFailure', 'logId', 'creationFailure', 'storageFailure'])
  if (typeof source.code !== 'string' || !source.code.trim() || source.code.length > 256 || /[\0\r\n]/u.test(source.code) ||
      typeof source.message !== 'string' || source.message.length > 64 * 1024 * 1024 ||
      source.detail !== undefined && (typeof source.detail !== 'string' || source.detail.length > 64 * 1024 * 1024) ||
      source.logId !== undefined && !isDeliveryLogId(source.logId)) return invalid()
  let controlFailure: AgentMuxControlFailure | undefined
  if (source.controlFailure !== undefined) {
    const failure = errorRecord(source.controlFailure, ['disposition', 'confirmedInputBytes'])
    if (Object.keys(failure).length !== 2 || (failure.disposition !== 'not_applied' && failure.disposition !== 'unknown') ||
        failure.confirmedInputBytes !== null && (!Number.isSafeInteger(failure.confirmedInputBytes) || Number(failure.confirmedInputBytes) < 0)) return invalid()
    controlFailure = { disposition: failure.disposition as AgentMuxControlFailure['disposition'], confirmedInputBytes: failure.confirmedInputBytes as number | null }
  }
  return { code: source.code, message: source.message, ...(source.detail === undefined ? {} : { detail: source.detail }),
    ...(controlFailure === undefined ? {} : { controlFailure }), ...(source.logId === undefined ? {} : { logId: source.logId }),
    ...(source.creationFailure === undefined ? {} : { creationFailure: parseAgentMuxCreationFailure(source.creationFailure) }),
    ...(source.storageFailure === undefined ? {} : { storageFailure: parseAgentMuxStorageFailure(source.storageFailure) }) }
}

export class AgentMuxError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: string,
    readonly controlFailure?: AgentMuxControlFailure,
    readonly logId?: string,
    readonly creationFailure?: AgentMuxCreationFailure,
    readonly storageFailure?: AgentMuxStorageFailure
  ) {
    super(message)
    this.name = 'AgentMuxError'
  }
}

/** Keep cancellation provenance while preserving the wrapper code consumed by callers. */
export function agentMuxCancellationError(message: string, code: string, reason: unknown): AgentMuxError {
  const detail = reason === undefined ? undefined : JSON.stringify(reason instanceof AgentMuxError
    ? { code: reason.code, name: reason.name, message: reason.message,
      ...(reason.detail === undefined ? {} : { detail: reason.detail }),
      ...(reason.controlFailure === undefined ? {} : { controlFailure: reason.controlFailure }),
      ...(reason.creationFailure === undefined ? {} : { creationFailure: reason.creationFailure }),
      ...(reason.storageFailure === undefined ? {} : { storageFailure: reason.storageFailure }) }
    : { code: reason instanceof Error ? reason.name : 'unknown', message: reason instanceof Error ? reason.message : String(reason) })
  const error = new AgentMuxError(message, code, detail)
  if (reason !== undefined) Object.defineProperty(error, 'cause', { value: reason, configurable: true })
  return error
}
