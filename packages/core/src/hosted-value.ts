import { AgentMuxError } from './errors.js'

/** JSON preserves ordered bytes and optional tuple arguments; text is never re-encoded as output. */
export function encodeHostedValue(value: unknown): unknown {
  if (value === undefined) return { $agentmuxValue: 'undefined' }
  if (value instanceof Uint8Array) {
    let binary = ''
    for (let offset = 0; offset < value.length; offset += 8192) {
      binary += String.fromCharCode(...value.subarray(offset, offset + 8192))
    }
    return { $agentmuxValue: 'bytes', data: btoa(binary) }
  }
  if (Array.isArray(value)) return value.map(encodeHostedValue)
  if (value && typeof value === 'object') {
    // A valid SDK dictionary can contain our marker key. Escape that ordinary record
    // once so its data cannot be mistaken for an undefined/bytes transport value.
    if (Object.hasOwn(value, '$agentmuxValue')) {
      return { $agentmuxValue: 'record', entries: Object.entries(value).map(([key, item]) => [key, encodeHostedValue(item)]) }
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeHostedValue(item)]))
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new AgentMuxError('This SDK argument cannot cross a public RPC connection.', 'INVALID_CONTROL_REQUEST')
  }
  return value
}

export function decodeHostedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeHostedValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.$agentmuxValue === 'record' && Object.keys(record).length === 2 && Array.isArray(record.entries)) {
      return Object.fromEntries(record.entries.map(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
          throw new AgentMuxError('RPC record entries are malformed.', 'CONTROL_PROTOCOL_ERROR')
        }
        return [entry[0], decodeHostedValue(entry[1])]
      }))
    }
    if (record.$agentmuxValue === 'undefined' && Object.keys(record).length === 1) return undefined
    if (record.$agentmuxValue === 'bytes' && Object.keys(record).length === 2 && typeof record.data === 'string') {
      try {
        const binary = atob(record.data)
        return Uint8Array.from(binary, character => character.charCodeAt(0))
      } catch { throw new AgentMuxError('RPC bytes are not valid base64.', 'CONTROL_PROTOCOL_ERROR') }
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeHostedValue(item)]))
  }
  return value
}
