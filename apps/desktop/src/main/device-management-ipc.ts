import { randomBytes } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { connectAgentMuxRpc, defaultAgentMuxControlSocketPath, type AgentMuxRpcClient,
  type AgentMuxRpcParams, type AgentMuxRpcResult } from '@agentmux/core'

type DeviceMethod = 'device.link' | 'device.ls' | 'device.invite' | 'device.approve' | 'device.reject' | 'device.revoke'
export type DeviceManagementIpcChannel = 'deviceManagement:link' | 'deviceManagement:ls' | 'deviceManagement:invite' | 'deviceManagement:approve' | 'deviceManagement:reject' | 'deviceManagement:revoke'
type DeviceCall = <M extends DeviceMethod>(method: M, params: AgentMuxRpcParams<M>) => Promise<AgentMuxRpcResult<M>>

/** The original trusted Desktop can request a dialog; only the original Host confirms it. */
export function registerDeviceManagementIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, params: unknown) => Promise<unknown>): void
  assertTrusted(channel: DeviceManagementIpcChannel, event: IpcMainInvokeEvent): void
  socketPath?: string
  connect?: typeof connectAgentMuxRpc
}): { consume(intent: string): boolean } {
  const intents = new Map<string, number>()
  const consume = (intent: string) => {
    const expiry = intents.get(intent); intents.delete(intent)
    return expiry !== undefined && expiry > Date.now()
  }
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
  options.handleWithEvent('deviceManagement:link', async (event) => {
    options.assertTrusted('deviceManagement:link', event)
    for (const [key, expires] of intents) if (expires <= Date.now()) intents.delete(key)
    const intent = randomBytes(32).toString('base64url')
    intents.set(intent, Date.now() + 30_000)
    try { return await call('device.link', { intent }) } finally { intents.delete(intent) }
  })
  register('deviceManagement:ls', 'device.ls')
  register('deviceManagement:invite', 'device.invite')
  register('deviceManagement:approve', 'device.approve')
  register('deviceManagement:reject', 'device.reject')
  register('deviceManagement:revoke', 'device.revoke')
  return { consume }
}
