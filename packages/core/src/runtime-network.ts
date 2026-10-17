import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { AgentMuxError } from './errors.js'
import { parseHostedRuntimeOwnerIdentity } from './hosted-value.js'
import type { AgentMuxRuntimeFence, AgentMuxRuntimeOwnerIdentity } from './hosted-client-contract.js'

/** One address in the observing process's network namespace; never a connected peer or public egress. */
export type NetworkInterfaceAddress = {
  name: string
  address: string
  family: 'IPv4' | 'IPv6'
  cidr: string | null
  internal: boolean
  scopeid: number | null
}
export type RuntimeNetworkSnapshot = {
  owner: AgentMuxRuntimeOwnerIdentity
  /** Producer wall-clock sample time; elapsed request time belongs to the observer. */
  observedAt: number
  interfaces: NetworkInterfaceAddress[]
}

/** Reads only this process's OS network namespace. Does not connect or inspect Agent Sessions. */
export function readNetworkInterfaces(): NetworkInterfaceAddress[] {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) => (addresses ?? []).map(address => ({
    name, address: address.address, family: address.family, cidr: address.cidr, internal: address.internal,
    scopeid: address.family === 'IPv6' ? address.scopeid ?? null : null
  }))).sort((a, b) => a.name.localeCompare(b.name) || a.family.localeCompare(b.family) || a.address.localeCompare(b.address))
}

function invalid(): never { throw new AgentMuxError('Network observation is malformed or belongs to another Runtime owner.', 'CONTROL_PROTOCOL_ERROR') }
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid()
  return value as Record<string, unknown>
}
function count(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid() }

export function parseNetworkInterfaces(value: unknown): NetworkInterfaceAddress[] {
  if (!Array.isArray(value)) invalid()
  for (const item of value) {
    const p = record(item, ['name', 'address', 'family', 'cidr', 'internal', 'scopeid'])
    if (typeof p.name !== 'string' || !p.name || p.name.includes('\0') || typeof p.address !== 'string' ||
        p.family !== 'IPv4' && p.family !== 'IPv6' || isIP(p.address) !== (p.family === 'IPv4' ? 4 : 6) || typeof p.internal !== 'boolean') invalid()
    if (p.cidr !== null) {
      if (typeof p.cidr !== 'string') invalid()
      const [address, prefix, extra] = p.cidr.split('/')
      if (address !== p.address || extra !== undefined || prefix === undefined || !/^(0|[1-9]\d*)$/u.test(prefix) ||
          Number(prefix) > (p.family === 'IPv4' ? 32 : 128)) invalid()
    }
    if (p.scopeid !== null) { count(p.scopeid); if (p.family !== 'IPv6') invalid() }
  }
  return value as NetworkInterfaceAddress[]
}

export function parseRuntimeNetworkSnapshot(value: unknown, fence: AgentMuxRuntimeFence): RuntimeNetworkSnapshot {
  const p = record(value, ['owner', 'observedAt', 'interfaces'])
  const owner = parseHostedRuntimeOwnerIdentity(p.owner)
  if (owner.runtimeId !== fence.runtimeId || owner.ownerInstanceId !== fence.ownerInstanceId) invalid()
  count(p.observedAt); parseNetworkInterfaces(p.interfaces)
  return value as RuntimeNetworkSnapshot
}
