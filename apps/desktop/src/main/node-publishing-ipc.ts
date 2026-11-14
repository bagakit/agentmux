import type { IpcMainInvokeEvent } from 'electron'
import { isNodePublishingMethod, parseNodePublishingParams } from '@agentmux/core/node-publishing'
import { NODE_OWNER_METHODS, parseNodeOwnerTarget, type NodeOwnerMethod, type NodeOwnerTarget } from '../shared/node-publishing.js'
import { SessionHistoryReadOwners } from './session-history-read.js'
import { sessionInputOperationResult } from '../shared/session-input-result.js'

/** Fixed public Node methods. The original Core owns policy, authority, resources and actual IO. */
export function registerNodePublishingIpc(ports: {
  handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...values: T) => R | Promise<R>): void
  owner(target: NodeOwnerTarget, method: NodeOwnerMethod, params: import('@agentmux/core/node-publishing').NodePublishingParams[NodeOwnerMethod], context: { signal: AbortSignal }): Promise<import('@agentmux/core/node-publishing').NodePublishingResults[NodeOwnerMethod]>
  call(method: import('@agentmux/core/node-publishing').NodePublishingMethod, params: import('@agentmux/core/node-publishing').NodePublishingParams[import('@agentmux/core/node-publishing').NodePublishingMethod], context: { signal: AbortSignal }): Promise<import('@agentmux/core/node-publishing').NodePublishingResults[import('@agentmux/core/node-publishing').NodePublishingMethod]>
}) {
  const reads = new SessionHistoryReadOwners()
  ports.handle('nodePublishing:call', (event, token: string, method: unknown, input: unknown) => sessionInputOperationResult(() => {
    if (!isNodePublishingMethod(method) || NODE_OWNER_METHODS.some(owner => owner === method)) throw new Error('Unknown Node publishing method.')
    const params = parseNodePublishingParams(method, input)
    return reads.read(event.sender, token, signal => ports.call(method, params, { signal }))
  }))
  ports.handle('nodePublishing:owner', (event, token: string, target: unknown, method: unknown, input: unknown) => sessionInputOperationResult(() => {
    if (!NODE_OWNER_METHODS.some(owner => owner === method)) throw new Error('Unknown Node owner method.')
    const ownerMethod = method as NodeOwnerMethod, original = parseNodeOwnerTarget(target), params = parseNodePublishingParams(ownerMethod, input)
    return reads.read(event.sender, token, signal => ports.owner(original, ownerMethod, params, { signal }))
  }))
  ports.handle('nodePublishing:cancel', (event, token: string) => reads.cancel(event.sender.id, token))
  return { dispose: () => reads.dispose() }
}
