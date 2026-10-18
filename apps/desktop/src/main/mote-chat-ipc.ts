import { sessionInputOperationResult } from '../shared/session-input-result.js'
import type { IpcMainInvokeEvent } from 'electron'
import { connectAgentMuxRpc } from '@agentmux/core'
import { isMoteChatMethod, parseMoteChatParams } from '@agentmux/core/mote-chat'

/** Trusted presentation calls the same original public chat owner as connected devices. */
export function registerMoteChatIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, method: unknown, params: unknown) => Promise<unknown>): void
  assertTrusted(channel: string, event: IpcMainInvokeEvent): void
  socketPath: string
}): void {
  options.handleWithEvent('moteChat:call', async (event, method, value) => {
    options.assertTrusted('moteChat:call', event)
    if (!isMoteChatMethod(method)) throw new Error('Unsupported Mote chat operation.')
    const params = parseMoteChatParams(method, value)
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.socketPath } })
    try { return await sessionInputOperationResult(() => client.call(method, params)) }
    finally { await client.dispose() }
  })
}
