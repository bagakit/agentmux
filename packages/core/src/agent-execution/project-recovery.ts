import { createHash } from 'node:crypto'
import { AgentMuxError } from '../errors.js'
import { decodePreparedRun, type PreparedRun } from '../prepared-run.js'
import type { AgentExecutionBridgePort, AgentExecutionBridgePosition, AgentExecutionBridgeState } from './bridge.js'

export type ProjectExecutionRecovery = {
  original: AgentExecutionBridgeState
  frontend: AgentExecutionBridgePosition
  ownerInstanceId: string
  operationId: string
  journalIdentity: string
  journalReady?: true
  initialized?: true
}

export function projectRecoveryError(message: string): AgentMuxError {
  return new AgentMuxError(message, 'EXECUTION_PROJECT_RECOVERY_UNCONFIRMED')
}

/** The old executor output is never sent to a new bridge. The original frontend
 * must still be at a complete input frame boundary before it can accept replies. */
export async function readFrontendRecoveryCut(frontend: AgentExecutionBridgePort, original: AgentExecutionBridgeState): Promise<AgentExecutionBridgePosition> {
  const position = original.frontend
  const pendingReply = [original.pending, original.concurrentPending].find(pending => pending?.source === 'executor')
  const before = frontend.runtimeIdentity()
  if (before.instanceId !== position.ownerInstanceId || (pendingReply?.chunk?.offset ?? 0) !== 0)
    throw projectRecoveryError('The original frontend instance or its complete input frame boundary is unconfirmed.')
  const replay = await frontend.readRunReplay({ runId: position.runId }, position.outputByte, 'raw')
  const { run } = replay
  const service = run.nativeService
  if (frontend.runtimeIdentity().instanceId !== position.ownerInstanceId || run.runId !== position.runId || run.state !== 'running' ||
    service?.owner.type !== 'serving' || service.input.phase.type !== 'open' || service.input.unsettledCommands !== 0 ||
    service.input.unsettledRequestBytes !== 0 || service.input.activeConfirmedBytes !== 0 ||
    service.input.completedInputBytes !== position.inputByte || run.acceptedInputBytes !== position.inputByte || replay.gap)
    throw projectRecoveryError('The original frontend has no confirmed idle input at its complete frame boundary.')
  let outputByte = position.outputByte
  let completeFrame = true
  for (const chunk of replay.replay) {
    if (chunk.startByte !== outputByte || chunk.endByte - chunk.startByte !== chunk.dataBytes.byteLength)
      throw projectRecoveryError('The original frontend output is not contiguous at the recovery cut.')
    outputByte = chunk.endByte
    if (chunk.dataBytes.byteLength) completeFrame = chunk.dataBytes.at(-1) === 10
  }
  if (outputByte !== run.latestOutputBytes || !completeFrame)
    throw projectRecoveryError('The original frontend has no confirmed complete output frame at the recovery cut.')
  return { ...position, outputByte }
}

/** Derive a fresh Start from the exact private launch, including its journal and
 * resource grant. The retired Start identity stays available for reconciliation. */
export function prepareProjectExecutorSuccessor(bindingId: string, original: PreparedRun, oldRunId: string, ownerInstanceId: string): PreparedRun {
  const { prepared, request } = decodePreparedRun(original)
  const createOperationId = createHash('sha256').update(JSON.stringify([bindingId, 'project-executor-successor', oldRunId, ownerInstanceId])).digest('hex')
  const launch = JSON.stringify({ createOperationId, request: { ...request, env: { ...request.env, AGENTMUX_LIFECYCLE_OPERATION_ID: createOperationId } } })
  return { ...prepared, createOperationId, launch }
}
