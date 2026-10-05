import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { settingsResourceBudget, settingsResourceRecord, settingsResourceValue } from './settings-resource-json.js'
import type { AgentMuxControlSettingsResourceFields, AgentMuxControlSettingsResourceIssue } from './control.js'

/** Client appearance is opaque to Core. The original client owner interprets these values. */
export type AgentMuxAppearanceObservation = {
  sourceId: string
  revision: number
  values: AgentMuxControlSettingsResourceFields
  issues: AgentMuxControlSettingsResourceIssue[]
}
export type AgentMuxAppearanceObservationPort = {
  subscribe(onSnapshot: (value: AgentMuxAppearanceObservation) => void | Promise<void>, onEnd: (error?: Error) => void | Promise<void>, signal: AbortSignal):
    Promise<{ initial: AgentMuxAppearanceObservation; start(): void | Promise<void>; dispose(): void | Promise<void> }>
}

/** Shared by Unix/HTTP/SSH clients and the browser-safe hosted Relay leaf. */
export function parseAppearanceObservation(value: unknown, previous?: Pick<AgentMuxAppearanceObservation, 'sourceId' | 'revision'>): AgentMuxAppearanceObservation {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const source = rpcRecord(value, ['sourceId', 'revision', 'values', 'issues'], code)
  if (typeof source.sourceId !== 'string' || !source.sourceId || /[\0\r\n]/u.test(source.sourceId) ||
      new TextEncoder().encode(source.sourceId).byteLength > 4096 || !Number.isSafeInteger(source.revision) || (source.revision as number) < 0) {
    throw new AgentMuxError('Appearance observation identity or revision is invalid.', code)
  }
  if (previous && (source.sourceId !== previous.sourceId || (source.revision as number) <= previous.revision)) {
    throw new AgentMuxError('Appearance snapshot belongs to another owner or is not newer. Keep the last confirmed theme and reopen this reader.', code)
  }
  const values = settingsResourceRecord(source.values, code)
  const rawIssues = settingsResourceValue(source.issues, code)
  if (!Array.isArray(rawIssues)) throw new AgentMuxError('Appearance issues are invalid.', code)
  const issues = rawIssues.map(value => {
    const issue = rpcRecord(value, ['id', 'message'], code)
    if (typeof issue.id !== 'string' || typeof issue.message !== 'string') throw new AgentMuxError('Appearance issue is invalid.', code)
    return { id: issue.id, message: issue.message }
  })
  const result = { sourceId: source.sourceId, revision: source.revision as number, values, issues }
  settingsResourceBudget(result, code)
  return result
}
