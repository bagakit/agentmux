import { BlockList, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { readFile } from 'node:fs/promises'
import { parseNodeMapLocation, readMapCoordinates, type NodeLocationPolicy, type NodeMapLocation } from './node-location.js'

type Site = { label: string; latitude: number; longitude: number; runtimeIds?: string[]; subnets?: string[] }
type Sources = {
  readSites(signal?: AbortSignal): Promise<unknown>
  addresses(): string[]
  egress(signal: AbortSignal): Promise<unknown>
}

const sources: Sources = {
  async readSites(signal) {
    const path = process.env.AGENTMUX_NODE_SITE_CATALOG
    return path ? JSON.parse(await readFile(path, { encoding: 'utf8', signal })) : []
  },
  addresses: () => Object.values(networkInterfaces()).flatMap(entries => entries?.filter(entry => !entry.internal).map(entry => entry.address) ?? []),
  async egress(signal) {
    // The original Node requests only its own outward-facing region. No target addresses or credentials are sent.
    const reply = await fetch('https://get.geojs.io/v1/ip/geo.json', { signal, redirect: 'error' })
    if (!reply.ok) return null
    return reply.json()
  },
}

function subnetMatches(cidr: string, addresses: string[]) {
  const [address, prefix, ...extra] = cidr.split('/')
  const family = isIP(address ?? '')
  if (!family || !/^\d{1,3}$/u.test(prefix ?? '') || Number(prefix) > (family === 4 ? 32 : 128) || extra.length) return false
  const kind = family === 4 ? 'ipv4' : 'ipv6'
  const block = new BlockList()
  block.addSubnet(address!, Number(prefix), kind)
  return addresses.some(ip => isIP(ip) === family && block.check(ip, kind))
}

/** Only one matching, operator-supplied site establishes a location. */
function registeredSite(value: unknown, runtimeId: string, addresses: string[]): NodeMapLocation | null {
  if (!Array.isArray(value)) return null
  const sites = value.filter((item): item is Site => !!item && typeof item === 'object')
  const exact = sites.filter(site => Array.isArray(site.runtimeIds) && site.runtimeIds.includes(runtimeId))
  const matches = exact.length ? exact : sites.filter(site => Array.isArray(site.subnets) && site.subnets.some(cidr => typeof cidr === 'string' && subnetMatches(cidr, addresses)))
  if (matches.length !== 1) return null
  const { latitude, longitude, label } = matches[0]!
  return parseNodeMapLocation({ latitude, longitude, label, source: 'site' })
}

function estimate(value: unknown): NodeMapLocation | null {
  if (!value || typeof value !== 'object') return null
  const result = value as Record<string, unknown>
  if (typeof result.latitude !== 'string' || typeof result.longitude !== 'string') return null
  const point = readMapCoordinates(result.latitude + ',' + result.longitude)
  if (!point) return null
  const label = [...new Set([result.city, result.region, result.country].filter((item): item is string => typeof item === 'string' && !!item))].join(', ').slice(0, 128)
  // Rounding moves the centre by at most 80 km. Include the service’s original radius when known.
  const radius = typeof result.accuracy === 'number' && Number.isSafeInteger(result.accuracy) && result.accuracy >= 0 ? result.accuracy + 80 : undefined
  return parseNodeMapLocation({ source: 'public-egress', label, latitude: Math.round(point.latitude), longitude: Math.round(point.longitude), accuracyKm: radius })
}

/** Independent of routing. Network I/O runs only when an enabled Node is asked for a map observation. */
export class NodeLocationSource {
  private cached?: { value: NodeMapLocation | null; until: number }
  constructor(private readonly ports: Sources = sources) {}
  async read(runtimeId: string, policy?: NodeLocationPolicy, signal?: AbortSignal): Promise<NodeMapLocation | null> {
    signal?.throwIfAborted()
    const point = policy?.coordinates && readMapCoordinates(policy.coordinates)
    if (point) return { ...point, label: policy!.label, source: 'node' }
    try {
      const catalog = await this.ports.readSites(signal)
      const site = registeredSite(catalog, runtimeId, Array.isArray(catalog) && catalog.length ? this.ports.addresses() : [])
      if (site) return site
    } catch { signal?.throwIfAborted() }
    if (!policy?.estimatePublicEgress) return null
    return this.readPublicEgress(signal)
  }

  async readPublicEgress(signal?: AbortSignal): Promise<NodeMapLocation | null> {
    signal?.throwIfAborted()
    if (this.cached && this.cached.until > Date.now()) return this.cached.value
    const deadline = AbortSignal.timeout(2500)
    let value: NodeMapLocation | null = null
    try { value = estimate(await this.ports.egress(signal ? AbortSignal.any([signal, deadline]) : deadline)) }
    catch { signal?.throwIfAborted() }
    signal?.throwIfAborted()
    this.cached = { value, until: Date.now() + (value ? 15 * 60_000 : 60_000) }
    return value
  }
}
