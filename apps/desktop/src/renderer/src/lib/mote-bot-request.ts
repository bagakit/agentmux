import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { readConnectionHostingTarget } from '../../../shared/connection-hosting-target'
import { parseMoteConnectionParams, parseMoteConnectionRecordedSource, type MoteConnectionCreate, type MoteConnectionSync, type MoteConnectionRecordedSource } from '@agentmux/core/mote-connections'
import { parseDesiredConnectionProfile, parseConnectionSetupInitialPublication } from '@agentmux/core/connections'
import { parseMoteConnectionValues } from '@agentmux/core/mote-preferences'

type Phase = { phase: 'not-dispatched' | 'may-have-dispatched'; hostingTarget?: ConnectionHostingTarget }
type PreparedRequest = ({ action: 'create'; input: MoteConnectionCreate } | { action: 'sync'; input: MoteConnectionSync }) & { inspectOnly?: false }
type HistoricalSource = Extract<MoteConnectionRecordedSource, { expectedTopicRevision: string }>
type HistoricalInput = { operationId: string; source: HistoricalSource; avatar: 'include-saved' | 'omit' }
type HistoricalRequest = ({ action: 'create'; input: HistoricalInput & { adapterId: string; domain: string; name?: string; initialPublication?: MoteConnectionCreate['initialPublication'] } } | { action: 'sync'; input: HistoricalInput & { connection: MoteConnectionSync['connection']; expectedConnectionRevision: number } }) & { inspectOnly: true }
/** Original client input only. The parent journal owns every receipt and child operation. */
export type MoteBotRequest = (PreparedRequest | HistoricalRequest) & Phase

/** Qualify only the finite old request shape, preserving the original body for inspection; never send it. */
function historical(action: 'create' | 'sync', value: unknown): HistoricalRequest['input'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid historical input')
  const input = value as Record<string, unknown>
  const keys = action === 'create' ? ['operationId', 'source', 'adapterId', 'domain', 'avatar', 'name', 'initialPublication'] : ['operationId', 'source', 'connection', 'expectedConnectionRevision', 'avatar']
  if (Object.keys(input).some(key => !keys.includes(key))) throw Error('Mixed historical input')
  parseMoteConnectionParams('space.mote.connection.inspect', { operationId: input.operationId })
  const source = parseMoteConnectionRecordedSource(input.source)
  if (!('expectedTopicRevision' in source) || !['include-saved','omit'].includes(String(input.avatar)) || input.avatar === 'include-saved' && !source.expectedAvatarRevision) throw Error('Invalid historical source')
  if (action === 'create') {
    if (typeof input.adapterId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input.adapterId) || typeof input.domain !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(input.domain)) throw Error('Invalid historical platform')
    if (input.name !== undefined) parseDesiredConnectionProfile({ name: input.name })
    // Reuse the original publication validator through its existing enrollment codec.
    if (input.initialPublication !== undefined) parseConnectionSetupInitialPublication(input.initialPublication)
  } else {
    parseMoteConnectionValues({ connection: input.connection })
    if (!Number.isSafeInteger(input.expectedConnectionRevision) || Number(input.expectedConnectionRevision) < 1) throw Error('Invalid historical revision')
  }
  return structuredClone(value) as HistoricalRequest['input']
}
export function restoredMoteBotRequests(value: unknown): Record<string, MoteBotRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, MoteBotRequest> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const row = raw as MoteBotRequest
    if (row.action !== 'create' && row.action !== 'sync') continue
    const phase = row.phase === 'not-dispatched' ? 'not-dispatched' : 'may-have-dispatched'
    const hostingTarget = readConnectionHostingTarget(row.hostingTarget), owner = hostingTarget ? { hostingTarget } : {}
    try {
      const parsed = row.action === 'create'
        ? { action: row.action, input: parseMoteConnectionParams('space.mote.connection.create', row.input), phase, ...owner } as const
        : { action: row.action, input: parseMoteConnectionParams('space.mote.connection.sync', row.input), phase, ...owner } as const
      if (parsed.input.operationId === key) result[key] = parsed
    } catch {
      try {
        const input = historical(row.action, row.input)
        if (input.operationId === key) result[key] = { action: row.action, input, phase, ...owner, inspectOnly: true } as MoteBotRequest
      } catch { /* Malformed local data is not an executable or qualified historical intent. */ }
    }
  }
  return result
}
