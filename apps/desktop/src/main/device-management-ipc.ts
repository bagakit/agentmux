import type { IpcMainInvokeEvent } from 'electron'
import { connectAgentMuxRpc, defaultAgentMuxControlSocketPath, type AgentMuxRpcClient,
  type AgentMuxRpcParams, type AgentMuxRpcResult } from '@agentmux/core'

type DeviceMethod = 'device.link' | 'device.ls' | 'device.revoke'
export type DeviceManagementIpcChannel = 'deviceManagement:link' | 'deviceManagement:ls' | 'deviceManagement:revoke'
type DeviceCall = <M extends DeviceMethod>(method: M, params: AgentMuxRpcParams<M>) => Promise<AgentMuxRpcResult<M>>

/** The trusted Desktop borrows the original Host device methods. */
export function registerDeviceManagementIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, params: unknown) => Promise<unknown>): void
  assertTrusted(channel: DeviceManagementIpcChannel, event: IpcMainInvokeEvent): void
  socketPath?: string
  connect?: typeof connectAgentMuxRpc
}): void {
  const call: DeviceCall = async (method, params) => {
    const client: AgentMuxRpcClient = await (options.connect ?? connectAgentMuxRpc)({
      endpoint: { transport: 'unix', path: options.socketPath ?? defaultAgentMuxControlSocketPath() }
    })
    try { return await client.call(method, params) }
    finally { await client.dispose() }
  }
  // No Renderer principal/confirmation claim and no second parameter validator/dispatcher.
  const register = <M extends DeviceMethod>(channel: DeviceManagementIpcChannel, method: M) => {
    options.handleWithEvent(channel, async (event, params) => {
      options.assertTrusted(channel, event)
      return await call(method, params as AgentMuxRpcParams<M>)
    })
  }
  register('deviceManagement:link', 'device.link')
  register('deviceManagement:ls', 'device.ls')
  register('deviceManagement:revoke', 'device.revoke')
}
