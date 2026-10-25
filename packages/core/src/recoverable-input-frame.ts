import type { ClientFrame } from '@ctxmux/sdk'
import { CTXMUX_MAX_FRAME_BYTES as MAX_FRAME_BYTES } from './ctxmux-run-adapter.js'
import type { AgentMuxRunInputOperation } from './types.js'
import { AgentMuxError } from './errors.js'

type InputIdentity = Omit<AgentMuxRunInputOperation, 'data'>

// The public recoverableInput contract encodes bytes as JSON numbers. Reserve
// the exact identity envelope and the largest cursor for a stable byte layout.
export function inputEnvelopeBytes(runId: string, operation: InputIdentity, expectedByte: number): number {
  const envelope: ClientFrame = { type: 'request', request: { type: 'recoverable_input', operation: {
    daemon_instance: operation.ownerInstanceId, operation_key: operation.operationId, id: runId,
    expected_byte: expectedByte, data: [] } } }
  return Buffer.byteLength(JSON.stringify(envelope))
}

export function inputChunkBytes(runId: string, operation: InputIdentity): number {
  const bytes = Math.floor((MAX_FRAME_BYTES - inputEnvelopeBytes(runId, operation, Number.MAX_SAFE_INTEGER)) / 4)
  if (bytes < 1) throw new AgentMuxError('The original Input identity exceeds the Runtime transport frame budget.', 'EXECUTION_INPUT_SIZE_UNCONFIRMED')
  return bytes
}

export function retainedInputFits(runId: string, operation: InputIdentity, data: Uint8Array): boolean {
  if (data.byteLength > MAX_FRAME_BYTES) return false
  let bytes = inputEnvelopeBytes(runId, operation, operation.expectedByte) - 1
  for (const value of data) bytes += value < 10 ? 2 : value < 100 ? 3 : 4
  return bytes <= MAX_FRAME_BYTES
}
