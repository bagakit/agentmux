import { parseContinuousProgressDefinition, parseContinuousProgressGuidanceAdoptions } from './continuous-progress-definition.js'
import { parseContinuousProgressOutcome, parseContinuousProgressDelivery, parseContinuousProgressInputReference, parseContinuousProgressInputReading, type ContinuousProgressInputFacts, type ContinuousProgressInputReading } from './continuous-progress-input.js'
export * from './continuous-progress-input.js'
import { parseAutomaticInputSource, sameAutomaticInputSource, type AutomaticInputSource } from './automatic-input-source.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseAgentScheduleCheckIn, parseAgentScheduleTiming, type AgentScheduleTiming } from './agent-schedule.js'
import { optionalInputEpoch, agentPromptInputId, validateAgentPromptCondition } from './agent-prompt-condition.js'
import { isAgentSchedule, validateContinuousProgressPause, type ContinuousProgressLoop, type ContinuousProgressTarget } from './continuous-progress-scheduler.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

export type ScheduleMutation = { scheduleId: string; expectedRevision: number; operationId: string }
export type ScheduleScope = Pick<ContinuousProgressTarget, 'hostId' | 'workspacePath'>
export type ScheduleHistoryQuery = { scheduleId: string; from: number; to: number; limit?: number; cursor?: string; bucketStarts?: number[] }
export const scheduleEventRecapLimit = 800
export const scheduleEventLabelLimit = 80
export type ScheduleHistoryEntry = Pick<ContinuousProgressInputFacts, 'delivery' | 'nativeResult'> & {
  operationId: string
  occurrenceAt: number
  runId: string
  recap: Readonly<{ text: string; truncated: boolean }> | null
}
export type ScheduleHistoryGroup = {
  delivery: ScheduleHistoryEntry['delivery']
  nativeState: ScheduleHistoryEntry['nativeResult']['state']
  count: number
  originalLabel: string | null
  firstAt: number
  lastAt: number
}
export type ScheduleHistoryBucket = { from: number; to: number; groups: ScheduleHistoryGroup[] }
export type ScheduleHistoryPage = Pick<ScheduleHistoryQuery, 'scheduleId' | 'from' | 'to'> & {
  executionScope: 'connected-host'
  coverage: 'recorded-inputs' | 'unconfirmed'
  entries: ScheduleHistoryEntry[]
  nextCursor: string | null
  buckets?: ScheduleHistoryBucket[]
}
export type ScheduleHistoryReading = Pick<ScheduleHistoryPage, 'coverage' | 'entries' | 'nextCursor' | 'buckets'>
export function unconfirmedScheduleHistory(query: ScheduleHistoryQuery): ScheduleHistoryReading {
  return { coverage: 'unconfirmed', entries: [], nextCursor: null, ...(query.bucketStarts ? { buckets: [] } : {}) }
}
export type ScheduleParamsMap = {
  'schedule.list': { target?: ContinuousProgressTarget; scope?: never } | { scope: ScheduleScope; target?: never }
  'schedule.inspect': { scheduleId?: string; operationId?: string }
  'schedule.history': ScheduleHistoryQuery
  'schedule.create': { target: ContinuousProgressTarget; prompt: string; operationId: string; inputEpoch?:string; managedSource?: AutomaticInputSource } & AgentScheduleTiming
  'schedule.update': ScheduleMutation & { everyMs: number }
  'schedule.pause': ScheduleMutation
  'schedule.resume': ScheduleMutation
  'schedule.cancel': ScheduleMutation
}
export type ScheduleReceipt = { schedule: ContinuousProgressLoop; diskDurability: 'confirmed'; executionScope: 'connected-host' }
export type ScheduleResultMap = {
  'schedule.list': { schedules: ContinuousProgressLoop[]; executionScope: 'connected-host' }
  'schedule.inspect': { schedule: ContinuousProgressLoop | null; executionScope: 'connected-host'; input?: ContinuousProgressInputReading }
  'schedule.history': ScheduleHistoryPage
  'schedule.create': ScheduleReceipt
  'schedule.update': ScheduleReceipt
  'schedule.pause': ScheduleReceipt
  'schedule.resume': ScheduleReceipt
  'schedule.cancel': ScheduleReceipt
}
export type ScheduleMethod = keyof ScheduleParamsMap
export interface AgentMuxRpcSchedulesOwner {
  call<M extends ScheduleMethod>(method: M, params: ScheduleParamsMap[M], context?: AgentMuxRpcCallContext): Promise<ScheduleResultMap[M]>
}
export const AGENTMUX_RPC_SCHEDULE_METHODS = {
  'schedule.list': 'short', 'schedule.inspect': 'short', 'schedule.history': 'short', 'schedule.create': 'long',
  'schedule.update': 'long', 'schedule.pause': 'long', 'schedule.resume': 'long', 'schedule.cancel': 'long'
} as const satisfies Record<ScheduleMethod, 'short' | 'long'>
export function isScheduleMethod(value: unknown): value is ScheduleMethod {
  return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_SCHEDULE_METHODS, value)
}
function invalid(message: string, code: string): never { throw new AgentMuxError(message, code) }
function string(value: unknown, code: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) invalid('An exact schedule identity or nonempty message is required.', code)
}
function integer(value: unknown, code: string, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min) invalid('Schedule revision or occurrence is invalid.', code)
}
const historyMaxMs = 48 * 60 * 60 * 1000
const maxSummaryWindowMs = 43 * 24 * 60 * 60 * 1000
const maxBucketCount = 168
const summaryPageSize = 256
export const scheduleHistoryPageSize = (query: ScheduleHistoryQuery): number => query.limit ?? (query.bucketStarts ? summaryPageSize : 25)
function historyWindow(value: Record<string, unknown>, code: string, maxMs: number): Pick<ScheduleHistoryQuery, 'scheduleId' | 'from' | 'to'> {
  string(value.scheduleId, code)
  integer(value.from, code)
  integer(value.to, code)
  if (value.to <= value.from || value.to - value.from > maxMs || value.to > 8_640_000_000_000_000)
    invalid('Choose a nonempty window within the requested schedule history range.', code)
  return { scheduleId: value.scheduleId, from: value.from, to: value.to }
}
function historyCursor(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/u.test(value)) invalid('Use the original schedule history cursor.', code)
}
function parseScheduleHistoryQuery(value: unknown): ScheduleHistoryQuery {
  const code = 'INVALID_CONTROL_REQUEST', p = rpcRecord(value, ['scheduleId', 'from', 'to', 'limit', 'cursor', 'bucketStarts'], code)
  const window = historyWindow(p, code, p.bucketStarts === undefined ? historyMaxMs : maxSummaryWindowMs)
  let bucketStarts: number[] | undefined
  if (p.bucketStarts !== undefined) {
    if (!Array.isArray(p.bucketStarts) || !p.bucketStarts.length || p.bucketStarts.length > maxBucketCount || p.bucketStarts[0] !== window.from)
      invalid('Use the UTC start of each visible bucket, beginning at the window start.', code)
    bucketStarts = Array.from(p.bucketStarts, (at, i) => {
      integer(at, code)
      if (at >= window.to || i > 0 && at <= (p.bucketStarts as number[])[i - 1]!) invalid('Schedule bucket starts must increase inside the requested window.', code)
      return at
    })
  }
  if (p.limit !== undefined) {
    integer(p.limit, code, 1)
    if (p.limit > (bucketStarts ? summaryPageSize : 100)) invalid('The schedule history page size exceeds its supported limit.', code)
  }
  if (p.cursor !== undefined) historyCursor(p.cursor, code)
  return { ...window, ...(bucketStarts ? { bucketStarts } : {}), ...(p.limit === undefined ? {} : { limit: p.limit }), ...(p.cursor === undefined ? {} : { cursor: p.cursor }) }
}
export function parseScheduleTarget(value: unknown, code = 'INVALID_CONTROL_REQUEST'): ContinuousProgressTarget {
  const p = rpcRecord(value, ['hostId','agentSessionId','providerId','workspacePath'], code)
  for (const key of ['hostId','agentSessionId','providerId','workspacePath']) string(p[key], code)
  return p as ContinuousProgressTarget
}
export function parseScheduleRpcParams<M extends ScheduleMethod>(method: M, value: unknown): ScheduleParamsMap[M] {
  if (method === 'schedule.history') return parseScheduleHistoryQuery(value) as ScheduleParamsMap[M]
  const code = 'INVALID_CONTROL_REQUEST'
  const p = rpcRecord(value, method === 'schedule.list' ? ['target','scope'] : method === 'schedule.inspect' ? ['scheduleId','operationId'] :
    method === 'schedule.create' ? ['inputEpoch','target','calendar','afterMs','everyMs','prompt','operationId','checkIn','managedSource'] : method === 'schedule.update' ? ['scheduleId','expectedRevision','operationId','everyMs'] : ['scheduleId','expectedRevision','operationId'], code)
  if (method === 'schedule.list') {
    if (p.target !== undefined && p.scope !== undefined) invalid('Choose an exact schedule target or execution-directory scope, not both.', code)
    if (p.target !== undefined) parseScheduleTarget(p.target)
    if (p.scope !== undefined) {
      const scope = rpcRecord(p.scope, ['hostId','workspacePath'], code)
      string(scope.hostId, code); string(scope.workspacePath, code)
    }
  }
  else if (method === 'schedule.inspect') {
    if ((p.scheduleId !== undefined) === (p.operationId !== undefined)) invalid('Inspect requires exactly one schedule ID or original operation ID.', code)
    string(p.scheduleId ?? p.operationId, code)
  } else if (method === 'schedule.create') {
    optionalInputEpoch(p.inputEpoch)
    if (p.managedSource !== undefined) parseAutomaticInputSource(p.managedSource)
    parseScheduleTarget(p.target); string(p.prompt, code, 64 * 1024); string(p.operationId, code)
    parseAgentScheduleTiming({ calendar: p.calendar, afterMs: p.afterMs, everyMs: p.everyMs, checkIn: p.checkIn }, code)
  } else { if (method === 'schedule.update') parseAgentScheduleTiming({ everyMs: p.everyMs }); string(p.scheduleId, code); string(p.operationId, code); integer(p.expectedRevision, code, 1) }
  return p as ScheduleParamsMap[M]
}
export function parseScheduleRecord(value: unknown): ContinuousProgressLoop {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, ['inputEpoch','loopId','hostId','agentSessionId','providerId','workspacePath','calendar','afterMs','everyMs','checkIn','checkInState','revision','creationOperationId','lastMutation','futureIntentId','lastOccurrenceAt','intervalMs','prompt','nextCheckAt','status','pause','pendingCompletion','lastCompletionId','lastTickId','lastOutcome','lastTickAt','lastDecision','taskSource','managedSource','currentDefinition','guidanceAdoptions','lastInputRef'], code)
  optionalInputEpoch(p.inputEpoch)
  if (p.managedSource !== undefined) parseAutomaticInputSource(p.managedSource)
  if (p.currentDefinition !== undefined) parseContinuousProgressDefinition(p.currentDefinition)
  if (p.guidanceAdoptions !== undefined) parseContinuousProgressGuidanceAdoptions(p.guidanceAdoptions)
  if (p.lastInputRef !== undefined) {
    const reference = parseContinuousProgressInputReference(p.lastInputRef, code)
    const definitions = [
      { intentId: p.currentDefinition ? parseContinuousProgressDefinition(p.currentDefinition).baseIntentId : p.futureIntentId, operationId: p.creationOperationId },
      ...(p.currentDefinition ? [parseContinuousProgressDefinition(p.currentDefinition)] : []),
      ...(p.guidanceAdoptions ? parseContinuousProgressGuidanceAdoptions(p.guidanceAdoptions).flatMap(item => [item.oldDefinition, item.newDefinition]) : [])
    ]
    if (reference.inputKey.agentSessionId !== p.agentSessionId || !sameAutomaticInputSource(reference.managedSource, p.managedSource as AutomaticInputSource | undefined) ||
      !definitions.some(item => item.intentId === reference.futureIntent.intentId && item.operationId === reference.definitionOperationId)) invalid('The original input reference belongs to another schedule target, source or definition.', code)
  }
  parseScheduleTarget({ hostId: p.hostId, agentSessionId: p.agentSessionId, providerId: p.providerId, workspacePath: p.workspacePath }, code)
  string(p.loopId, code); string(p.prompt, code, 64 * 1024); integer(p.intervalMs, code, 1); integer(p.nextCheckAt, code)
  if (!['active','paused','stopped'].includes(p.status as string)) invalid('Schedule state is invalid.', code)
  if (p.pause !== undefined) validateContinuousProgressPause(p.pause)
  if (p.calendar !== undefined || p.afterMs !== undefined || p.everyMs !== undefined || p.checkIn !== undefined)
    parseAgentScheduleTiming({ calendar: p.calendar, afterMs: p.afterMs, everyMs: p.everyMs, checkIn: p.checkIn }, code)
  if (p.checkIn !== undefined) parseAgentScheduleCheckIn(p.checkIn, code)
  if (p.checkInState !== undefined) {
    if (p.checkIn === undefined) invalid('Quiet follow-up state requires its saved policy.', code)
    const state = rpcRecord(p.checkInState, ['lastClaimAt','budgetDate','budgetUsed','unanswered'], code)
    for (const key of ['lastClaimAt','budgetUsed']) if (state[key] !== undefined) integer(state[key], code)
    if (state.budgetDate !== undefined && (typeof state.budgetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(state.budgetDate))) invalid('Quiet follow-up budget day is invalid.', code)
    if ((state.budgetDate === undefined) !== (state.budgetUsed === undefined)) invalid('Quiet follow-up budget is incomplete.', code)
    if (state.unanswered !== undefined) {
      const unanswered = rpcRecord(state.unanswered, ['humanId','humanCreatedAt','claimAt'], code)
      string(unanswered.humanId, code); integer(unanswered.humanCreatedAt, code); integer(unanswered.claimAt, code)
    }
  }
  if (p.revision !== undefined) integer(p.revision, code, 1)
  for (const key of ['creationOperationId','futureIntentId','lastCompletionId','lastTickId','lastDecision']) if (p[key] !== undefined) string(p[key], code, 64 * 1024)
  for (const key of ['lastOccurrenceAt','lastTickAt']) if (p[key] !== undefined) integer(p[key], code)
  if (p.lastOutcome !== undefined && !['sent','skipped','unknown'].includes(p.lastOutcome as string)) invalid('Schedule outcome is invalid.', code)
  if (p.lastMutation !== undefined) {
    const m = rpcRecord(p.lastMutation, ['operationId','action','expectedRevision','requestDigest','phase'], code)
    const progress = p.calendar === undefined && p.afterMs === undefined && p.everyMs === undefined && (p.taskSource as { kind?: string } | undefined)?.kind !== 'goal'
    string(m.operationId, code); integer(m.expectedRevision, code, m.action === 'update' || progress ? 0 : 1)
    if (m.action === 'update') {
      if (p.calendar !== undefined || p.afterMs !== undefined || p.taskSource && (p.taskSource as {kind?: string}).kind === 'goal' || m.phase !== undefined || typeof m.requestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(m.requestDigest)) invalid('Progress update receipt is invalid.', code)
    } else if (progress) {
      if (!['pause','resume','stop','check'].includes(m.action as string) || typeof m.requestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(m.requestDigest) || !['prepared','settled'].includes(m.phase as string)) invalid('Progress action receipt is invalid.', code)
    } else if (!['pause','resume','cancel'].includes(m.action as string) || m.requestDigest !== undefined || m.phase !== undefined) invalid('Schedule action is invalid.', code)
  }
  if (p.pendingCompletion !== undefined) {
    const claim = rpcRecord(p.pendingCompletion, ['id','operationId','condition','inputByte','prompt','agentMuxNote','futureIntent'], code)
    string(claim.id, code); string(claim.operationId, code)
    if (claim.condition !== undefined) validateAgentPromptCondition(claim.condition)
    if (claim.inputByte !== undefined) integer(claim.inputByte, code)
    for (const key of ['prompt','agentMuxNote']) if (claim[key] !== undefined) string(claim[key], code, 64 * 1024)
    if (claim.futureIntent !== undefined) {
      const occurrence = rpcRecord(claim.futureIntent, ['intentId','occurrenceAt'], code)
      string(occurrence.intentId, code); integer(occurrence.occurrenceAt, code)
    }
  }
  if (p.taskSource !== undefined) {
    parseProgressTaskSource(p.taskSource, code)
  }
  return structuredClone(p) as ContinuousProgressLoop
}
/** Original Feature source shape, shared by public progress arguments and records. */
export function parseProgressTaskSource(value: unknown, code: 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR' = 'INVALID_CONTROL_REQUEST'): Exclude<import('./continuous-progress-scheduler.js').ContinuousProgressTaskSource, { kind: 'goal' }> {
  const source = rpcRecord(value, ['kind','root','ownerId','readerPath'], code)
  if (source.kind !== undefined && source.kind !== 'feature') invalid('The task source kind is invalid.', code)
  for (const key of ['root','ownerId','readerPath']) string(source[key], code)
  return source as Exclude<import('./continuous-progress-scheduler.js').ContinuousProgressTaskSource, { kind: 'goal' }>
}
export function validateScheduleRpcResult<M extends ScheduleMethod>(method: M, value: unknown, params?: ScheduleParamsMap[M]): ScheduleResultMap[M] {
  if (method === 'schedule.history') return parseScheduleHistoryPage(value, params as ScheduleHistoryQuery | undefined) as ScheduleResultMap[M]
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, method === 'schedule.list' ? ['schedules','executionScope'] : method === 'schedule.inspect' ? ['schedule','executionScope','input'] : ['schedule','executionScope','diskDurability'], code)
  if (p.executionScope !== 'connected-host') invalid('The schedule execution scope is unconfirmed.', code)
  if (method === 'schedule.list') {
    if (!Array.isArray(p.schedules) || p.schedules.length > 4096) invalid('Schedule results must be bounded.', code);
    (p.schedules as unknown[]).forEach(parseScheduleRecord)
  } else if (p.schedule !== null || method !== 'schedule.inspect') parseScheduleRecord(p.schedule)
  if (method === 'schedule.inspect' && p.input !== undefined) {
    const reference = (p.schedule as ContinuousProgressLoop | null)?.lastInputRef
    if (!reference) invalid('Input observation requires its original saved schedule reference.', code)
    parseContinuousProgressInputReading(p.input, reference)
  }
  if (method !== 'schedule.list' && method !== 'schedule.inspect' && p.diskDurability !== 'confirmed') invalid('Schedule persistence is unconfirmed.', code)
  const records = method === 'schedule.list' ? p.schedules as ContinuousProgressLoop[] : p.schedule === null ? [] : [p.schedule as ContinuousProgressLoop]
  for (const schedule of records) {
    if (!isAgentSchedule(schedule) || !schedule.revision || !schedule.futureIntentId || !schedule.creationOperationId) invalid('Schedule identity or admission is unconfirmed.', code)
    if (params) {
      if (method === 'schedule.list') {
        const { target, scope } = params as ScheduleParamsMap['schedule.list']
        if (target && ['hostId','agentSessionId','providerId','workspacePath'].some(key => schedule[key as keyof ContinuousProgressTarget] !== target[key as keyof ContinuousProgressTarget])) invalid('Schedule list returned another target.', code)
        if (scope && (schedule.hostId !== scope.hostId || schedule.workspacePath !== scope.workspacePath)) invalid('Schedule list returned another execution-directory scope.', code)
      } else if (method === 'schedule.create') {
        const request = params as ScheduleParamsMap['schedule.create']
        if (schedule.inputEpoch !== request.inputEpoch || schedule.creationOperationId !== request.operationId || schedule.prompt !== request.prompt || JSON.stringify(schedule.calendar) !== JSON.stringify(request.calendar) || schedule.afterMs !== request.afterMs || schedule.everyMs !== request.everyMs || JSON.stringify(schedule.checkIn) !== JSON.stringify(request.checkIn) || !sameAutomaticInputSource(schedule.managedSource, request.managedSource) ||
            ['hostId','agentSessionId','providerId','workspacePath'].some(key => schedule[key as keyof ContinuousProgressTarget] !== request.target[key as keyof ContinuousProgressTarget])) invalid('Schedule receipt belongs to different intent or target.', code)
      } else if (method === 'schedule.inspect') {
        const request = params as ScheduleParamsMap['schedule.inspect']
        if (request.scheduleId ? schedule.loopId !== request.scheduleId : ![schedule.creationOperationId, schedule.lastMutation?.operationId, schedule.pendingCompletion?.operationId, schedule.lastTickId, ...(schedule.lastInputRef ? [agentPromptInputId(schedule.lastInputRef.inputKey)] : [])].includes(request.operationId) && !schedule.guidanceAdoptions?.some(receipt => receipt.operationId === request.operationId)) invalid('Schedule inspection returned another identity.', code)
      } else {
        const request = params as ScheduleMutation
        if (schedule.loopId !== request.scheduleId || schedule.revision !== request.expectedRevision + 1 || schedule.lastMutation?.operationId !== request.operationId || schedule.lastMutation.action !== method.slice('schedule.'.length)) invalid('Schedule mutation receipt does not match its original request.', code)
        if (method === 'schedule.update') { if (schedule.everyMs !== (request as ScheduleParamsMap['schedule.update']).everyMs) invalid('Schedule interval receipt differs from its original update.', code); continue }
        const expectedStatus = method === 'schedule.resume' ? 'active' : method === 'schedule.pause' ? 'paused' : 'stopped'
        if (schedule.status !== expectedStatus) invalid('Schedule mutation did not establish its requested state.', code)
      }
    }
  }
  return p as ScheduleResultMap[M]
}

