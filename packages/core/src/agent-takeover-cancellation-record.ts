import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import type { AgentTakeoverCancellationInput } from './agent-takeover-cancellation.js'

export const TAKEOVER_CANCELLATION_RESOURCE = 'core:takeover-cancellations'
export type TakeoverCancellationAdmission = {
  input: AgentTakeoverCancellationInput
  actor: { kind: 'user' | 'device'; id: string }
}
export function takeoverCancellationRecord(graph: Pick<import('./spatial-graph.js').AgentMuxSpatialGraph, 'resources'>, createOperationId: string): TakeoverCancellationAdmission | null {
  const document = graph.resources[TAKEOVER_CANCELLATION_RESOURCE]
  if (document === undefined) return null
  const p = rpcRecord(document)
  const value = Object.hasOwn(p, createOperationId) ? p[createOperationId] : undefined
  if (value === undefined) return null
  try {
    const r = rpcRecord(value, ['input','actor']), input = rpcRecord(r.input, ['expectedRuntimeId','operationId','request'])
    const request = rpcRecord(input.request, ['operationId','destination','content','focus']), content = rpcRecord(request.content)
    const actor = rpcRecord(r.actor, ['kind','id'])
    const runtimeId = rpcString(input.expectedRuntimeId, 'Original cancellation Runtime'), operationId = rpcString(input.operationId, 'Original cancellation')
    const original = rpcString(request.operationId, 'Original Takeover')
    if (original !== createOperationId || original === operationId || content.kind !== 'takeover-agent' || !['user','device'].includes(String(actor.kind))) throw new Error('The original cancellation references changed.')
    return { input: { ...input, expectedRuntimeId: runtimeId, operationId } as AgentTakeoverCancellationInput,
      actor: { kind: actor.kind as 'user'|'device', id: rpcString(actor.id, 'Original cancellation actor') } }
  } catch {
    throw new AgentMuxError('The original cancellation admission is unconfirmed. Preserve its exact operation and repair its original record.', 'AGENT_TAKEOVER_CANCELLATION_UNCONFIRMED')
  }
}
