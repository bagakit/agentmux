import type { SshNetworkConfiguration } from '@agentmux/core'
import type { HostConfig } from '../../../../shared/contracts'
import { currentHostNetwork, type HostNetworkRead } from './use-host-network-observation'

export const networkDuration = (ms: number) => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: ms < 10 ? 1 : 0 }).format(ms)} ms`
export function hostNetworkView(host: HostConfig, state: HostNetworkRead | undefined) {
  const held = currentHostNetwork(state, host), latest = held?.error ? undefined : held?.latest, retained = held?.retained
  return { held, latest, retained,
    target: retained?.target.state === 'available' ? retained.target.value : undefined,
    policy: retained?.ssh?.state === 'available' ? retained.ssh.value : undefined,
    observer: retained?.observer.state === 'available' ? retained.observer.value : undefined,
    partial: latest && [latest.observer, latest.target, latest.ssh].some(source => source?.state === 'unavailable') }
}
export type NetworkPathStep = { id: string; kind: 'origin' | 'jump' | 'proxy' | 'unknown' | 'destination'; label: string; address: string; detail: string }
/** A configuration projection, never a measured socket path or a list of managed Hosts. */
export function configuredNetworkPath(host: HostConfig, policy: SshNetworkConfiguration | undefined): NetworkPathStep[] {
  const steps: NetworkPathStep[] = [{ id: 'origin', kind: 'origin', label: 'Connection service', address: 'Observation origin', detail: 'Source process namespace' }]
  if (host.kind === 'ssh' && !policy) steps.push({ id: 'unknown', kind: 'unknown', label: 'Route not observed', address: 'SSH configuration unavailable', detail: 'Read this saved connection to inspect its path' })
  if (policy) {
    for (const [index, jump] of policy.jumps.entries()) steps.push({ id: `jump:${index}`, kind: 'jump', label: 'Configured SSH jump', address: jump.host,
      detail: `User ${jump.user ?? 'SSH config'} · Port ${jump.port ?? 'SSH config'}` })
    if (policy.proxy === 'command') steps.push({ id: 'proxy', kind: 'proxy', label: 'Custom proxy', address: 'Internal path unknown', detail: 'Opaque proxy command · no inferred intermediaries' })
  }
  steps.push({ id: 'destination', kind: 'destination', label: host.label,
    address: host.kind === 'local' ? 'Host-local execution' : policy ? policy.hostname : host.hostname,
    detail: host.kind === 'local' ? 'Local route' : policy ? `${policy.user} · Port ${policy.port}` : 'Configured destination' })
  return steps
}
/** The fleet text and selected detail consume the same held observation. */
export function hostNetworkSummary(state: HostNetworkRead | undefined): string | null {
  const target = state?.retained?.target, ssh = state?.retained?.ssh
  if (target?.state !== 'available') return null
  const retained = state?.latest?.target.state !== 'available' || state?.latest?.ssh?.state === 'unavailable' || state?.error !== undefined
  return `${retained ? 'Last confirmed · ' : ''}Owner request ${networkDuration(target.value.requestDurationMs)}${ssh?.state === 'available' && ssh.value.jumps.length ? ` · ${ssh.value.jumps.length} configured jumps` : ''}`
}
