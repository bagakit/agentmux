import { isDeepStrictEqual } from 'node:util'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
import type { AgentMuxSpatialStateStore } from './spatial-state.js'
import { spatialAgentOpenRecord } from './spatial-agent-open-contract.js'
import type { AgentExecutionInspection } from './agent-execution-coordinator.js'
import type { AgentExecutionReference, AgentExecutionHelperStart } from './agent-execution-contract.js'
import { AgentMuxError } from './errors.js'

export type ExecutionFrameFact = { startByte: number; endByte: number; bytes: number; sha256: string; syntax: 'invalid-json' }
/** No original bytes, exception text, launch input, environment or grant. */
export type ExecutionHelperDiagnostic = { start: AgentExecutionHelperStart; cursor: number | null; ownerInstanceId: string | null }
export type AgentExecutionSourceDiagnostics = { sourceRuntimeId: string; reference: AgentExecutionReference;
  state: 'matched' | 'unconfirmed'; helpers: Record<'frontend' | 'executor', ExecutionHelperDiagnostic>;
  failure?: { hostId: string; role: 'frontend' | 'executor'; stage: 'attach';
    code: 'EXECUTION_PROTOCOL_INVALID_FRAME'; frame: ExecutionFrameFact } }
export type ExecutionJournalDiagnostics = Omit<AgentExecutionSourceDiagnostics, 'sourceRuntimeId' | 'state'>
export type ExecutionSourceDiagnosticsOwner = { spatial: Pick<AgentMuxSpatialStateStore, 'read'>; runtimeId(): string }

/** Trusted owner composition, not a public binding lookup. The public Source
 * reader has already authenticated its actual caller. This owner reads the
 * admission from its own Store; no client-supplied tuple supplies authority. */
export async function inspectSourceExecutionDiagnostics(options: {
  source: ExecutionSourceDiagnosticsOwner; operationId: string; context: AgentMuxRpcCallContext;
  inspect(bindingId: string): Promise<AgentExecutionInspection | null>;
  journal(reference: AgentExecutionReference): Promise<ExecutionJournalDiagnostics | null>
}): Promise<AgentExecutionSourceDiagnostics | null> {
  const { source, context } = options
  const sourceRuntimeId = source.runtimeId()
  const finish = async (result: AgentExecutionSourceDiagnostics | null) => {
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    if (source.runtimeId() !== sourceRuntimeId) throw new AgentMuxError('The original Source Runtime changed during this read.', 'RUNTIME_OWNER_MISMATCH')
    return result
  }
  await finish(null)
  const state = await source.spatial.read(), record = state ? spatialAgentOpenRecord(state.graph, options.operationId) : null
  if (!record?.executionBinding || !record.placement) return await finish(null)
  const reference = record.executionBinding
  if (record.requestId !== options.operationId || reference.createOperationId !== options.operationId || reference.agentSessionId !== record.agentSessionId || record.placement.runtimeId !== sourceRuntimeId)
    throw new AgentMuxError('The original Source admission no longer confirms this diagnostic scope.', 'EXECUTION_DIAGNOSTIC_SCOPE_UNCONFIRMED')
  const inspected = await options.inspect(reference.bindingId), witness = inspected?.association
  const empty = (): ExecutionHelperDiagnostic => ({ start: { outcome: 'unknown', runId: null }, cursor: null, ownerInstanceId: null })
  const unknown: AgentExecutionSourceDiagnostics = { sourceRuntimeId, reference, state: 'unconfirmed', helpers: { frontend: empty(), executor: empty() } }
  if (!inspected || inspected.bindingId !== reference.bindingId || inspected.agentSessionId !== reference.agentSessionId || inspected.resourceWorkspacePath !== record.placement.workspacePath ||
      (inspected.continuation !== undefined && !isDeepStrictEqual(inspected.continuation, reference)) || witness?.state !== 'confirmed' || !isDeepStrictEqual(witness.reference, reference) ||
      inspected.agentHostId !== record.execution.hostId || inspected.resourceHostId !== record.placement.hostId ||
      !witness.agent || witness.agent.executorId !== record.executorId || witness.agent.executorRevision !== record.execution.executorRevision || witness.agent.workspacePath !== record.execution.workspacePath ||
      witness.agentRuntimeId !== record.execution.runtimeId || witness.resourceRuntimeId !== sourceRuntimeId ||
      witness.resourceWorkspacePath !== record.placement.workspacePath || (witness.sourceRequestDigest !== undefined && witness.sourceRequestDigest !== record.digest) || !isDeepStrictEqual(inspected.agentRoute, record.execution.adoptedRoute) || inspected.resourceRoute !== undefined) return await finish(unknown)
  const retained = await options.journal(reference)
  if (!retained) return await finish(unknown)
  return await finish({ ...retained, sourceRuntimeId, state: 'matched' })
}
