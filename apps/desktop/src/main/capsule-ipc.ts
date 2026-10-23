import { AgentMuxError, type AgentMuxRpcCallContext, type AgentMuxRpcMethod, type AgentMuxRpcParams, type AgentMuxRpcResult } from '@agentmux/core'
import { isCapsuleMethod, parseCapsuleRpcParams, parseCapsuleRpcResult, type CapsuleMethod } from '@agentmux/core/capsule'

type OriginalCore = <M extends AgentMuxRpcMethod>(hostId: string, method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext) => Promise<AgentMuxRpcResult<M>>

/** Called only after the original App sender check. This is a narrow domain adapter, never a new owner. */
export async function callCapsuleFromApp(callOriginalCore: OriginalCore, method: unknown, value: unknown) {
  if (!isCapsuleMethod(method)) throw new AgentMuxError('Unsupported Capsule operation.', 'INVALID_CONTROL_REQUEST')
  const capsuleMethod: CapsuleMethod = method
  const params = parseCapsuleRpcParams(capsuleMethod, value)
  const result = await callOriginalCore<CapsuleMethod>('local', capsuleMethod, params, {
    transport: 'unix', principal: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` }
  })
  return parseCapsuleRpcResult(capsuleMethod, result, params)
}
