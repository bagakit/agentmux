import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import type { HostConfig, HostCreationTrustSnapshot } from '../shared/contracts.js'
import { configValuesEqual } from '../shared/config-edit.js'

type Method = 'settings.hosts.trusted-sources' | 'settings.hosts.trust-source'
type Ports = {
  savedHost(id: string): HostConfig | undefined
  call<M extends Method>(method: M, input: AgentMuxRpcParams<M>): Promise<AgentMuxRpcResult<M>>
}
function route({ label: _label, ...host }: HostConfig): Omit<HostConfig, 'label'> { return host }
function assertSaved(host: HostConfig, ports: Ports): void {
  const saved = ports.savedHost(host.id)
  if (host.kind !== 'ssh' || !saved || !configValuesEqual(route(host), route(saved))) {
    throw new Error('Save this exact connection before reviewing source trust.')
  }
}

/** UI orchestration only: the original public transport and target Core own approval and pins. */
export async function readHostCreationTrust(host: HostConfig, ports: Ports): Promise<HostCreationTrustSnapshot> {
  assertSaved(host, ports)
  const [source, target] = await Promise.all([
    ports.call('settings.hosts.trusted-sources', { hostId: 'local' }),
    ports.call('settings.hosts.trusted-sources', { hostId: host.id })
  ])
  assertSaved(host, ports)
  if (host.kind === 'ssh' && host.runtimeId && target.authority.runtimeId !== host.runtimeId) {
    throw new Error('The target Runtime differs from this saved connection. Review the connection identity first.')
  }
  return { source: source.authority, target }
}

export async function approveHostCreationTrust(host: HostConfig, expected: HostCreationTrustSnapshot, ports: Ports): Promise<HostCreationTrustSnapshot> {
  const current = await readHostCreationTrust(host, ports)
  if (!expected || !configValuesEqual(current.source, expected.source) ||
      !configValuesEqual(current.target.authority, expected.target?.authority)) {
    throw new Error('Source or target identity changed. Review the current fingerprints before approving.')
  }
  const { source, target } = current
  const result = await ports.call('settings.hosts.trust-source', { hostId: host.id, input: {
    sourceRuntimeId: source.runtimeId, publicKey: source.publicKey,
    targetRuntimeId: target.authority.runtimeId, targetKeyFingerprint: target.authority.fingerprint
  } })
  assertSaved(host, ports)
  return { source, target: { routeHostId: result.routeHostId, authority: result.authority,
    sources: [...target.sources.filter(pin => pin.sourceRuntimeId !== source.runtimeId), result.source] } }
}
