import { createHash } from 'node:crypto'
import { scheduledIntentColumn, scheduledTimeColumn } from './agent-session-database.js'
import type { DatabaseSync } from 'node:sqlite'
import { parseAutomaticInputSource, sameAutomaticInputSource, type AutomaticInputSource } from './automatic-input-source.js'
import { matchesScheduledInputSource, projectContinuousProgressInputFacts } from './continuous-progress-input.js'
import { agentPromptInputId } from './agent-prompt-condition.js'
import { AgentMuxError } from './errors.js'
import { parsePromptSubmissionRecord } from './prompt-submission-record.js'
import { parseScheduleRpcParams, scheduleEventRecapLimit, scheduleHistoryPageSize, type ScheduleHistoryPage, type ScheduleHistoryQuery } from './public-rpc-schedules.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentFuturePromptIntent, AgentPromptSubmissionRecord } from './types.js'

type Target = { agentSessionId: string; providerId: string; workspacePath: string }
export type ScheduledPromptHistoryRequest = {
  query: ScheduleHistoryQuery
  target: Target
  definitions: { intentId: string; operationId: string }[]
  managedSource?: AutomaticInputSource
}
export type ScheduledPromptHistory = Pick<ScheduleHistoryPage, 'coverage' | 'entries' | 'nextCursor'>
type Position = readonly [occurrenceAt: number, runId: string, recordId: string]
type Original = { position: Position; readRecord(): unknown }
const unconfirmed = (): ScheduledPromptHistory => ({ coverage: 'unconfirmed', entries: [], nextCursor: null })
const invalid = () => new AgentMuxError('Use the original schedule, published definitions and history cursor.', 'INVALID_CONTROL_REQUEST')

function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw invalid()
  return value
}
export function parseScheduledPromptHistoryRequest(value: unknown): ScheduledPromptHistoryRequest {
  const input = rpcRecord(value, ['query', 'target', 'definitions', 'managedSource'], 'INVALID_CONTROL_REQUEST')
  const exact = rpcRecord(input.target, ['agentSessionId', 'providerId', 'workspacePath'], 'INVALID_CONTROL_REQUEST')
  const target = { agentSessionId: identity(exact.agentSessionId), providerId: identity(exact.providerId), workspacePath: identity(exact.workspacePath) }
  const query = parseScheduleRpcParams('schedule.history', input.query)
  if (!Array.isArray(input.definitions) || !input.definitions.length) throw invalid()
  const definitions = Array.from(input.definitions, value => {
    const exact = rpcRecord(value, ['intentId', 'operationId'], 'INVALID_CONTROL_REQUEST')
    return { intentId: identity(exact.intentId), operationId: identity(exact.operationId) }
  })
  if (new Set(definitions.map(definition => definition.intentId)).size !== definitions.length) throw invalid()
  return { query, target, definitions,
    ...(input.managedSource === undefined ? {} : { managedSource: parseAutomaticInputSource(input.managedSource) }) }
}

const compareText = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const comparePosition = (a: Position, b: Position) => a[0] - b[0] || compareText(a[1], b[1]) || compareText(a[2], b[2])

/** Read position belongs to the schedule and exact owner, independent of later rule revisions. */
function readCursor(request: ScheduledPromptHistoryRequest, owner: string) {
  const { query, target, managedSource } = request
  const scope = createHash('sha256').update(JSON.stringify([owner, target, managedSource, query.scheduleId, query.from, query.to])).digest('base64url')
  let before: Position | undefined
  if (query.cursor) {
    try {
      const data = Buffer.from(query.cursor, 'base64url')
      const [name, occurrenceAt, runId, recordId, ...excess] = JSON.parse(data.toString('utf8')) as unknown[]
      if (data.toString('base64url') !== query.cursor || excess.length || name !== scope || !Number.isSafeInteger(occurrenceAt) ||
          Number(occurrenceAt) < query.from || Number(occurrenceAt) >= query.to) throw invalid()
      before = [Number(occurrenceAt), identity(runId), identity(recordId)]
    } catch { throw invalid() }
  }
  return { before, next: (position: Position) => Buffer.from(JSON.stringify([scope, ...position])).toString('base64url') }
}

