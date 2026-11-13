import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import { isLocalNetworkHost } from '@agentmux/relay/offer'
import type { AgentMuxRpcMobileLinkCandidate } from '@agentmux/core'

const run = promisify(execFile)
type Interfaces = ReturnType<typeof networkInterfaces>

/** The interface carrying the default route, when the OS reports it. Unknown keeps the plain order. */
export async function defaultRouteInterface(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await run('/sbin/route', ['-n', 'get', 'default'], { timeout: 1500 })
    return /^\s*interface:\s*(\S+)\s*$/mu.exec(stdout)?.[1] ?? null
  } catch { return null }
}

/** Parses `networksetup -listallhardwareports` into port labels keyed by device. */
export function parsePortLabels(stdout: string): ReadonlyMap<string, string> {
  const labels = new Map<string, string>()
  for (const block of stdout.split(/\n\s*\n/u)) {
    const port = /Hardware Port:\s*(.+)/u.exec(block)?.[1]?.trim(), device = /Device:\s*(\S+)/u.exec(block)?.[1]
    if (port && device) labels.set(device, port)
  }
  return labels
}

/**
 * OS port labels such as "Wi-Fi" or "USB 10/100/1000 LAN". They change only with hardware, so one
 * successful read serves the Host's lifetime and a slow or failed read never makes two links for
 * the same address disagree; until a read succeeds, labels stay absent.
 */
export function createInterfacePortLabels(read: () => Promise<string> = async () =>
  (await run('/usr/sbin/networksetup', ['-listallhardwareports'], { timeout: 3000 })).stdout): (wanted?: readonly string[]) => Promise<ReadonlyMap<string, string>> {
  let known: ReadonlyMap<string, string> | null = null, pending: Promise<ReadonlyMap<string, string>> | null = null
  // A USB or Thunderbolt adapter plugged in later is new hardware, so a wanted adapter missing from the
  // last good read asks again; otherwise the last good read is reused and two links agree.
  return async (wanted = []) => {
    if (process.platform !== 'darwin') return new Map()
    if (known && wanted.every(name => known!.has(name))) return known
    pending ??= read().then(stdout => { const labels = parsePortLabels(stdout); if (labels.size) known = labels; return known ?? labels })
      .catch(() => known ?? new Map<string, string>()).finally(() => { pending = null })
    return pending
  }
}

/** Virtual tunnels (VPN, PPP, IPsec) can carry the default route, but a phone on the same Wi-Fi cannot reach them. */
const TUNNEL = /^(utun|ppp|ipsec|tun|tap|gif|stf)\d*/u

/**
 * Local-network IPv4 addresses a phone could use, preferred first: the default-route adapter, then
 * wired and wireless adapters, then the rest, then virtual tunnels even when they carry the default
 * route; link-local addresses go last. Only the local adapter is
 * described; reachability from the phone is not claimed.
 */
export function mobileLinkCandidates(interfaces: Interfaces, defaultInterface: string | null,
  labels: ReadonlyMap<string, string> = new Map()): AgentMuxRpcMobileLinkCandidate[] {
  const rank = (name: string, address: string) => (address.startsWith('169.254.') ? 4 : 0) +
    (TUNNEL.test(name) ? 3 : name === defaultInterface ? 0 : /^(en|eth|wlan)/u.test(name) ? 1 : 2)
  const seen = new Set<string>()
  const rows = Object.entries(interfaces).flatMap(([name, list]) => (list ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && isLocalNetworkHost(entry.address))
    .map(entry => ({ name, address: entry.address })))
    .filter(row => !seen.has(row.address) && seen.add(row.address))
    .map((row, index) => ({ ...row, index, rank: rank(row.name, row.address) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
  return rows.map((row, index) => ({ address: row.address, interface: row.name,
    ...(labels.get(row.name) ? { label: labels.get(row.name)! } : {}), preferred: index === 0 }))
}
