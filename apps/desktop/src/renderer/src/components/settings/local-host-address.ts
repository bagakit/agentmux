import type { NetworkInterfaceAddress } from '@agentmux/core'
import type { HostNetworkRead } from './use-host-network-observation'

export type LocalHostAddress = {
  state: 'reading' | 'unknown' | 'empty' | 'available'
  label: string
  preferred?: NetworkInterfaceAddress
  addresses: NetworkInterfaceAddress[]
  observedAt?: number
  source?: string
  detail?: string
}
/** A reading preference over observed interface facts, never an egress or reachability claim. */
function rank(address: NetworkInterfaceAddress): number {
  const linkLocal = address.family === 'IPv4' && address.address.startsWith('169.254.')
  const physical = /^(en\d|eth\d|eno\d|ens\d|enp\d|wlan\d|wlp\d)/u.test(address.name)
  const tunnel = /^(utun|tun|tap|wg|tailscale|ppp|ipsec|docker|veth|bridge)/u.test(address.name)
  return (address.family === 'IPv4' ? 0 : 10) + (linkLocal ? 6 : 0) + (physical ? 0 : tunnel ? 4 : 2)
}
export function localHostAddress(read: HostNetworkRead | undefined): LocalHostAddress {
  if (read?.busy) return { state: 'reading', label: 'Reading local address…', addresses: [] }
  const target = read?.latest?.target
  if (read?.error || target?.state !== 'available') return { state: 'unknown', label: 'Local address unknown', addresses: [],
    detail: read?.error ?? (target?.state === 'unavailable' ? target.message : 'Local interface facts have not been read.') }
  const sample = target.value.sample
  const addresses = sample.interfaces.filter(address => !address.internal).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
  const preferred = addresses.find(address => address.family === 'IPv4')
  return { state: preferred ? 'available' : 'empty', label: preferred?.address ?? 'No LAN IPv4 address',
    ...(preferred ? { preferred } : {}), addresses, observedAt: sample.observedAt, source: sample.owner.runtimeId }
}
