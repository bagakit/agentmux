import type { IpcMainInvokeEvent } from 'electron'
import { connectAgentMuxRpc, type AgentMuxRpcParams, type AgentMuxRpcResult } from '@agentmux/core'
import type { ConnectionMethod } from '@agentmux/core/connections'
import type { DesktopConnectorSecrets } from './connector-secrets.js'

export type ConnectorIpcChannel = 'connections:call' | 'connections:storeCredential' | 'connections:inspectCredential'
/** Settings calls the same public service as CLI; only local credential entry stays off public wire. */
export function registerConnectorIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>): void
  assertTrusted(channel: ConnectorIpcChannel, event: IpcMainInvokeEvent): void
  socketPath: string
  secrets: Pick<DesktopConnectorSecrets, 'store' | 'inspect'>
  connect?: typeof connectAgentMuxRpc
}): void {
  options.handleWithEvent('connections:call', async (event, method: ConnectionMethod, params: unknown) => {
    options.assertTrusted('connections:call', event)
    if (!['connection.ls', 'connection.inspect', 'connection.configure', 'connection.test'].includes(method)) throw new Error('Unsupported connection operation.')
    const client = await (options.connect ?? connectAgentMuxRpc)({ endpoint: { transport: 'unix', path: options.socketPath } })
    try { return await client.call(method, params as AgentMuxRpcParams<ConnectionMethod>) as AgentMuxRpcResult<ConnectionMethod> }
    finally { await client.dispose() }
  })
  options.handleWithEvent('connections:storeCredential', async (event, input: { operationId: string; secret: string }) => {
    options.assertTrusted('connections:storeCredential', event)
    return await options.secrets.store(input)
  })
  options.handleWithEvent('connections:inspectCredential', async (event, operationId: string) => {
    options.assertTrusted('connections:inspectCredential', event)
    return await options.secrets.inspect(operationId)
  })
}
