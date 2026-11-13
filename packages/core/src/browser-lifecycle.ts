import { AgentMuxError } from './errors.js'

/** Object lifecycle facts are independent of Regions, operation stop and native resource release. */
export type AgentMuxBrowserLifecycleIntent =
  | { kind: 'create'; url: string }
  | { kind: 'close'; navigationId: string }
export type AgentMuxBrowserLifecycleReceipt = {
  operationId: string
  browserId: string
  intent: AgentMuxBrowserLifecycleIntent
  status: 'created' | 'not-created' | 'closed' | 'kept' | 'unknown'
  message?: string
}
export function parseBrowserLifecycleIntent(value: unknown): AgentMuxBrowserLifecycleIntent {
  const row = record(value)
  if (row.kind === 'create' && Object.keys(row).every(k => ['kind', 'url'].includes(k))) return { kind: 'create', url: text(row.url) }
  if (row.kind === 'close' && Object.keys(row).every(k => ['kind', 'navigationId'].includes(k))) return { kind: 'close', navigationId: text(row.navigationId) }
  throw invalid()
}
export function parseBrowserLifecycleReceipt(value: unknown): AgentMuxBrowserLifecycleReceipt {
  const row = record(value), intent = parseBrowserLifecycleIntent(row.intent)
  if (Object.keys(row).some(k => !['operationId','browserId','intent','status','message'].includes(k)) ||
    !(intent.kind === 'create' ? ['created','not-created','unknown'] : ['closed','kept','unknown']).includes(String(row.status))) throw invalid()
  return { operationId: text(row.operationId), browserId: text(row.browserId), intent,
    status: row.status as AgentMuxBrowserLifecycleReceipt['status'], ...(row.message === undefined ? {} : { message: text(row.message) }) }
}
function invalid(): AgentMuxError { return new AgentMuxError('Browser lifecycle fact is invalid.', 'CONTROL_PROTOCOL_ERROR') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid()
  return value
}
