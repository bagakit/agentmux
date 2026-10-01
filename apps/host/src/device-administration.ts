import type { AgentMuxRpcDeviceAdministration, AgentMuxRpcDeviceMethod, AgentMuxRpcDeviceParams,
  AgentMuxRpcDeviceResult, AgentMuxRpcCallContext, AgentMuxRpcPrivateAccessState } from '@agentmux/core'
import type { DeviceAuthority } from './device-authority.js'
import { DeviceManagement } from './device-management.js'
import type { MacDeviceConfirmation } from './mac-device-confirmation.js'

/** The sole Host lends its original Authority and OS confirmation to the finite public port. */
export function createDeviceAdministration(authority: Promise<DeviceAuthority>,
  confirm?: MacDeviceConfirmation, privateAccessState?: () => AgentMuxRpcPrivateAccessState): AgentMuxRpcDeviceAdministration {
  const owner = authority.then(value => new DeviceManagement(value, confirm))
  // A malformed private identity belongs to device access, not Unix/Core startup.
  void owner.catch(() => {})
  const methods: { [M in AgentMuxRpcDeviceMethod]: (
    params: AgentMuxRpcDeviceParams<M>, context: AgentMuxRpcCallContext
  ) => Promise<AgentMuxRpcDeviceResult<M>> } = {
    'device.ls': async (params, context) => {
      // Keep the original permission/Authority read outside the observation fallback.
      const facts = await (await owner).ls(params, context)
      context.signal?.throwIfAborted()
      let privateAccess: AgentMuxRpcPrivateAccessState = { state: 'unavailable',
        message: 'The original Host private-access observation is unavailable. Device facts and Unix diagnostics remain available.' }
      try { if (privateAccessState) privateAccess = privateAccessState() }
      catch { /* Only this observation is unconfirmed; retain the authorized Authority facts. */ }
      return { ...facts, privateAccess }
    },
    'device.invite': async (params, context) => await (await owner).invite(params, context),
    'device.approve': async (params, context) => await (await owner).approve(params, context),
    'device.reject': async (params, context) => await (await owner).reject(params, context),
    'device.revoke': async (params, context) => await (await owner).revoke(params, context)
  }
  return { call: async <M extends AgentMuxRpcDeviceMethod>(method: M, params: AgentMuxRpcDeviceParams<M>,
    context: AgentMuxRpcCallContext): Promise<AgentMuxRpcDeviceResult<M>> => {
    // The finite mapped table preserves each SDK-derived tuple. Only this indexed
    // dispatch needs correlation; no public DTO or broader Core client is cast.
    const invoke = methods[method] as (input: AgentMuxRpcDeviceParams<M>,
      context: AgentMuxRpcCallContext) => Promise<AgentMuxRpcDeviceResult<M>>
    return await invoke(params, context)
  } }
}
