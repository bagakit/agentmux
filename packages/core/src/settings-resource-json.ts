import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, type AgentMuxControlSettingsResourceFields,
  type AgentMuxControlSettingsResourceJson } from './control.js'
import { AgentMuxError } from './errors.js'

// The reviewed resource envelope admits eight container levels, not arbitrary object graphs.
const MAX_DEPTH = 8
const invalid = (code: string): never => { throw new AgentMuxError('Settings resource JSON is invalid or exceeds its budget.', code) }

export function settingsResourceBudget(value: unknown, code: string): void {
  if (Buffer.byteLength(JSON.stringify(value)) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) invalid(code)
}

function json(value: unknown, code: string, depth: number): AgentMuxControlSettingsResourceJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || depth >= MAX_DEPTH) return invalid(code)
  const keys = Reflect.ownKeys(value)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) return invalid(code)
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !('value' in descriptor)) return invalid(code)
      return json(descriptor.value, code, depth + 1)
    })
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid(code)
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) return invalid(code)
    return [key, json(descriptor.value, code, depth + 1)]
  }))
}

export function settingsResourceRecord(value: unknown, code: string): AgentMuxControlSettingsResourceFields {
  const parsed = json(value, code, 0)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid(code)
  settingsResourceBudget(parsed, code)
  return parsed
}

export function settingsResourceEnvelope(value: unknown, allowed: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid(code)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) return invalid(code)
  }
  return value as Record<string, unknown>
}
