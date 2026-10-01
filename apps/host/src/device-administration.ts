import type { AgentMuxRpcDeviceAdministration, AgentMuxRpcDeviceMethod, AgentMuxRpcDeviceParams,
  AgentMuxRpcDeviceResult, AgentMuxRpcCallContext } from '@agentmux/core'
import type { DeviceAuthority } from './device-authority.js'
import { DeviceManagement } from './device-management.js'
import type { MacDeviceConfirmation } from './mac-device-confirmation.js'

/** The sole Host lends its original Authority and OS confirmation to the finite public port. */
export function createDeviceAdministration(authority: Promise<DeviceAuthority>,
  confirm?: MacDeviceConfirmation): AgentMuxRpcDeviceAdministration {
  const owner = authority.then(value => new DeviceManagement(value, confirm))
  // A malformed private identity belongs to device access, not Unix/Core startup.
  void owner.catch(() => {})
  const methods: { [M in AgentMuxRpcDeviceMethod]: (
    params: AgentMuxRpcDeviceParams<M>, context: AgentMuxRpcCallContext
  ) => Promise<AgentMuxRpcDeviceResult<M>> } = {
    'device.ls': async (params, context) => await (await owner).ls(params, context),
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
