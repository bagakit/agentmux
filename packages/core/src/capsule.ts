/** Capsule's portable owner contract is shared with Hosts; Core owns only composition. */
export * from '@agentmux/capsule'
import { CapsuleValidationError, parseCapsuleParams, parseCapsuleResult,
  type CapsuleMethod, type CapsuleParamsMap, type CapsuleResultMap } from '@agentmux/capsule'
import { AgentMuxError } from './errors.js'

/** Preserve the package schema while using the original public wire's request/result errors. */
export function parseCapsuleRpcParams<M extends CapsuleMethod>(method: M, value: unknown): CapsuleParamsMap[M] {
  try { return parseCapsuleParams(method, value) }
  catch (error) {
    if (error instanceof CapsuleValidationError) throw new AgentMuxError(error.message, 'INVALID_CONTROL_REQUEST')
    throw error
  }
}
export function parseCapsuleRpcResult<M extends CapsuleMethod>(method: M, value: unknown, input?: CapsuleParamsMap[M]): CapsuleResultMap[M] {
  try { return parseCapsuleResult(method, value, input) }
  catch (error) {
    if (error instanceof CapsuleValidationError) throw new AgentMuxError(error.message, 'CONTROL_PROTOCOL_ERROR')
    throw error
  }
}
