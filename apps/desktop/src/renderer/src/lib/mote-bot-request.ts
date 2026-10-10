import { parseMoteConnectionParams, type MoteConnectionCreate, type MoteConnectionSync } from '@agentmux/core/mote-connections'

/** Original client input only. The Main parent journal owns every receipt and child operation. */
export type MoteBotRequest = ({ action: 'create'; input: MoteConnectionCreate } | { action: 'sync'; input: MoteConnectionSync }) & {
  phase: 'not-dispatched' | 'may-have-dispatched'
}
export function restoredMoteBotRequests(value: unknown): Record<string, MoteBotRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, MoteBotRequest> = {}
  for (const [key, raw] of Object.entries(value)) {
    try {
      const row = raw as MoteBotRequest
      const phase = row.phase === 'not-dispatched' ? 'not-dispatched' : 'may-have-dispatched'
      if (row.action !== 'create' && row.action !== 'sync') continue
      const parsed = row.action === 'create'
        ? { action: row.action, input: parseMoteConnectionParams('space.mote.connection.create', row.input), phase } as const
        : { action: row.action, input: parseMoteConnectionParams('space.mote.connection.sync', row.input), phase } as const
      if (parsed.input.operationId === key) result[key] = parsed
    } catch { /* Unqualified client data never dispatches an effect. */ }
  }
  return result
}
