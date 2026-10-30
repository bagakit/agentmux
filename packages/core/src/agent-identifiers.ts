import { AgentMuxError } from './errors.js'

/** Original Session/prompt operation identifiers, shared by admission and execution. */
export function safeId(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new AgentMuxError(`${name} must contain only letters, numbers, underscore, or dash.`, 'INVALID_SESSION_ID')
  return value
}