function parseScheduleHistoryPage(value: unknown, request?: ScheduleHistoryQuery): ScheduleHistoryPage {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, ['scheduleId', 'from', 'to', 'executionScope', 'coverage', 'entries', 'nextCursor', 'buckets'], code)
  const grouped = p.buckets !== undefined
  const window = historyWindow(p, code, grouped ? maxSummaryWindowMs : historyMaxMs)
  if (p.executionScope !== 'connected-host' || p.coverage !== 'recorded-inputs' && p.coverage !== 'unconfirmed' ||
      request && (request.scheduleId !== window.scheduleId || request.from !== window.from || request.to !== window.to) ||
      request && grouped !== !!request.bucketStarts ||
      !Array.isArray(p.entries) || (grouped && p.entries.length !== 0) || p.entries.length > (request ? scheduleHistoryPageSize(request) : 100))
    invalid('The schedule history page does not match its requested scope.', code)
  if (p.nextCursor !== null) {
    historyCursor(p.nextCursor, code)
    if (p.nextCursor === request?.cursor) invalid('The schedule history cursor did not advance.', code)
  }
  let before = window.to
  const entries = (p.entries as unknown[]).map(entry => {
    const original = rpcRecord(entry, ['operationId', 'occurrenceAt', 'runId', 'recap', 'delivery', 'nativeResult'], code)
    string(original.operationId, code)
    integer(original.occurrenceAt, code)
    if (original.occurrenceAt < window.from || original.occurrenceAt >= window.to || original.occurrenceAt > before)
      invalid('A schedule history entry is outside its original time window or order.', code)
    before = original.occurrenceAt
    const runId = original.runId
    string(runId, code)
    let recap: ScheduleHistoryEntry['recap'] = null
    if (original.recap !== null) {
      const value = rpcRecord(original.recap, ['text', 'truncated'], code)
      const { text, truncated } = value
      if (typeof text !== 'string' || !text.length || text.length > scheduleEventRecapLimit || typeof truncated !== 'boolean')
        invalid('The original schedule event recap is invalid.', code)
      recap = { text, truncated }
    }
    return { operationId: original.operationId, occurrenceAt: original.occurrenceAt, runId, recap,
      ...parseContinuousProgressDelivery(original.delivery, original.nativeResult) }
  })
  const buckets = grouped ? parseHistoryBuckets(p.buckets, window, request) : undefined
  return { ...window, executionScope: 'connected-host', coverage: p.coverage, entries, nextCursor: p.nextCursor, ...(buckets ? { buckets } : {}) }
}

