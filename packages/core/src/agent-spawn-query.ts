import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { AgentMuxError } from './errors.js'
import type { AgentMuxAgentCreationFact, AgentMuxRunRef } from './types.js'
import type { AgentMuxSpawnCreator } from './agent-spawn.js'

export type AgentMuxSpawnQuery = {
  participantSessionId: string
  direction: 'created' | 'creator'
  /** Omit for a creator at this original child owner; never a display Host alias. */
  creatorRuntimeId?: string
  cursor?: string
  limit?: number
}
export type AgentMuxSpawnRecord = {
  agentSessionId: string
  phase: 'prepared' | 'active' | 'retired'
  currentRun: AgentMuxRunRef | null
  createdAt: number
  creation: AgentMuxAgentCreationFact & { createdBy: AgentMuxSpawnCreator }
}
export type AgentMuxSpawnPage = {
  participantSessionId: string
  direction: AgentMuxSpawnQuery['direction']
  creatorRuntimeId: string | null
  records: readonly AgentMuxSpawnRecord[]
  nextCursor: string | null
  /** Missing historical provenance is never reconstructed from today's text or layout. */
  coverage: { scope: 'selected-owner'; history: 'recorded-creations' }
}
type SpawnRow = { phase: AgentMuxSpawnRecord['phase']; value: unknown }

const invalid = (): never => { throw new AgentMuxError('Spawn query requires an exact participant, direction and original cursor.', 'INVALID_AGENT_SPAWN_QUERY') }
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) return invalid()
  return value
}
export function parseAgentSpawnQuery(value: unknown): AgentMuxSpawnQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !['participantSessionId', 'direction', 'creatorRuntimeId', 'cursor', 'limit'].includes(key)) ||
    p.direction !== 'created' && p.direction !== 'creator' ||
    p.limit !== undefined && (!Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 100) ||
    p.creatorRuntimeId !== undefined && p.direction !== 'created' ||
    p.cursor !== undefined && (typeof p.cursor !== 'string' || !p.cursor || p.cursor.length > 2048)) return invalid()
  return { participantSessionId: id(p.participantSessionId), direction: p.direction,
    ...(p.creatorRuntimeId === undefined ? {} : { creatorRuntimeId: id(p.creatorRuntimeId) }),
    ...(p.cursor === undefined ? {} : { cursor: p.cursor as string }), ...(p.limit === undefined ? {} : { limit: Number(p.limit) }) }
}
function queryScope(query: AgentMuxSpawnQuery, owner: string): string {
  return createHash('sha256').update(JSON.stringify([owner, query.participantSessionId, query.direction, query.creatorRuntimeId ?? null])).digest('hex')
}
function after(query: AgentMuxSpawnQuery, owner: string): string {
  if (!query.cursor) return ''
  try {
    const bytes = Buffer.from(query.cursor, 'base64url')
    if (bytes.toString('base64url') !== query.cursor) return invalid()
    const p = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    if (Object.keys(p).length !== 2 || p.scope !== queryScope(query, owner)) return invalid()
    return id(p.after)
  } catch { return invalid() }
}
export function agentSpawnPage(query: AgentMuxSpawnQuery, owner: string, records: readonly AgentMuxSpawnRecord[]): AgentMuxSpawnPage {
  const bound = after(query, owner), limit = query.limit ?? 50
  const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
  const selected = records.filter(record => compare(record.agentSessionId, bound) > 0 && (query.direction === 'creator'
    ? record.agentSessionId === query.participantSessionId
    : record.creation.createdBy.agentSessionId === query.participantSessionId && (query.creatorRuntimeId
      ? record.creation.createdBy.owner.kind === 'runtime' && record.creation.createdBy.owner.runtimeId === query.creatorRuntimeId
      : record.creation.createdBy.owner.kind === 'local')))
    .sort((a, b) => compare(a.agentSessionId, b.agentSessionId))
  const unique = [...new Map(selected.map(record => [record.agentSessionId, record])).values()]
  const page = unique.slice(0, limit)
  return { participantSessionId: query.participantSessionId, direction: query.direction, creatorRuntimeId: query.creatorRuntimeId ?? null, records: page,
    nextCursor: unique.length > limit ? Buffer.from(JSON.stringify({ scope: queryScope(query, owner), after: page.at(-1)!.agentSessionId })).toString('base64url') : null,
    coverage: { scope: 'selected-owner', history: 'recorded-creations' } }
}

const sources = [
  { table: 'sessions', phase: 'active', path: '$.creation' },
  { table: 'retired_sessions', phase: 'retired', path: '$.history.creation' },
  { table: 'reservations', phase: 'prepared', path: '$.preparedCreation.creation' }
] as const

/** Rebuildable lookup indexes over the original metadata; no second relation table. */
export const agentSpawnIndexes = sources.map(({ table, path }) => `CREATE INDEX IF NOT EXISTS spawn_creator_${table}
  ON ${table}(json_extract(json,'${path}.createdBy.agentSessionId'),
  json_extract(json,'${path}.createdBy.owner.kind'),
  coalesce(json_extract(json,'${path}.createdBy.owner.runtimeId'),''),id);`).join('\n')

/** Decode at most three bounded related windows, never the Session catalog or histories. */
export function readAgentSpawnRows(db: DatabaseSync, query: AgentMuxSpawnQuery): { owner: string; rows: SpawnRow[] } {
  const owner = db.prepare('SELECT incarnation FROM identity').get()?.incarnation
  if (typeof owner !== 'string') throw new AgentMuxError('The original Session persistence identity is unconfirmed.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
  const bound = after(query, owner), limit = (query.limit ?? 50) + 1
  const rows = sources.flatMap(({ table, phase, path }) => {
    const parameters: SQLInputValue[] = [query.participantSessionId]
    let where: string
    if (query.direction === 'creator') where = 'id=?'
    else {
      where = `json_extract(json,'${path}.createdBy.agentSessionId')=? AND
        json_extract(json,'${path}.createdBy.owner.kind')=? AND
        coalesce(json_extract(json,'${path}.createdBy.owner.runtimeId'),'')=?`
      parameters.push(query.creatorRuntimeId ? 'runtime' : 'local', query.creatorRuntimeId ?? '')
    }
    where += ' AND id>?'; parameters.push(bound)
    // A committed Session wins over its old prepared record; retirement wins over a
    // still-retained reservation. These are the same original child identity.
    if (table !== 'sessions') where += ` AND NOT EXISTS(SELECT 1 FROM sessions active WHERE active.id=${table}.id)`
    if (table === 'reservations') where += ' AND NOT EXISTS(SELECT 1 FROM retired_sessions retired WHERE retired.id=reservations.id)'
    return db.prepare(`SELECT json FROM ${table}${query.direction === 'created' ? ` INDEXED BY spawn_creator_${table}` : ''}
      WHERE ${where} ORDER BY id LIMIT ?`).all(...parameters, limit)
      .map(row => ({ phase, value: JSON.parse(String(row.json)) as unknown }))
  })
  return { owner, rows }
}
