import type { IpcMainInvokeEvent } from 'electron'
import { isMoteConnectionMethod, parseMoteConnectionParams } from '@agentmux/core'
import type { ConnectionHostingTarget } from '../shared/contracts.js'
import { connectionHostTarget, type ConnectionHostIpc } from './connection-host-ipc.js'

/** An authenticated client of the original public Mote operation owner. */
export function registerMoteConnectionIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, method: unknown, params: unknown, target?: ConnectionHostingTarget) => Promise<unknown>): void
  assertTrusted(channel: string, event: IpcMainInvokeEvent): void
  runtime: ConnectionHostIpc
}): void {
  options.handleWithEvent('moteConnections:call', async (event, method, value, target) => {
    options.assertTrusted('moteConnections:call', event)
    if (!isMoteConnectionMethod(method)) throw new Error('Unsupported Mote bot operation.')
    const params = parseMoteConnectionParams(method, value)
    return await options.runtime.callConnectionHost(await connectionHostTarget(options.runtime, target), method, params)
  })
}
