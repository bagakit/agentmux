import type { NodeResources } from '@agentmux/core/node-publishing'
import type { HostConfig } from '../../../../shared/contracts'
import type { DesktopNodePublishingPort } from '../../../../shared/node-publishing'

export type ClusterResourceRead = { reply: NodeResources; access: 'private' | 'published'; privateIssue?: string }
export function clusterHostKey({ label: _label, ...host }: HostConfig): string { return JSON.stringify(host) }
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const interval = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted()
  const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 600)
  signal.addEventListener('abort', abort, { once: true })
})

/** A visible, explicit read of one saved carrier. No policy writes or background sampler. */
export async function observeClusterResources(host: HostConfig, port: DesktopNodePublishingPort, signal: AbortSignal,
  publish: (read: ClusterResourceRead) => void, originalRuntimeId?: string): Promise<void> {
  let runtimeId = host.kind === 'ssh' ? host.runtimeId : undefined
  runtimeId ??= originalRuntimeId
  if (!runtimeId) {
    const original = await port.call('node.inspect', { hostId: host.id }, signal)
    signal.throwIfAborted()
    runtimeId = original.node.runtimeId
  }
  let access: 'private' | 'published' = 'private', privateIssue: string | undefined
  const read = async (): Promise<ClusterResourceRead> => {
    signal.throwIfAborted()
    let reply: NodeResources
    if (access === 'private') {
      try { reply = await port.owner({ hostId: host.id, expectedRuntimeId: runtimeId! }, 'settings.node.resources', {}, signal) }
      catch (cause) { signal.throwIfAborted(); privateIssue = message(cause); access = 'published'; reply = await port.call('node.resources', { hostId: host.id, expectedRuntimeId: runtimeId! }, signal) }
    } else reply = await port.call('node.resources', { hostId: host.id, expectedRuntimeId: runtimeId! }, signal)
    signal.throwIfAborted()
    if (reply.node.runtimeId !== runtimeId || reply.status === 'available' && (reply.sample.node.runtimeId !== reply.node.runtimeId || reply.sample.node.ownerInstanceId !== reply.node.ownerInstanceId || reply.sample.policyRevision !== reply.policyRevision)) {
      throw new Error('Measurements belong to another original Runtime or resource revision. This saved connection is retained.')
    }
    return { reply, access, ...(privateIssue ? { privateIssue } : {}) }
  }
  const first = await read(); publish(first)
  // Cumulative CPU counters need an actual interval. This finite second sample
  // belongs to the same explicit read, not a recurring monitoring clock.
  if (first.reply.status !== 'available') return
  await interval(signal)
  publish(await read())
}
