import { AGENTMUX_RPC_CONTROL_METHODS, AGENTMUX_RPC_NATIVE_METHODS, isAgentMuxRpcMethod, type AgentMuxRpcMethod } from '@agentmux/core'
import { isStandaloneBrowserObjectMethod } from '../shared/browser-object-host-policy.js'

/** Expose the normal Desktop service, excluding lifecycle methods it has no object-only owner for. */
export function desktopRpcMethods(): ReadonlySet<AgentMuxRpcMethod> {
  return new Set(Object.keys({ ...AGENTMUX_RPC_CONTROL_METHODS, ...AGENTMUX_RPC_NATIVE_METHODS })
    .filter(isAgentMuxRpcMethod).filter(method => !isStandaloneBrowserObjectMethod(method)))
}
