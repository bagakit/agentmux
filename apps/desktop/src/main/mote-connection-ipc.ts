import type { IpcMainInvokeEvent } from 'electron'
import { connectAgentMuxRpc, isMoteConnectionMethod, parseMoteConnectionParams } from '@agentmux/core'

/** An authenticated client of the original public Mote operation owner. */
export function registerMoteConnectionIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, method: unknown, params: unknown) => Promise<unknown>): void
  assertTrusted(channel: string, event: IpcMainInvokeEvent): void
  socketPath: string
}): void {
  options.handleWithEvent('moteConnections:call', async (event, method, value) => {
    options.assertTrusted('moteConnections:call', event)
    if (!isMoteConnectionMethod(method)) throw new Error('Unsupported Mote bot operation.')
    const params = parseMoteConnectionParams(method, value)
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.socketPath } })
    try { return await client.call(method, params) }
    finally { await client.dispose() }
  })
}
