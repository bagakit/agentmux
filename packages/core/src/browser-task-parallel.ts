import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseBrowserTaskInvocation, type BrowserTaskInvocation } from './browser-task-invocation.js'
import { isBrowserTaskRunStatus, type BrowserTaskRunStatus } from './browser-task-status.js'

export type BrowserTaskParallelTarget = BrowserTaskInvocation & { id: string; browserId: string; profileId: string }
export type BrowserTaskParallelInput = { operationId: string; concurrency?: number; targets: BrowserTaskParallelTarget[] }
/** This tuple is emitted by the original owner; it is never accepted as execution input. */
export type BrowserTaskParallelContinuationInput = BrowserTaskInvocation & { continuationId: string; expectedRevision: string }
export type BrowserTaskParallelContinuation = { id: string; targetId: string; admission: 'confirmed' | 'unknown' | 'refused'; warning?: string }
export type BrowserTaskParallelContinuationReceipt = { run: BrowserTaskParallelSummary; continuation: BrowserTaskParallelContinuation }
export type BrowserTaskParallelBinding = { operationId: string; targetId: string; sourceBrowserId: string }
export type BrowserTaskParallelCounts = { queued: number; preparing: number; running: number; waitingHuman: number; ready: number; completed: number; interrupted: number; failed: number; stopped: number }
export type BrowserTaskParallelSummary = {
  operationId: string; browserId: string; assetId: string; version: number; status: BrowserTaskRunStatus
  targetCount: number; requestedConcurrency: number; concurrency: number; counts: BrowserTaskParallelCounts
  startedAt: number; updatedAt: number; admission: 'confirmed' | 'unknown'; warning?: string
}
export type BrowserTaskParallelTargetProgress = {
  id: string; browserId: string; profileId: string; phase: 'queued' | 'preparing' | 'bound' | 'failed' | 'stopped'
  run?: { id: string; status: BrowserTaskRunStatus; nextStep: number; operationCount: number }
  error?: { code: string; message: string }
  continuationRevision?: string
  waitingForProfile?: { operationId: string; targetId: string }
}
export type BrowserTaskParallelInspection = {
  run: BrowserTaskParallelSummary; targets: BrowserTaskParallelTargetProgress[]; continuation?: BrowserTaskParallelContinuation | null
  page: { after: string | null; limit: number; nextAfter: string | null }
}
const bad = (message: string, request = false): never => { throw new AgentMuxError(message, request ? 'INVALID_CONTROL_REQUEST' : 'CONTROL_PROTOCOL_ERROR') }
function id(value: unknown, request = false): string {
  if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u0020\u007f]/u.test(value)) bad('Task execution needs an exact original identity.', request)
  return value as string
}
function count(value: unknown, request = false, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) bad('Task execution count is invalid.', request)
  return value as number
}
export function parseBrowserTaskParallelInput(value: unknown): BrowserTaskParallelInput {
  const row = rpcRecord(value, ['operationId', 'concurrency', 'targets'])
  // One explicit request is an in-memory carrier. Retained history is not subject to this transport bound.
  if (Buffer.byteLength(JSON.stringify(row)) > 1_048_576 || !Array.isArray(row.targets) || !row.targets.length) bad('Provide a nonempty bounded explicit target set.', true)
  const targets = (row.targets as unknown[]).map(value => {
    const target = rpcRecord(value, ['id', 'browserId', 'profileId', 'parameters', 'calls'])
    const invocation = parseBrowserTaskInvocation({ parameters: target.parameters, ...(target.calls === undefined ? {} : { calls: target.calls }) })
    return { id: id(target.id, true), browserId: id(target.browserId, true), profileId: id(target.profileId, true), ...invocation }
  })
  if (new Set(targets.map(target => target.id)).size !== targets.length || new Set(targets.map(target => target.browserId)).size !== targets.length) bad('Each target and Browser occurs once in an explicit execution set.', true)
  return { operationId: id(row.operationId, true), targets, ...(row.concurrency === undefined ? {} : { concurrency: count(row.concurrency, true, 1) }) }
}
export function parseBrowserTaskParallelContinuationInput(value: unknown): BrowserTaskParallelContinuationInput {
  const row = rpcRecord(value, ['continuationId', 'expectedRevision', 'parameters', 'calls'])
  if (typeof row.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(row.expectedRevision)) bad('An exact original continuation revision is required.', true)
  const invocation = parseBrowserTaskInvocation({ parameters: row.parameters, ...(row.calls === undefined ? {} : { calls: row.calls }) })
  return { continuationId: id(row.continuationId, true), expectedRevision: row.expectedRevision as string, ...invocation }
}
export function parseBrowserTaskParallelContinuation(value: unknown): BrowserTaskParallelContinuation {
  const row = rpcRecord(value, ['id', 'targetId', 'admission', 'warning'], 'CONTROL_PROTOCOL_ERROR')
  if (!['confirmed', 'unknown', 'refused'].includes(row.admission as string) || row.warning !== undefined && (typeof row.warning !== 'string' || row.warning.length > 4096)) bad('Original continuation receipt is invalid.')
  return { id: id(row.id), targetId: id(row.targetId), admission: row.admission as BrowserTaskParallelContinuation['admission'], ...(row.warning === undefined ? {} : { warning: row.warning as string }) }
}
export function parseBrowserTaskParallelContinuationReceipt(value: unknown): BrowserTaskParallelContinuationReceipt {
  const row = rpcRecord(value, ['run', 'continuation'], 'CONTROL_PROTOCOL_ERROR')
  return { run: parseBrowserTaskParallelSummary(row.run), continuation: parseBrowserTaskParallelContinuation(row.continuation) }
}
export function parseBrowserTaskParallelBinding(value: unknown): BrowserTaskParallelBinding {
  const row = rpcRecord(value, ['operationId', 'targetId', 'sourceBrowserId'], 'CONTROL_PROTOCOL_ERROR')
  return { operationId: id(row.operationId), targetId: id(row.targetId), sourceBrowserId: id(row.sourceBrowserId) }
}
export function parseBrowserTaskParallelSummary(value: unknown): BrowserTaskParallelSummary {
  const row = rpcRecord(value, ['operationId', 'browserId', 'assetId', 'version', 'status', 'targetCount', 'requestedConcurrency', 'concurrency', 'counts', 'startedAt', 'updatedAt', 'admission', 'warning'], 'CONTROL_PROTOCOL_ERROR')
  if (!isBrowserTaskRunStatus(row.status) || row.admission !== 'confirmed' && row.admission !== 'unknown') bad('Task execution summary has no authoritative status or admission fact.')
  const keys = ['queued', 'preparing', 'running', 'waitingHuman', 'ready', 'completed', 'interrupted', 'failed', 'stopped'] as const
  const rawCounts = rpcRecord(row.counts, keys, 'CONTROL_PROTOCOL_ERROR')
  const counts = Object.fromEntries(keys.map(key => [key, count(rawCounts[key])])) as BrowserTaskParallelCounts
  const targetCount = count(row.targetCount, false, 1), concurrency = count(row.concurrency, false, 1), requestedConcurrency = count(row.requestedConcurrency, false, 1)
  if (Object.values(counts).reduce((sum, value) => sum + value, 0) !== targetCount || concurrency > Math.min(requestedConcurrency, targetCount)) bad('Task execution counts or admission limits do not match the original set.')
  if (row.warning !== undefined && (typeof row.warning !== 'string' || row.warning.length > 4096)) bad('Task execution warning is invalid.')
  return { operationId: id(row.operationId), browserId: id(row.browserId), assetId: id(row.assetId), version: count(row.version, false, 1), status: row.status as BrowserTaskRunStatus,
    targetCount, concurrency, requestedConcurrency, counts, startedAt: count(row.startedAt), updatedAt: count(row.updatedAt), admission: row.admission as 'confirmed' | 'unknown',
    ...(row.warning === undefined ? {} : { warning: row.warning as string }) }
}
export function parseBrowserTaskParallelInspection(value: unknown): BrowserTaskParallelInspection {
  const row = rpcRecord(value, ['run', 'targets', 'page', 'continuation'], 'CONTROL_PROTOCOL_ERROR')
  const run = parseBrowserTaskParallelSummary(row.run), page = rpcRecord(row.page, ['after', 'limit', 'nextAfter'], 'CONTROL_PROTOCOL_ERROR')
  const limit = count(page.limit, false, 1)
  if (limit > 64 || !Array.isArray(row.targets) || row.targets.length > limit) bad('Task execution inspection page is invalid.')
  const targets = (row.targets as unknown[]).map(value => {
    const target = rpcRecord(value, ['id', 'browserId', 'profileId', 'phase', 'run', 'error', 'waitingForProfile', 'continuationRevision'], 'CONTROL_PROTOCOL_ERROR')
    if (!['queued', 'preparing', 'bound', 'failed', 'stopped'].includes(target.phase as string)) bad('Task target preparation phase is invalid.')
    let original: BrowserTaskParallelTargetProgress['run']
    if (target.run !== undefined) {
      const child = rpcRecord(target.run, ['id', 'status', 'nextStep', 'operationCount'], 'CONTROL_PROTOCOL_ERROR')
      if (!isBrowserTaskRunStatus(child.status)) bad('Task target run status is invalid.')
      original = { id: id(child.id), status: child.status as BrowserTaskRunStatus, nextStep: count(child.nextStep), operationCount: count(child.operationCount) }
    }
    if ((target.phase === 'bound') !== !!original) bad('Task target does not retain its original run binding.')
    let error: BrowserTaskParallelTargetProgress['error'], waitingForProfile: BrowserTaskParallelTargetProgress['waitingForProfile']
    if (target.error !== undefined) {
      const raw = rpcRecord(target.error, ['code', 'message'], 'CONTROL_PROTOCOL_ERROR')
      if (typeof raw.message !== 'string' || raw.message.length > 4096) bad('Task target error is invalid.')
      error = { code: id(raw.code), message: raw.message as string }
    }
    if (target.waitingForProfile !== undefined) {
      const raw = rpcRecord(target.waitingForProfile, ['operationId', 'targetId'], 'CONTROL_PROTOCOL_ERROR')
      waitingForProfile = { operationId: id(raw.operationId), targetId: id(raw.targetId) }
    }
    if (target.continuationRevision !== undefined && (typeof target.continuationRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(target.continuationRevision))) bad('Original continuation revision is invalid.')
    return { id: id(target.id), browserId: id(target.browserId), profileId: id(target.profileId), phase: target.phase as BrowserTaskParallelTargetProgress['phase'],
      ...(target.continuationRevision === undefined ? {} : { continuationRevision: target.continuationRevision as string }), ...(original ? { run: original } : {}), ...(error ? { error } : {}), ...(waitingForProfile ? { waitingForProfile } : {}) }
  })
  if (new Set(targets.map(target => target.id)).size !== targets.length) bad('Task target identities are duplicated in this page.')
  const after = page.after === null ? null : id(page.after), nextAfter = page.nextAfter === null ? null : id(page.nextAfter)
  if (nextAfter !== null && nextAfter !== targets.at(-1)?.id) bad('Task execution continuation does not name its original page boundary.')
  return { run, targets, page: { after, limit, nextAfter }, ...(row.continuation === undefined ? {} : { continuation: row.continuation === null ? null : parseBrowserTaskParallelContinuation(row.continuation) }) }
}

export type BrowserTaskParallelList = { runs: BrowserTaskParallelSummary[]; page: { before: string | null; limit: number; nextBefore: string | null } }
export function parseBrowserTaskParallelList(value: unknown): BrowserTaskParallelList {
  const row = rpcRecord(value, ['runs', 'page'], 'CONTROL_PROTOCOL_ERROR'), page = rpcRecord(row.page, ['before', 'limit', 'nextBefore'], 'CONTROL_PROTOCOL_ERROR')
  const limit = count(page.limit, false, 1)
  if (limit > 64 || !Array.isArray(row.runs) || row.runs.length > limit) bad('Task execution history page is invalid.')
  const runs = (row.runs as unknown[]).map(parseBrowserTaskParallelSummary)
  const before = page.before === null ? null : id(page.before), nextBefore = page.nextBefore === null ? null : id(page.nextBefore)
  if (new Set(runs.map(run => run.operationId)).size !== runs.length || nextBefore !== null && nextBefore !== runs.at(-1)?.operationId) bad('Task execution history boundary is invalid.')
  return { runs, page: { before, limit, nextBefore } }
}
