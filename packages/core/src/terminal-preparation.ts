import type { RunSpec } from '@ctxmux/sdk'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Sensitive Host material. Retain privately and return unchanged only to its execution Host. */
export type AgentMuxPreparedTerminal = {
  createOperationId: string
  workspacePath: string
  /** Opaque Core-owned launch material, including sensitive Host environment. */
  launch: string
}

/** Original recoverable Stop identity. This is private management data, never a new grant. */
export type AgentMuxPreparedTerminalStop = {
  run: { runId: string }
  ownerInstanceId: string
  operationId: string
}

export function parsePreparedTerminalStop(value: unknown): AgentMuxPreparedTerminalStop {
  const code = 'INVALID_TERMINAL_PREPARATION'
  const r = rpcRecord(value, ['run', 'ownerInstanceId', 'operationId'], code)
  const run = rpcRecord(r.run, ['runId'], code)
  if ([run.runId, r.ownerInstanceId, r.operationId].some(v => typeof v !== 'string' || !v || /[\0\r\n]/u.test(v)))
    throw new AgentMuxError('The original terminal Stop preparation is invalid.', code)
  return structuredClone(r) as AgentMuxPreparedTerminalStop
}

/** Validate original creation data without consulting or repairing it from the current environment. */
export function parsePreparedTerminal(
  value: unknown,
): AgentMuxPreparedTerminal {
  return decodePreparedTerminal(value).prepared
}

/** Internal adapter boundary; Native wire values are never exported from the public Core entry. */
export function decodePreparedTerminal(value: unknown): {
  prepared: AgentMuxPreparedTerminal
  request: RunSpec
} {
  const code = 'INVALID_TERMINAL_PREPARATION'
  const invalid = (): never => {
    throw new AgentMuxError(
      'The original terminal preparation is invalid; its creation remains unconfirmed.',
      code,
    )
  }
  const record = (value: unknown, fields?: readonly string[]) =>
    rpcRecord(value, fields, code)
  const string = (value: unknown, nonempty = false): value is string =>
    typeof value === 'string' &&
    (!nonempty || value.length > 0) &&
    !value.includes('\0')
  const array = (value: unknown): value is unknown[] => {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      return false
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !('value' in descriptor)) return false
    }
    return true
  }
  const source = record(value, ['createOperationId', 'workspacePath', 'launch'])
  if (!string(source.launch, true)) invalid()
  let decoded: unknown
  try {
    decoded = JSON.parse(source.launch as string)
  } catch {
    invalid()
  }
  const captured = record(decoded, ['createOperationId', 'request'])
  const request = record(captured.request, [
    'program',
    'args',
    'cwd',
    'env',
    'initial_size',
    'declared_inputs',
  ])
  const size = record(request.initial_size, ['cols', 'rows'])
  const env = record(request.env)
  if (
    !string(source.createOperationId, true) ||
    captured.createOperationId !== source.createOperationId ||
    !string(request.program, true) ||
    !string(source.workspacePath, true) ||
    request.cwd !== source.workspacePath ||
    env.AGENTMUX_LIFECYCLE_OPERATION_ID !== source.createOperationId ||
    !array(request.args) ||
    !request.args.every((value) => string(value)) ||
    !array(request.declared_inputs) ||
    request.declared_inputs.length !== 0 ||
    !Number.isSafeInteger(size.cols) ||
    (size.cols as number) <= 0 ||
    !Number.isSafeInteger(size.rows) ||
    (size.rows as number) <= 0 ||
    Object.entries(env).some(
      ([key, value]) => !key || /[=\0]/u.test(key) || !string(value),
    )
  )
    invalid()
  return {
    prepared: structuredClone(source) as AgentMuxPreparedTerminal,
    request: request as RunSpec,
  }
}
