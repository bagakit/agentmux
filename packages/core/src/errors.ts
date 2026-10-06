import { isDeliveryLogId } from './delivery-log-id.js'

/** Exact command failure boundary. A known prefix never authorizes replay of the remainder. */
export type AgentMuxControlFailure = {
  disposition: 'not_applied' | 'unknown'
  confirmedInputBytes: number | null
}

/** Flat original failure data; copying it grants no input or lifecycle authority. */
export type AgentMuxErrorData = {
  code: string
  message: string
  detail?: string
  controlFailure?: AgentMuxControlFailure
  logId?: string
}

export function parseAgentMuxErrorData(value: unknown): AgentMuxErrorData {
  const invalid = () => { throw new AgentMuxError('Original error data is invalid.', 'CONTROL_PROTOCOL_ERROR') }
  const record = (input: unknown, fields: readonly string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid()
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (typeof key !== 'string' || !fields.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) return invalid()
    }
    return input as Record<string, unknown>
  }
  const source = record(value, ['code', 'message', 'detail', 'controlFailure', 'logId'])
  if (typeof source.code !== 'string' || !source.code.trim() || source.code.length > 256 || /[\0\r\n]/u.test(source.code) ||
      typeof source.message !== 'string' || source.message.length > 64 * 1024 * 1024 ||
      source.detail !== undefined && (typeof source.detail !== 'string' || source.detail.length > 64 * 1024 * 1024) ||
      source.logId !== undefined && !isDeliveryLogId(source.logId)) return invalid()
  let controlFailure: AgentMuxControlFailure | undefined
  if (source.controlFailure !== undefined) {
    const failure = record(source.controlFailure, ['disposition', 'confirmedInputBytes'])
    if (Object.keys(failure).length !== 2 || (failure.disposition !== 'not_applied' && failure.disposition !== 'unknown') ||
        failure.confirmedInputBytes !== null && (!Number.isSafeInteger(failure.confirmedInputBytes) || Number(failure.confirmedInputBytes) < 0)) return invalid()
    controlFailure = { disposition: failure.disposition as AgentMuxControlFailure['disposition'], confirmedInputBytes: failure.confirmedInputBytes as number | null }
  }
  return { code: source.code, message: source.message, ...(source.detail === undefined ? {} : { detail: source.detail }),
    ...(controlFailure === undefined ? {} : { controlFailure }), ...(source.logId === undefined ? {} : { logId: source.logId }) }
}

export class AgentMuxError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: string,
    readonly controlFailure?: AgentMuxControlFailure,
    readonly logId?: string
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
      ...(reason.controlFailure === undefined ? {} : { controlFailure: reason.controlFailure }) }
    : { code: reason instanceof Error ? reason.name : 'unknown', message: reason instanceof Error ? reason.message : String(reason) })
  const error = new AgentMuxError(message, code, detail)
  if (reason !== undefined) Object.defineProperty(error, 'cause', { value: reason, configurable: true })
  return error
}