function page(request: ScheduledPromptHistoryRequest, owner: string, session: Target | null, recordId: (record: AgentPromptSubmissionRecord) => string,
  readIntent: (intentId: string) => AgentFuturePromptIntent | null,
  read: (intents: ReadonlySet<string>, before: Position | undefined, limit: number) => Original[]): ScheduledPromptHistory {
  const { target, definitions, managedSource, query } = request
  const cursor = readCursor(request, owner)
  if (!session || session.agentSessionId !== target.agentSessionId || session.providerId !== target.providerId || session.workspacePath !== target.workspacePath) return unconfirmed()
  const intents = new Map<string, AgentFuturePromptIntent>()
  for (const definition of definitions) {
    const intent = readIntent(definition.intentId)
    if (intent && intent.operationId === definition.operationId && sameAutomaticInputSource(intent.continuitySource, managedSource)) intents.set(definition.intentId, intent)
  }
  const limit = scheduleHistoryPageSize(query)
  const rows = intents.size ? read(new Set(intents.keys()), cursor.before, limit + 1) : []
  const result: ScheduledPromptHistory = { coverage: intents.size === definitions.length ? 'recorded-inputs' : 'unconfirmed', entries: [],
    nextCursor: rows.length > limit ? cursor.next(rows[limit - 1]!.position) : null }
  for (const row of rows.slice(0, limit)) {
    const original = parsePromptSubmissionRecord(row.readRecord())
    const claim = original.admission, key = claim?.inputKey, futureIntent = claim?.futureIntent
    const intent = futureIntent && intents.get(futureIntent.intentId)
    if (!claim || key?.kind !== 'prompt' || key.agentSessionId !== target.agentSessionId || !futureIntent || !intent ||
        comparePosition([futureIntent.occurrenceAt, original.run.runId, recordId(original)], row.position) !== 0 ||
        !matchesScheduledInputSource({ inputKey: key, futureIntent, definitionOperationId: intent.operationId, ...(managedSource ? { managedSource } : {}) }, original, intent)) {
      result.coverage = 'unconfirmed'
      continue
    }
    const { delivery, nativeResult } = projectContinuousProgressInputFacts(original, claim, key)
    // Only the original user-facing input belongs in this authorized projection.
    // The current definition, system context and native command are not recap data.
    const input = claim.intent?.message?.userContent
    const excerpt = input?.slice(0, scheduleEventRecapLimit).replace(/[\uD800-\uDBFF]$/u, '')
    result.entries.push({ operationId: agentPromptInputId(key), occurrenceAt: futureIntent.occurrenceAt, runId: original.run.runId, delivery, nativeResult,
      recap: input && excerpt ? { text: excerpt, truncated: input.length > excerpt.length } : null })
  }
  return result
}

export function readMemoryScheduledPromptHistory(request: ScheduledPromptHistoryRequest, owner: string,
  session: (Target & { futurePromptIntents?: Record<string, AgentFuturePromptIntent> }) | null, records: Iterable<AgentPromptSubmissionRecord>,
  recordId: (record: AgentPromptSubmissionRecord) => string): ScheduledPromptHistory {
  return page(request, owner, session, recordId, intentId => session?.futurePromptIntents?.[intentId] ?? null, (intents, before, limit) => {
    const rows: Original[] = []
    for (const record of records) {
      const claim = record.admission, occurrence = claim?.futureIntent
      if (!occurrence || !intents.has(occurrence.intentId) || occurrence.occurrenceAt < request.query.from || occurrence.occurrenceAt >= request.query.to) continue
      const row: Original = { position: [occurrence.occurrenceAt, record.run.runId, recordId(record)], readRecord: () => record }
      if (!before || comparePosition(row.position, before) < 0) rows.push(row)
      if (rows.length === 2 * limit) rows.sort((a, b) => comparePosition(b.position, a.position)).length = limit
    }
    return rows.sort((a,b) => comparePosition(b.position, a.position)).slice(0, limit)
  })
}

export function readDatabaseScheduledPromptHistory(db: DatabaseSync, request: ScheduledPromptHistoryRequest, session: Target | null,
  readIntent: (intentId: string) => AgentFuturePromptIntent | null, recordId: (record: AgentPromptSubmissionRecord) => string): ScheduledPromptHistory {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prompt_admissions'").get()) return unconfirmed()
  const owner = db.prepare('SELECT incarnation FROM identity').get()?.incarnation
  if (typeof owner !== 'string') return unconfirmed()
  return page(request, owner, session, recordId, readIntent, (intents, before, limit) => {
    // Each published definition seeks its own range and continuation. Defer loading
    // frozen input bodies until after the bounded merge of original positions.
    // Give SQLite the cursor time as its actual index upper bound; the tuple
    // comparison alone can scan every newer page before visiting this one.
    const positions = db.prepare(`SELECT ${scheduledTimeColumn} AS occurrence, run_id, record_id FROM prompt_admissions
      WHERE session_id=? AND ${scheduledIntentColumn}=? AND ${scheduledTimeColumn}>=? AND ${scheduledTimeColumn}${before ? "<=" : "<"}?
        ${before ? `AND (${scheduledTimeColumn},run_id,record_id)<(?,?,?)` : ''}
      ORDER BY ${scheduledTimeColumn} DESC, run_id DESC, record_id DESC LIMIT ?`)
    const candidates: Position[] = []
    for (const intentId of intents) {
      const rows = positions.all(request.target.agentSessionId, intentId, request.query.from, before?.[0] ?? request.query.to, ...(before ?? []), limit)
      for (const row of rows) candidates.push([Number(row.occurrence), String(row.run_id), String(row.record_id)])
      if (candidates.length > limit) candidates.sort((a, b) => comparePosition(b, a)).length = limit
    }
    const body = db.prepare('SELECT json FROM prompt_admissions WHERE session_id=? AND run_id=? AND record_id=?')
    return candidates.sort((a, b) => comparePosition(b, a)).slice(0, limit).map(position => ({
      position, readRecord: () => JSON.parse(String(body.get(request.target.agentSessionId, position[1], position[2])?.json))
    }))
  })
}
