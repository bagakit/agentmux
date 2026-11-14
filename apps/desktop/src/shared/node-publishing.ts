import type { NodePublishingMethod, NodePublishingParams, NodePublishingResults } from '@agentmux/core/node-publishing'

/** Desktop selects an existing carrier; Core owner methods remain endpoint-local. */
export type NodeOwnerTarget = { hostId: string; expectedRuntimeId: string }
export const NODE_OWNER_METHODS = ['settings.node.inspect', 'settings.node.configure', 'settings.node.resources'] as const
export type NodeOwnerMethod = typeof NODE_OWNER_METHODS[number]
export type NodePublicMethod = Exclude<NodePublishingMethod, NodeOwnerMethod>
export type DesktopNodePublishingPort = {
  call<M extends NodePublicMethod>(method: M, params: NodePublishingParams[M], signal?: AbortSignal): Promise<NodePublishingResults[M]>
  owner<M extends NodeOwnerMethod>(target: NodeOwnerTarget, method: M, params: NodePublishingParams[M], signal?: AbortSignal): Promise<NodePublishingResults[M]>
}
export function parseNodeOwnerTarget(value: unknown): NodeOwnerTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Select an original saved Node target.')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some(key => key !== 'hostId' && key !== 'expectedRuntimeId') ||
      typeof fields.hostId !== 'string' || !fields.hostId || /[\0\r\n]/u.test(fields.hostId) ||
      typeof fields.expectedRuntimeId !== 'string' || !fields.expectedRuntimeId || /[\0\r\n]/u.test(fields.expectedRuntimeId)) throw new Error('Select an exact Host and original Runtime identity.')
  return { hostId: fields.hostId, expectedRuntimeId: fields.expectedRuntimeId }
}
