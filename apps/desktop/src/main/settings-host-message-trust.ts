import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import type { HostConfig, SshHostConfig, HostMessageTrustSnapshot, HostMessageTrustDirection } from '../shared/contracts.js'
import { configValuesEqual } from '../shared/config-edit.js'

type Method = 'settings.hosts.message-trusted-sources' | 'settings.hosts.trust-message-source'
type Ports = {
  savedHost(id: string): HostConfig | undefined
  call<M extends Method>(method: M, input: AgentMuxRpcParams<M>): Promise<AgentMuxRpcResult<M>>
}
function assertSaved(host: HostConfig, ports: Ports): asserts host is SshHostConfig {
  const saved = ports.savedHost(host.id)
  const { label: _label, ...route } = host
  const { label: _savedLabel, ...savedRoute } = saved ?? {}
  if (host.kind !== 'ssh' || !saved || !configValuesEqual(route, savedRoute)) {
    throw new Error('Save this exact connection before reviewing message trust.')
  }
}

/** Carries the real user approval to the original target Core; never signs as an Agent. */
export async function readHostMessageTrust(host: HostConfig, ports: Ports): Promise<HostMessageTrustSnapshot> {
  assertSaved(host, ports)
  const [local, remote] = await Promise.all([
    ports.call('settings.hosts.message-trusted-sources', { hostId: 'local' }),
    ports.call('settings.hosts.message-trusted-sources', { hostId: host.id })
  ])
  assertSaved(host, ports)
  if (host.runtimeId && remote.authority.runtimeId !== host.runtimeId) {
    throw new Error('The remote Runtime differs from this saved connection. Review its identity first.')
  }
  return { local, remote }
}

export async function approveHostMessageTrust(host: HostConfig, expected: HostMessageTrustSnapshot,
  direction: HostMessageTrustDirection, ports: Ports): Promise<HostMessageTrustSnapshot> {
  if (direction !== 'outbound' && direction !== 'inbound') throw new Error('Choose the exact message trust direction.')
  const current = await readHostMessageTrust(host, ports)
  if (!expected || !configValuesEqual(current.local.authority, expected.local?.authority) ||
    !configValuesEqual(current.remote.authority, expected.remote?.authority)) {
    throw new Error('The Runtime identity changed. Review both current fingerprints before approving.')
  }
  const source = direction === 'outbound' ? current.local.authority : current.remote.authority
  const target = direction === 'outbound' ? current.remote : current.local
  const result = await ports.call('settings.hosts.trust-message-source', {
    hostId: direction === 'outbound' ? host.id : 'local', input: {
      sourceRuntimeId: source.runtimeId, publicKey: source.publicKey,
      targetRuntimeId: target.authority.runtimeId, targetKeyFingerprint: target.authority.fingerprint
    }
  })
  assertSaved(host, ports)
  const updated = { ...target, authority: result.authority,
    sources: [...target.sources.filter(pin => pin.sourceRuntimeId !== source.runtimeId), result.source] }
  return direction === 'outbound' ? { ...current, remote: updated } : { ...current, local: updated }
}
