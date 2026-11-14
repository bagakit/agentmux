import type { IpcMainInvokeEvent } from 'electron'
import { isNodePublishingMethod, parseNodePublishingParams } from '@agentmux/core/node-publishing'
import { SessionHistoryReadOwners } from './session-history-read.js'
import { sessionInputOperationResult } from '../shared/session-input-result.js'

/** Fixed public Node methods. The original Core owns policy, authority, resources and actual IO. */
export function registerNodePublishingIpc(ports: {
  handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...values: T) => R | Promise<R>): void
  call(method: import('@agentmux/core/node-publishing').NodePublishingMethod, params: import('@agentmux/core/node-publishing').NodePublishingParams[import('@agentmux/core/node-publishing').NodePublishingMethod], context: { signal: AbortSignal }): Promise<import('@agentmux/core/node-publishing').NodePublishingResults[import('@agentmux/core/node-publishing').NodePublishingMethod]>
}) {
  const reads = new SessionHistoryReadOwners()
  ports.handle('nodePublishing:call', (event, token: string, method: unknown, input: unknown) => sessionInputOperationResult(() => {
    if (!isNodePublishingMethod(method)) throw new Error('Unknown Node publishing method.')
    const params = parseNodePublishingParams(method, input)
    return reads.read(event.sender, token, signal => ports.call(method, params, { signal }))
  }))
  ports.handle('nodePublishing:cancel', (event, token: string) => reads.cancel(event.sender.id, token))
  return { dispose: () => reads.dispose() }
}
