import { AgentMuxError } from './errors.js'

/** Publication of this semantic owner's control entry; never a verdict on its Runs. */
export type AgentMuxControlEndpointState =
  | { state: 'available'; diagnostic?: never }
  | { state: 'unavailable'; diagnostic: { code: string; message: string } }

export function parseControlEndpointState(value: unknown): AgentMuxControlEndpointState {
  const invalid = (): never => { throw new AgentMuxError('Invalid control endpoint publication observation.', 'CONTROL_PROTOCOL_ERROR') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => key !== 'state' && key !== 'diagnostic')) return invalid()
  if (p.state === 'available' && p.diagnostic === undefined) return { state: 'available' }
  if (p.state !== 'unavailable' || !p.diagnostic || typeof p.diagnostic !== 'object' || Array.isArray(p.diagnostic)) return invalid()
  const d = p.diagnostic as Record<string, unknown>
  if (Object.keys(d).some(key => key !== 'code' && key !== 'message') || typeof d.code !== 'string' || !d.code || typeof d.message !== 'string' || !d.message) return invalid()
  return { state: 'unavailable', diagnostic: { code: d.code, message: d.message } }
}
