import { AgentMuxError } from './errors.js'

export function rpcRecord(value: unknown, fields?: readonly string[], code = 'INVALID_CONTROL_REQUEST'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new AgentMuxError('RPC parameters must be a named object.', code)
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) {
      throw new AgentMuxError('RPC parameters must contain only JSON data.', code)
    }
  }
  const record = value as Record<string, unknown>
  if (fields && Object.keys(record).some(key => !fields.includes(key))) {
    throw new AgentMuxError('RPC parameters contain an unsupported field.', code)
  }
  return record
}

export function rpcString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value) || new TextEncoder().encode(value).byteLength > 4096) {
    throw new AgentMuxError(`${label} is invalid.`, 'INVALID_CONTROL_REQUEST')
  }
  return value
}
export function rpcCount(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new AgentMuxError('RPC numeric parameter is invalid.', 'INVALID_CONTROL_REQUEST')
  }
  return value as number
}