function parseHistoryBuckets(value: unknown, window: { from: number; to: number }, request?: ScheduleHistoryQuery): ScheduleHistoryBucket[] {
  const code = 'CONTROL_PROTOCOL_ERROR'
  if (!Array.isArray(value) || value.length > maxBucketCount) invalid('Expected bounded groups of recorded schedule inputs.', code)
  let previousEnd = window.from, total = 0
  const ends = request?.bucketStarts && new Map(request.bucketStarts.map((at, i, starts) => [at, starts[i + 1] ?? window.to]))
  return Array.from(value, item => {
    const bucket = rpcRecord(item, ['from', 'to', 'groups'], code)
    const { from, to } = bucket
    integer(from, code); integer(to, code)
    if (from < previousEnd || to <= from || to > window.to || ends && ends.get(from) !== to ||
        !Array.isArray(bucket.groups) || !bucket.groups.length || bucket.groups.length > summaryPageSize)
      invalid('A history bucket does not match the original requested range.', code)
    previousEnd = to
    const seen = new Set<string>()
    const groups = Array.from(bucket.groups, value => {
      const group = rpcRecord(value, ['delivery', 'nativeState', 'count', 'originalLabel', 'firstAt', 'lastAt'], code)
      const { count, originalLabel, firstAt, lastAt } = group
      if (originalLabel !== null && (typeof originalLabel !== 'string' || !originalLabel.length ||
          originalLabel.length > scheduleEventLabelLimit || /[\r\n\u2028\u2029]/u.test(originalLabel))) invalid('The original schedule event label is invalid.', code)
      integer(count, code, 1); integer(firstAt, code); integer(lastAt, code)
      const { delivery, nativeState } = parseContinuousProgressOutcome(group.delivery, group.nativeState)
      const key = delivery + '/' + nativeState
      total += count
      if (seen.has(key) || firstAt < from || lastAt < firstAt || lastAt >= to || count === 1 && firstAt !== lastAt ||
          total > (request ? scheduleHistoryPageSize(request) : summaryPageSize)) invalid('The history group count or recorded times are invalid.', code)
      seen.add(key)
      return { delivery, nativeState, count, originalLabel, firstAt, lastAt }
    })
    return { from, to, groups }
  })
}
export function isScheduleRpcResult(method: ScheduleMethod, value: unknown): boolean {
  try { validateScheduleRpcResult(method, value); return true } catch { return false }
}
