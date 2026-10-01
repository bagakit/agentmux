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
