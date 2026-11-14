import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

export type NodeMapPoint = { latitude: number; longitude: number }
export type NodeMapLocation = NodeMapPoint & { label: string; source: 'node' | 'site' | 'public-egress'; accuracyKm?: number }
/** Coordinates use the same editable text in the Node draft and the submitted policy. */
export type NodeLocationPolicy = { coordinates: string; label: string; estimatePublicEgress: boolean }

export function readMapCoordinates(value: string): NodeMapPoint | undefined {
  const pair = value.split(',').map(part => part.trim())
  if (pair.length !== 2 || pair.some(part => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(part))) return undefined
  const latitude = Number(pair[0]), longitude = Number(pair[1])
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : undefined
}

export function parseNodeLocationPolicy(value: unknown): NodeLocationPolicy {
  const p = rpcRecord(value, ['coordinates', 'label', 'estimatePublicEgress'])
  if (typeof p.coordinates !== 'string' || (p.coordinates !== '' && !readMapCoordinates(p.coordinates)) ||
      typeof p.label !== 'string' || p.label.length > 128 || /[\u0000-\u001f]/u.test(p.label) || typeof p.estimatePublicEgress !== 'boolean') {
    throw new AgentMuxError('Use a map label and valid latitude and longitude, or leave the coordinates empty.', 'INVALID_CONTROL_REQUEST')
  }
  return { coordinates: p.coordinates.trim(), label: p.label.trim(), estimatePublicEgress: p.estimatePublicEgress }
}

export function parseNodeMapLocation(value: unknown): NodeMapLocation {
  const p = rpcRecord(value, ['latitude', 'longitude', 'label', 'source', 'accuracyKm'], 'CONTROL_PROTOCOL_ERROR')
  if (typeof p.latitude !== 'number' || !Number.isFinite(p.latitude) || Math.abs(p.latitude) > 90 ||
      typeof p.longitude !== 'number' || !Number.isFinite(p.longitude) || Math.abs(p.longitude) > 180 ||
      typeof p.label !== 'string' || p.label.length > 128 || /[\u0000-\u001f]/u.test(p.label) ||
      (p.source !== 'node' && p.source !== 'site' && p.source !== 'public-egress') ||
      (p.accuracyKm !== undefined && (typeof p.accuracyKm !== 'number' || !Number.isFinite(p.accuracyKm) || p.accuracyKm < 0))) {
    throw new AgentMuxError('The original Node returned an invalid map location.', 'CONTROL_PROTOCOL_ERROR')
  }
  return { latitude: p.latitude, longitude: p.longitude, label: p.label, source: p.source, ...(p.accuracyKm === undefined ? {} : { accuracyKm: p.accuracyKm }) }
}
