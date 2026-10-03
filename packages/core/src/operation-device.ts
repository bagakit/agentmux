import { AgentMuxError } from './errors.js'
import type { AgentOperationDevice } from './types.js'

/** Durable source metadata is public identity, never a device credential. */
export function normalizeOperationDevice(value: unknown): AgentOperationDevice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Operation device is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const p = value as Record<string, unknown>
  if (Object.keys(p).length !== 3 || !['hostId', 'deviceId', 'name'].every(key => typeof p[key] === 'string' && (p[key] as string).length > 0 && (p[key] as string).length <= 160 && !/[\0\r\n]/u.test(p[key] as string)))
    throw new AgentMuxError('Operation device is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return { hostId: p.hostId as string, deviceId: p.deviceId as string, name: p.name as string }
}
