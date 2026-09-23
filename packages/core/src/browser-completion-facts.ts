import { AgentMuxError } from './errors.js'

export const BROWSER_COMPLETION_UNAVAILABLE_WARNING = 'Completion facts are unreadable; verification is unavailable. Existing Browser work remains.'

export type AgentMuxBrowserCompletionStatus = 'passed' | 'not-met' | 'unavailable'
export type AgentMuxBrowserCompletionCriterion =
  | { kind: 'field-equals'; key: string; expected: string | number | boolean }
  | { kind: 'download-readable'; path: string }
  | { kind: 'human-checkpoint'; checkpointId: string }

/** Client-owned completion facts, distinct from script termination and never approval authority. */
export type AgentMuxBrowserCompletion = {
  context: { workspaceId: string | null; browserId: string; operationId: string; navigationId: string }
  assetRun?: { runId: string; assetId: string; version: number }
  status: AgentMuxBrowserCompletionStatus
  conditions: { criterion: AgentMuxBrowserCompletionCriterion; status: AgentMuxBrowserCompletionStatus; reason: string }[]
  warning?: string
}

const MAX_CONDITIONS = 8
const MAX_BYTES = 64 * 1024
const fail = (): never => { throw new AgentMuxError('Browser completion projection is invalid or unavailable for this operation.', 'CONTROL_PROTOCOL_ERROR') }

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) return fail()
  return result
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail()
  return value
}
function identity(value: unknown): string {
  const result = text(value, 512)
  if (result === 'self' || /[\0\r\n]/u.test(result) || new TextEncoder().encode(result).length > 512) return fail()
  return result
}
function status(value: unknown): AgentMuxBrowserCompletionStatus {
  if (value !== 'passed' && value !== 'not-met' && value !== 'unavailable') return fail()
  return value
}
function criterion(value: unknown): AgentMuxBrowserCompletionCriterion {
  const source = record(value, ['kind', 'key', 'expected', 'path', 'checkpointId'])
  if (source.kind === 'field-equals') {
    record(source, ['kind', 'key', 'expected'])
    const expected = source.expected
    if (!(typeof expected === 'string' && expected.length <= 16 * 1024) &&
        !(typeof expected === 'number' && Number.isFinite(expected)) && typeof expected !== 'boolean') return fail()
    return { kind: source.kind, key: text(source.key, 128), expected }
  }
  if (source.kind === 'download-readable') {
    record(source, ['kind', 'path'])
    return { kind: source.kind, path: text(source.path, 512) }
  }
  if (source.kind === 'human-checkpoint') {
    record(source, ['kind', 'checkpointId'])
    return { kind: source.kind, checkpointId: text(source.checkpointId, 128) }
  }
  return fail()
}

/** Validate the public wire projection only. Main retains all producer, document and human provenance. */
export function parseBrowserCompletionFacts(value: unknown,
  expected: { operationId: string; browserId: string }): AgentMuxBrowserCompletion {
  const source = record(value, ['context', 'assetRun', 'status', 'conditions', 'warning'])
  const context = record(source.context, ['workspaceId', 'browserId', 'operationId', 'navigationId'])
  const parsed: AgentMuxBrowserCompletion = {
    context: { workspaceId: context.workspaceId === null ? null : identity(context.workspaceId),
      browserId: identity(context.browserId), operationId: identity(context.operationId), navigationId: identity(context.navigationId) },
    status: status(source.status), conditions: []
  }
  if (parsed.context.operationId !== identity(expected.operationId) || parsed.context.browserId !== identity(expected.browserId)) return fail()
  if (source.assetRun !== undefined) {
    const run = record(source.assetRun, ['runId', 'assetId', 'version'])
    if (!Number.isSafeInteger(run.version) || (run.version as number) < 1) return fail()
    parsed.assetRun = { runId: identity(run.runId), assetId: identity(run.assetId), version: run.version as number }
  }
  if (!Array.isArray(source.conditions) || source.conditions.length < 1 || source.conditions.length > MAX_CONDITIONS) return fail()
  parsed.conditions = source.conditions.map(value => {
    const item = record(value, ['criterion', 'status', 'reason'])
    return { criterion: criterion(item.criterion), status: status(item.status), reason: text(item.reason, 2048) }
  })
  if (!parsed.assetRun && parsed.conditions.some(item => item.criterion.kind === 'human-checkpoint' && item.status !== 'unavailable')) return fail()
  if (source.warning !== undefined) parsed.warning = text(source.warning, 2048)
  const aggregate = parsed.conditions.some(item => item.status === 'unavailable') ? 'unavailable'
    : parsed.conditions.every(item => item.status === 'passed') ? 'passed' : 'not-met'
  if (parsed.status !== aggregate) return fail()
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > MAX_BYTES) return fail()
  return parsed
}
