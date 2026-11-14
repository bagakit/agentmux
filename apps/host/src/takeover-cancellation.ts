import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, type AgentMuxHeadlessRuntime, type AgentMuxRpcCallContext, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { parseAgentTakeoverCancellation, parseAgentCreationCancellationResult, takeoverCancellationRecord, type AgentTakeoverCancellationInput, type AgentTakeoverCancellationResult } from '@agentmux/core/agent-takeover'
import { spatialAgentOpenRecord, spatialAgentOpenDigest } from '@agentmux/core/spatial-state'

/** Source admission and execution control remain separate original owners. */
export async function cancelOriginalTakeover(options: { spatial: AgentMuxSpatialStateStore; runtime(): AgentMuxHeadlessRuntime }, value: AgentTakeoverCancellationInput,
  context: AgentMuxRpcCallContext, inspectOnly = false, originalActor?: { kind: 'user'|'device'; id: string }): Promise<AgentTakeoverCancellationResult> {
  const input = parseAgentTakeoverCancellation(value), runtime = options.runtime(), owner = runtime.ownerIdentity()
  if (context.caller || !context.principal || !['user','device'].includes(context.principal.kind)) throw new AgentMuxError('Takeover cancellation requires the original person or device.', 'CONTROL_PERMISSION_DENIED')
  if (owner.runtimeId !== input.expectedRuntimeId) throw new AgentMuxError('The cancellation belongs to another original spatial Runtime.', 'RUNTIME_OWNER_MISMATCH')
  const { operationId: originalOperationId, ...originalInput } = input.request
  const request = { schemaVersion: 5 as const, requestId: originalOperationId, operation: 'agent.open' as const, ...originalInput }
  if (request.operation !== 'agent.open' || request.content.kind !== 'takeover-agent') throw new AgentMuxError('Cancel the exact original Takeover.', 'INVALID_CONTROL_REQUEST')
  const actor = originalActor ?? { kind: context.principal.kind as 'user'|'device', id: context.principal.id }
  let state = await options.spatial.read()
  if (!state) throw new AgentMuxError('The original spatial owner is unavailable. Its work is retained.', 'SPATIAL_STATE_ABSENT')
  let record = spatialAgentOpenRecord(state.graph, request.requestId)
  if (record && (!record.takeover || record.takeoverRequestDigest !== spatialAgentOpenDigest(request))) throw new AgentMuxError('This original operation belongs to another Takeover.', 'SPACE_REQUEST_CONFLICT')
  const previous = takeoverCancellationRecord(state.graph, request.requestId)
  if (previous && (!isDeepStrictEqual(previous.input, input) || !isDeepStrictEqual(previous.actor, actor))) throw new AgentMuxError('The original cancellation has another intent or actor.', 'AGENT_TAKEOVER_CANCELLATION_CONFLICT')
  let acknowledged = false
  if (!inspectOnly) {
    await context.assertCurrent?.(); context.signal?.throwIfAborted()
    state = await options.spatial.admitTakeoverCancellation({ input, actor })
    acknowledged = true
    record = spatialAgentOpenRecord(state.graph, request.requestId)
  }
  const base = { owner: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, operationId: input.operationId, createOperationId: request.requestId,
    to: record?.address ?? null, diskDurability: acknowledged ? 'confirmed' as const : 'unconfirmed' as const }
  if (!previous && inspectOnly) return { ...base, outcome: 'unconfirmed', agent: null, initialInput: 'unknown', issue: 'The original cancellation has not been observed.' }
  if (!record) return { ...base, outcome: 'cancelled', agent: null, initialInput: 'held', issue: null }
  const control = { createOperationId: record.requestId, agentSessionId: record.agentSessionId, operationId: input.operationId }
  try {
    let result: import('@agentmux/core/agent-takeover').AgentCreationCancellationResult
    if (record.executionBinding) {
      const bindings = runtime.executionBindings
      if (!bindings.cancelOriginal) throw new AgentMuxError('The original execution owner cannot confirm cancellation.', 'CONTROL_UNAVAILABLE')
      result = await bindings.cancelOriginal(record.executionBinding, control, context, inspectOnly)
    } else if (record.execution.hostId === 'local') {
      if (record.execution.runtimeId !== owner.runtimeId) throw new AgentMuxError('The retained execution belongs to another original Runtime.', 'RUNTIME_OWNER_MISMATCH')
      result = inspectOnly ? await runtime.client.inspectAgentCreationCancellation(control) : await runtime.client.cancelAgentCreation(control)
    } else {
      const host = await runtime.executionHost(record.execution.hostId, record.execution.adoptedRoute, { context, call: { method: 'agent.open', params: input.request } })
      try {
        if (host.runtimeId !== record.execution.runtimeId) throw new AgentMuxError('The original execution route answers for another Runtime.', 'RUNTIME_OWNER_MISMATCH')
        if (record.execution.adoptedRoute && await host.client.resolveAgentCreationSessionId(control.createOperationId) !== control.agentSessionId) throw new AgentMuxError('The original execution operation names another Session.', 'AGENT_CREATION_OPERATION_CONFLICT')
        result = inspectOnly ? await host.client.inspectAgentCreationCancellation(control) : await host.client.cancelAgentCreation(control)
      } finally { await host.dispose?.() }
    }
    result = parseAgentCreationCancellationResult(result, control, record.execution.runtimeId!)
    return { ...base, outcome: result.outcome, initialInput: result.initialInput, issue: result.issue,
      diskDurability: acknowledged && result.diskDurability === 'confirmed' ? 'confirmed' : 'unconfirmed',
      agent: result.outcome === 'created' ? { agentSessionId: record.agentSessionId, run: result.run, hostId: record.execution.hostId, runtimeId: record.execution.runtimeId! } : null }
  } catch (cause) {
    // The spatial record alone does not acknowledge the original execution write.
    return { ...base, outcome: 'unconfirmed', agent: null, initialInput: 'unknown', diskDurability: 'unconfirmed',
      issue: cause instanceof Error ? cause.message : String(cause) }
  }
}
