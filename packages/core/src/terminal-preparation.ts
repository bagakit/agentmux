import { decodePreparedRun, type PreparedRun } from './prepared-run.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Public shell preparation; the private Run codec owns its exact launch representation. */
export type AgentMuxPreparedTerminal = PreparedRun

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
  return decodePreparedRun(value, 'INVALID_TERMINAL_PREPARATION').prepared
}
