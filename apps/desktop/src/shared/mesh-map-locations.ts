/** Coordinates are authored for this Desktop map and have no transport or identity semantics. */
export type MeshLocation = { latitude: number; longitude: number }
export type MeshMapLocations = Record<string, string>

const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u

export function readMeshLocation(value: string): MeshLocation | undefined {
  const parts = value.split(',').map(part => part.trim())
  if (parts.length !== 2 || parts.some(part => !decimal.test(part))) return undefined
  const latitude = Number(parts[0]), longitude = Number(parts[1])
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined
  return { latitude, longitude }
}

export function meshLocationValue(locations: MeshMapLocations | undefined, hostId: string): string {
  return locations && Object.hasOwn(locations, hostId) ? locations[hostId] ?? '' : ''
}
