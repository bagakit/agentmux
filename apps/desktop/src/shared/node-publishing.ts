import type { NodePublishingMethod, NodePublishingParams, NodePublishingResults } from '@agentmux/core/node-publishing'

/** Desktop selects an existing carrier; Core owner methods remain endpoint-local. */
export type { NodeOwnerTarget } from '@agentmux/core/node-publishing'
export { parseNodeOwnerTarget } from '@agentmux/core/node-publishing'
import type { NodeOwnerTarget } from '@agentmux/core/node-publishing'
export const NODE_OWNER_METHODS = ['settings.node.inspect', 'settings.node.configure', 'settings.node.resources'] as const
export type NodeOwnerMethod = typeof NODE_OWNER_METHODS[number]
export type NodePublicMethod = Exclude<NodePublishingMethod, NodeOwnerMethod>
export type DesktopNodePublishingPort = {
  call<M extends NodePublicMethod>(method: M, params: NodePublishingParams[M], signal?: AbortSignal): Promise<NodePublishingResults[M]>
  owner<M extends NodeOwnerMethod>(target: NodeOwnerTarget, method: M, params: NodePublishingParams[M], signal?: AbortSignal): Promise<NodePublishingResults[M]>
}
