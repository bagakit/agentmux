import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Disk observations of the original Profile's Cache API storage, not memory or website sign-ins. */
export type BrowserProfileStorageUsage = { logicalBytes: number; allocatedBytes: number | null; complete: boolean }
export type BrowserProfileStorageSite = { origin: string; storageKeys: string[]; usage: BrowserProfileStorageUsage }
export type BrowserProfileStorageSelection = Pick<BrowserProfileStorageSite, 'origin' | 'storageKeys'>
export type BrowserProfileStorageSnapshot = {
  profileId: string; profileRevision: string; observedAt: number; usage: BrowserProfileStorageUsage
  sites: BrowserProfileStorageSite[]; unattributed: BrowserProfileStorageUsage; issues: string[]
}
export type BrowserProfileStorageReceipt = {
  profileId: string; expectedRevision: string; operationId: string; sites: BrowserProfileStorageSelection[]
  status: 'awaiting-confirmation' | 'pending' | 'completed' | 'cancelled' | 'partial' | 'unknown' | 'failed'
  requestedAt: number; finishedAt: number | null
  results: { storageKey: string; status: 'not-dispatched' | 'acknowledged' | 'unknown' }[]
  before: BrowserProfileStorageSnapshot | null; after: BrowserProfileStorageSnapshot | null; issues: string[]
}
export type BrowserProfileStorageInspect = { snapshot: BrowserProfileStorageSnapshot; receipt: BrowserProfileStorageReceipt | null; pending: BrowserProfileStorageReceipt[] }
export type BrowserProfileStorageClearInput = { profileId: string; expectedRevision: string; operationId: string; sites: BrowserProfileStorageSelection[] }
export const BROWSER_PROFILE_STORAGE_OPERATIONS = ['browser.profile.storage.inspect', 'browser.profile.storage.clear'] as const
export type BrowserProfileStorageOperation = typeof BROWSER_PROFILE_STORAGE_OPERATIONS[number]
export const isBrowserProfileStorageOperation = (value: unknown): value is BrowserProfileStorageOperation => typeof value === 'string' && (BROWSER_PROFILE_STORAGE_OPERATIONS as readonly string[]).includes(value)
export type BrowserProfileStoragePayload =
  | { operation: 'browser.profile.storage.inspect'; profileId: string; operationId?: string }
  | ({ operation: 'browser.profile.storage.clear' } & BrowserProfileStorageClearInput)
export type BrowserProfileStorageResult =
  | ({ operation: 'browser.profile.storage.inspect' } & BrowserProfileStorageInspect)
  | { operation: 'browser.profile.storage.clear'; receipt: BrowserProfileStorageReceipt }

