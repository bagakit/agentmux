import { sessionInputOperationResult } from '../shared/session-input-result.js'
import type { IpcMainInvokeEvent } from 'electron'
import { isMoteChatMethod, parseMoteChatParams } from '@agentmux/core/mote-chat'
import type { ConnectionHostingTarget } from '../shared/contracts.js'
import { connectionHostTarget, type ConnectionHostIpc } from './connection-host-ipc.js'

/** Trusted presentation calls the same original public chat owner as connected devices. */
export function registerMoteChatIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, method: unknown, params: unknown, target?: ConnectionHostingTarget) => Promise<unknown>): void
  assertTrusted(channel: string, event: IpcMainInvokeEvent): void
  runtime: ConnectionHostIpc
}): void {
  options.handleWithEvent('moteChat:call', async (event, method, value, target) => {
    options.assertTrusted('moteChat:call', event)
    if (!isMoteChatMethod(method)) throw new Error('Unsupported Mote chat operation.')
    const params = parseMoteChatParams(method, value)
    return await sessionInputOperationResult(async () => options.runtime.callConnectionHost(await connectionHostTarget(options.runtime, target), method, params))
  })
}
