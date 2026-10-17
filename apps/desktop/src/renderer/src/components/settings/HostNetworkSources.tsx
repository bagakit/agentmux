import type { HostRuntimeSource, NetworkInterfaceAddress } from '@agentmux/core'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { HostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { currentHostNetwork, type HostNetworkRead } from './use-host-network-observation'
import './host-network-panel.css'

export type HostNetworkViewProps = { host: HostConfig; committed?: HostConfig | undefined; active: boolean; visible: boolean; state?: HostNetworkRead | undefined; onRead: (host: HostConfig) => Promise<void> }
const ReadIcon = semanticIconComponent('action.refresh')
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
export function SourceTime({ source, current }: { source: HostRuntimeSource<unknown>; current?: HostRuntimeSource<unknown> | null | undefined }) {
  return <small className="host-network__source-time">{source.state === 'unavailable' ? 'Attempted' : current?.state === 'available' && current.readAt === source.readAt ? 'Read' : 'Last confirmed'} <time dateTime={new Date(source.readAt).toISOString()}>{time(source.readAt)}</time></small>
}
export function SourceIssue({ source }: { source?: HostRuntimeSource<unknown> | null | undefined }) {
  return source?.state === 'unavailable' ? <p className="host-network__issue" role="status">{source.message}</p> : null
}
/** Mirrored read actions share the original target, eligibility and request owner. */
export function NetworkReadButton({ host, committed, active, visible, state, onRead, label = 'Read network details' }: HostNetworkViewProps & { label?: string }) {
  const held = currentHostNetwork(state, host), saved = committed !== undefined && configValuesEqual(host, committed)
  return <button type="button" className="small-button" disabled={!saved || !active || !visible || held?.busy === true}
    onClick={() => { if (committed) void onRead(committed) }} aria-label={label}><ReadIcon size={13} />{held?.busy ? 'Reading…' : held?.latest ? 'Refresh' : 'Read link'}</button>
}
export function NetworkInterfaces({ title, source, current, addresses, identity, sampledAt }: { title: string; source: HostRuntimeSource<unknown>; current?: HostRuntimeSource<unknown> | undefined; addresses: NetworkInterfaceAddress[]; identity: string; sampledAt: number }) {
  const groups = new Map<string, NetworkInterfaceAddress[]>()
  for (const address of addresses) { const group = groups.get(address.name); if (group) group.push(address); else groups.set(address.name, [address]) }
  return <details className="host-network__addresses">
    <summary><span>{title}<small className="host-network__interface-names">{[...groups.keys()].join(' · ') || 'No addressed interfaces reported'}</small></span><small>{groups.size} interfaces · {addresses.length} addresses</small></summary>
    <p className="host-network__hint">{identity}</p>
    <SourceTime source={source} current={current} /><small className="host-network__source-time">Sampled <time dateTime={new Date(sampledAt).toISOString()}>{time(sampledAt)}</time> by this source</small>
    <div className="host-network__address-list">{[...groups].map(([name, group]) => <div key={name} data-network-interface={name}>
      <span><strong>{name}</strong><small>{[...new Set(group.map(address => address.family))].join(' + ')} · {group.every(address => address.internal) ? 'Loopback' : 'Interface'}</small></span>
      <div className="host-network__interface-addresses">{group.map((address, index) => <code key={`${address.address}:${index}`}>{address.cidr ?? address.address}{address.scopeid ? <small> scope {address.scopeid}</small> : null}</code>)}</div>
    </div>)}</div>
    <p className="host-network__hint">Addresses visible in this process’s network namespace. Interface presence does not identify this connection’s egress.</p>
  </details>
}
