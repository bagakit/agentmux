export { readMapCoordinates as readMeshLocation } from '@agentmux/core/node-publishing'
export type { NodeMapLocation as MeshDeviceLocation } from '@agentmux/core/node-publishing'

export type MeshLocation = { latitude: number; longitude: number }
export type MacMapLocationResult =
  | ({ state: 'located' } & MeshLocation)
  | { state: 'denied' | 'restricted' | 'unavailable' | 'timeout' | 'busy' | 'not-focused' }

/** Peer keys belong to a named Mesh network. Host annotations use their existing Host IDs. */
export const meshPeerLocationKey = (networkId: string, peerId: string) => JSON.stringify([networkId, peerId])

export type MeshMapLocations = Record<string, string>

export function meshLocationValue(locations: MeshMapLocations | undefined, hostId: string): string {
  return locations && Object.hasOwn(locations, hostId) ? locations[hostId] ?? '' : ''
}
