import type { MeshNetworkInspection } from '@agentmux/core/mesh-network'

type Network = NonNullable<MeshNetworkInspection['network']>
export type MeshTopologyPeer = {
  id: string
  own: boolean
  observed: boolean
  state: 'local' | 'connected' | 'connecting' | 'disconnected' | 'advertised' | 'unobserved'
  ingress: Network['records'][number]['advertisedIngress']
  rttMs: number | null
  epoch: number | null
  neighbors: string[]
  endpoints: string[]
}
export type MeshTopologyEdge = { id: string; source: string; target: string; rttMs: number; reverseRttMs: number }
export type MeshTopologyModel = {
  peers: MeshTopologyPeer[]
  edges: MeshTopologyEdge[]
  routes: Network['routes']
  circuits: Network['circuits']
}
export type MeshTopologySelection = { kind: 'peer' | 'route' | 'circuit'; id: string }
export const shortMeshIdentity = (value: string) => value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value
export const meshRtt = (value: number | null) => value === null ? 'RTT not observed' : `${Math.round(value)} ms`
export const meshPeerState = (peer: MeshTopologyPeer) => ({ local: 'This Core', connected: 'Authenticated', connecting: 'Connecting', disconnected: 'Disconnected', advertised: 'Advertised', unobserved: 'Not observed' })[peer.state]
export const meshTopologySource = (snapshot?: MeshNetworkInspection) => JSON.stringify([snapshot?.owner.runtimeId ?? null, snapshot?.owner.ownerInstanceId ?? null, snapshot?.network?.networkId ?? null])
const edgeId = (a: string, b: string) => JSON.stringify([a, b].sort())

/** A read-only projection. A route or adopted circuit never invents a current adjacency. */
export function meshTopologyModel(snapshot?: MeshNetworkInspection): MeshTopologyModel {
  const network = snapshot?.network
  if (!network) return { peers: [], edges: [], routes: [], circuits: [] }
  const own = network.identity?.peerId, direct = new Map(network.peers.map(peer => [peer.peerId, peer]))
  const records = new Map(network.records.map(record => [record.originPeerId, record]))
  const ids = new Set<string>([...(own ? [own] : []), ...network.peers.map(peer => peer.peerId), ...records.keys()])
  const neighbors = new Map<string, Map<string, Network['records'][number]['neighbors'][number]>>()
  for (const record of network.records) {
    const entries = new Map(record.neighbors.map(neighbor => [neighbor.peerId, neighbor]))
    neighbors.set(record.originPeerId, entries)
    for (const neighbor of record.neighbors) ids.add(neighbor.peerId)
  }
  for (const route of network.routes) for (const id of route.path) ids.add(id)
  for (const circuit of network.circuits) for (const id of circuit.path) ids.add(id)
  const edges: MeshTopologyEdge[] = [], adjacent = new Map<string, string[]>()
  for (const record of network.records) for (const neighbor of record.neighbors) {
    const other = records.get(neighbor.peerId), back = neighbors.get(neighbor.peerId)?.get(record.originPeerId)
    if (!other || !back || other.epoch !== neighbor.peerEpoch || back.peerEpoch !== record.epoch || back.connectionId !== neighbor.connectionId || record.originPeerId >= neighbor.peerId) continue
    edges.push({ id: edgeId(record.originPeerId, neighbor.peerId), source: record.originPeerId, target: neighbor.peerId, rttMs: neighbor.rttMs, reverseRttMs: back.rttMs })
    adjacent.set(record.originPeerId, [...(adjacent.get(record.originPeerId) ?? []), neighbor.peerId])
    adjacent.set(neighbor.peerId, [...(adjacent.get(neighbor.peerId) ?? []), record.originPeerId])
  }
  const peers = [...ids].map((id): MeshTopologyPeer => {
    const record = records.get(id), peer = direct.get(id)
    return { id, own: id === own, observed: Boolean(record), state: id === own ? 'local' : peer?.state ?? (record ? 'advertised' : 'unobserved'), ingress: record?.advertisedIngress ?? [], rttMs: peer?.rttMs ?? null, epoch: id === own ? network.identity!.epoch : record?.epoch ?? null, neighbors: (adjacent.get(id) ?? []).sort(), endpoints: record?.publishers.map(publisher => publisher.serverId) ?? [] }
  }).sort((a, b) => Number(b.own) - Number(a.own) || a.id.localeCompare(b.id))
  return { peers, edges, routes: network.routes, circuits: network.circuits }
}

export function meshSelectionPath(model: MeshTopologyModel, selected?: MeshTopologySelection): string[] {
  if (selected?.kind === 'route') return model.routes.find(route => route.serverId === selected.id)?.path ?? []
  if (selected?.kind === 'circuit') return model.circuits.find(circuit => circuit.circuitId === selected.id)?.path ?? []
  const peer = selected?.kind === 'peer' ? model.peers.find(peer => peer.id === selected.id) : undefined
  return peer ? [peer.id] : []
}
export function meshSelectionExists(model: MeshTopologyModel, selected: MeshTopologySelection): boolean {
  return selected.kind === 'peer' ? model.peers.some(peer => peer.id === selected.id) : selected.kind === 'route' ? model.routes.some(route => route.serverId === selected.id) : model.circuits.some(circuit => circuit.circuitId === selected.id)
}
export function meshPathEdges(path: readonly string[]) { return new Set(path.slice(1).map((id, index) => edgeId(path[index]!, id))) }
export function meshPeerLabel(peer: MeshTopologyPeer) { return peer.own ? 'This Core' : peer.ingress[0]?.endpoint ?? shortMeshIdentity(peer.id) }