function invalid(): never { throw new AgentMuxError('Invalid original Profile offline storage facts.', 'CONTROL_PROTOCOL_ERROR') }
const text = (value: unknown): string => { if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid(); return value as string }
const count = (value: unknown): number => { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); return value as number }
const nullableCount = (value: unknown) => value === null ? null : count(value)
const record = (value: unknown, fields?: readonly string[]) => rpcRecord(value, fields, 'CONTROL_PROTOCOL_ERROR')
function list<T>(value: unknown, parse: (value: unknown) => T): T[] { if (!Array.isArray(value)) invalid(); return (value as unknown[]).map(parse) }
function keys(value: unknown): string[] { const result = list(value, text); if (!result.length || new Set(result).size !== result.length) invalid(); return result }
function selections(value: unknown): BrowserProfileStorageSelection[] {
  const sites = list(value, value => { const r = record(value, ['origin', 'storageKeys']); return { origin: text(r.origin), storageKeys: keys(r.storageKeys) } })
  const allKeys = sites.flatMap(site => site.storageKeys)
  if (!sites.length || new Set(sites.map(site => site.origin)).size !== sites.length || new Set(allKeys).size !== allKeys.length) invalid()
  return sites
}
function usage(value: unknown): BrowserProfileStorageUsage {
  const r = record(value, ['logicalBytes', 'allocatedBytes', 'complete'])
  if (typeof r.complete !== 'boolean') invalid()
  return { logicalBytes: count(r.logicalBytes), allocatedBytes: nullableCount(r.allocatedBytes), complete: r.complete as boolean }
}
export function parseBrowserProfileStorageSnapshot(value: unknown): BrowserProfileStorageSnapshot {
  const r = record(value, ['profileId', 'profileRevision', 'observedAt', 'usage', 'sites', 'unattributed', 'issues'])
  const snapshot: BrowserProfileStorageSnapshot = { profileId: text(r.profileId), profileRevision: text(r.profileRevision), observedAt: count(r.observedAt), usage: usage(r.usage),
    sites: list(r.sites, value => { const site = record(value, ['origin', 'storageKeys', 'usage']); return { origin: text(site.origin), storageKeys: keys(site.storageKeys), usage: usage(site.usage) } }),
    unattributed: usage(r.unattributed), issues: list(r.issues, text) }
  const allKeys = snapshot.sites.flatMap(site => site.storageKeys)
  if (new Set(allKeys).size !== allKeys.length || new Set(snapshot.sites.map(site => site.origin)).size !== snapshot.sites.length) invalid()
  return snapshot
}
export function parseBrowserProfileStorageReceipt(value: unknown): BrowserProfileStorageReceipt {
  const r = record(value, ['profileId', 'expectedRevision', 'operationId', 'sites', 'status', 'requestedAt', 'finishedAt', 'results', 'before', 'after', 'issues'])
  if (!['awaiting-confirmation', 'pending', 'completed', 'cancelled', 'partial', 'unknown', 'failed'].includes(r.status as string)) invalid()
  const receipt: BrowserProfileStorageReceipt = { profileId: text(r.profileId), expectedRevision: text(r.expectedRevision), operationId: text(r.operationId), sites: selections(r.sites),
    status: r.status as BrowserProfileStorageReceipt['status'], requestedAt: count(r.requestedAt), finishedAt: nullableCount(r.finishedAt),
    results: list(r.results, value => { const item = record(value, ['storageKey', 'status']); if (!['not-dispatched', 'acknowledged', 'unknown'].includes(item.status as string)) invalid(); return { storageKey: text(item.storageKey), status: item.status as BrowserProfileStorageReceipt['results'][number]['status'] } }),
    before: r.before === null ? null : parseBrowserProfileStorageSnapshot(r.before), after: r.after === null ? null : parseBrowserProfileStorageSnapshot(r.after), issues: list(r.issues, text) }
  const storageKeys = receipt.sites.flatMap(site => site.storageKeys)
  if (receipt.results.length !== storageKeys.length || receipt.results.some((item, index) => item.storageKey !== storageKeys[index]) ||
    receipt.before && receipt.before.profileId !== receipt.profileId || receipt.after && receipt.after.profileId !== receipt.profileId) invalid()
  if (receipt.status === 'completed' && receipt.results.some(item => item.status !== 'acknowledged')) invalid()
  if (['awaiting-confirmation', 'cancelled'].includes(receipt.status) && receipt.results.some(item => item.status !== 'not-dispatched')) invalid()
  return receipt
}
export function parseBrowserProfileStoragePayload(value: unknown): BrowserProfileStoragePayload {
  try {
    const r = record(value)
    if (r.operation === 'browser.profile.storage.inspect') { record(r, ['operation', 'schemaVersion', 'requestId', 'profileId', 'operationId']); return { operation: r.operation, profileId: text(r.profileId), ...(r.operationId === undefined ? {} : { operationId: text(r.operationId) }) } }
    if (r.operation === 'browser.profile.storage.clear') { record(r, ['operation', 'schemaVersion', 'requestId', 'profileId', 'expectedRevision', 'operationId', 'sites']); return { operation: r.operation, profileId: text(r.profileId), expectedRevision: text(r.expectedRevision), operationId: text(r.operationId), sites: selections(r.sites) } }
    invalid()
  } catch { throw new AgentMuxError('Choose the original Profile, origin, exact storage keys and operation for this offline cache action.', 'INVALID_CONTROL_REQUEST') }
}
export function parseBrowserProfileStorageResult(operation: BrowserProfileStorageOperation, value: unknown): BrowserProfileStorageResult {
  const r = record(value), { operation: op, ...body } = r
  if (op !== undefined && op !== operation) invalid()
  if (operation === 'browser.profile.storage.clear') { const clear = record(body, ['receipt']); return { operation, receipt: parseBrowserProfileStorageReceipt(clear.receipt) } }
  const inspect = record(body, ['snapshot', 'receipt', 'pending']), snapshot = parseBrowserProfileStorageSnapshot(inspect.snapshot)
  const receipt = inspect.receipt === null ? null : parseBrowserProfileStorageReceipt(inspect.receipt), pending = list(inspect.pending, parseBrowserProfileStorageReceipt)
  if (receipt && receipt.profileId !== snapshot.profileId || pending.some(item => item.profileId !== snapshot.profileId || !['awaiting-confirmation', 'pending', 'partial', 'unknown'].includes(item.status)) || new Set(pending.map(item => item.operationId)).size !== pending.length) invalid()
  return { operation, snapshot, receipt, pending }
}
export function assertBrowserProfileStorageTarget(request: BrowserProfileStoragePayload, result: BrowserProfileStorageResult): void {
  if (request.operation !== result.operation) invalid()
  if (request.operation === 'browser.profile.storage.inspect' && result.operation === request.operation) {
    if (request.profileId !== result.snapshot.profileId || request.operationId !== undefined && result.receipt !== null && result.receipt.operationId !== request.operationId) invalid()
  } else if (request.operation === 'browser.profile.storage.clear' && result.operation === request.operation) {
    const receipt = result.receipt
    if (receipt.profileId !== request.profileId || receipt.expectedRevision !== request.expectedRevision || receipt.operationId !== request.operationId ||
      receipt.sites.length !== request.sites.length || receipt.sites.some((site, index) => site.origin !== request.sites[index]!.origin || site.storageKeys.length !== request.sites[index]!.storageKeys.length || site.storageKeys.some((key, keyIndex) => key !== request.sites[index]!.storageKeys[keyIndex]))) invalid()
  }
}
