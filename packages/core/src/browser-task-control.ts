import { parseBrowserTaskParallelContinuationInput, parseBrowserTaskParallelContinuationReceipt, type BrowserTaskParallelContinuationInput, type BrowserTaskParallelContinuationReceipt } from './browser-task-parallel.js'
import { mintObjectId } from './object-id.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseBrowserTaskCreateInput, type BrowserTaskCreateInput, type BrowserTaskCreateStatus } from './browser-task-creation.js'
export * from './browser-task-creation.js'
import { parseBrowserTaskInvocation, type BrowserTaskInvocationCalls } from './browser-task-invocation.js'
export * from './browser-task-invocation.js'

export type AgentMuxBrowserTaskSource = { id: string; browserId: string; revision: number; status: 'recording' | 'stopped' | 'interrupted'; stepCount: number; warning?: string }
export type AgentMuxBrowserTaskDraft = { id: string; browserId: string; revision: number; sourceRecordingId?: string; importedFrom?: BrowserTaskPortableSource; draft: Record<string, unknown>; warning?: string }

/** Provenance describes an exported definition; it never identifies a local recording or approval. */
export type BrowserTaskPortableSource = { assetId: string; revision: number; publishedVersion?: number }
export type BrowserTaskPortableBundle = { format: 'agentmux.browser-task'; version: 1; source: BrowserTaskPortableSource; definition: Record<string, unknown> }
export type BrowserTaskImportInput = { createOperationId: string; assetId: string; browserId: string; bundle: BrowserTaskPortableBundle }
/** Compact immutable intent stored in the original asset document, alongside its imported definition. */
export type BrowserTaskPortableBinding = { kind: 'portable'; createOperationId: string; assetId: string; browserId: string; bundleSha256: string; source: BrowserTaskPortableSource }

import { BROWSER_TASK_RUN_STATUSES, type BrowserTaskRunStatus } from './browser-task-status.js'
export { BROWSER_TASK_RUN_STATUSES, isBrowserTaskRunStatus, type BrowserTaskRunStatus } from './browser-task-status.js'
import { parseBrowserTaskParallelList, type BrowserTaskParallelList, parseBrowserTaskParallelInput, parseBrowserTaskParallelSummary, parseBrowserTaskParallelInspection, parseBrowserTaskParallelBinding, type BrowserTaskParallelInput, type BrowserTaskParallelSummary, type BrowserTaskParallelInspection, type BrowserTaskParallelBinding } from './browser-task-parallel.js'
export * from './browser-task-parallel.js'
export type BrowserTaskReliabilityResult = 'passed' | 'not-met' | 'unavailable' | 'unknown' | 'failed' | 'stopped' | 'interrupted'
export type BrowserTaskRunParent = { runId: string; stepId: string; itemId: string }
export type BrowserTaskCallProgress = { stepId: string; assetId: string; version: number; nextItem: number; items: { id: string; runId?: string }[] }
/** A projection of original producer checks, never another stored success fact. */
export type BrowserTaskRunCompletion = {
  runId: string; browserId: string; assetId: string; version: number
  status: 'passed' | 'not-met' | 'unavailable'
  conditions: { criterion: (
    | { kind: 'field-equals'; stepId: string; key: string; expected: string | number | boolean }
    | { kind: 'download-readable'; stepId: string; path: string }
    | { kind: 'human-checkpoint'; checkpointId: string }
  ); status: 'passed' | 'not-met' | 'unavailable'; reason: string; operationId?: string }[]
  warning?: string
}
export type AgentMuxBrowserTaskInspection = { rootRunId: string; currentRunId: string; runs: AgentMuxBrowserTaskRun[]; operationCount: number; executedMillis: number; completions?: BrowserTaskRunCompletion[]; warning?: string }

/**
 * Typed Client facts only. Core neither interprets steps nor owns workflow execution.
 * Saved steps are click, fill, navigate, checkpoint, branch and the testing steps wait,
 * assert, press, hover and scroll, with optional per-step onFail and retry; their schema
 * and validation belong to the Browser Client.
 */
export type AgentMuxBrowserTaskRun = {
  id: string; assetId: string; version: number; browserId: string; nextStep: number
  status: BrowserTaskRunStatus; operationIds: string[]; pendingCheckpointId?: string
  stepExecutions?: { stepId: string; operationId: string }[]
  branchDecisions?: { stepId: string; operationId: string; navigationId: string; result: 'true' | 'false' | 'unknown'; nextStepId?: string | null }[]
  /** Steps whose known script failure was recorded so the path could continue or jump; a run with any entry never completes. */
  failedSteps?: { stepId: string; operationId: string }[]
  executedMillis?: number
  parent?: BrowserTaskRunParent
  calls?: BrowserTaskCallProgress[]
  orchestration?: BrowserTaskParallelBinding
  startedAt: number; updatedAt: number; warning?: string; completionWarning?: string
}
export type AgentMuxBrowserTaskBatch = {
  id: string; browserId: string; assetId: string; version: number
  items: { id: string; runId?: string }[]; nextItem: number; status: BrowserTaskRunStatus
  operationCount: number; executedMillis: number; startedAt: number; updatedAt: number; warning?: string
}
export type AgentMuxBrowserTaskState = {
  /** Asset semantics and validation belong to the Browser Client. */
  assets: Record<string, unknown>[]
  runs: AgentMuxBrowserTaskRun[]
  batches?: AgentMuxBrowserTaskBatch[]
  activeBatchId?: string | null
  selectedRunId?: string | null
  completion?: BrowserTaskRunCompletion
  parallel?: BrowserTaskParallelSummary | null
  warning?: string
}
export type AgentMuxBrowserTaskReliability = {
  browserId: string; assetId: string; version: number; selectedRunId: string | null
  selectedRunStatus?: BrowserTaskRunStatus
  population: { retainedRuns: number; terminalRuns: number; pendingRuns: number; firstStartedAt: number | null; lastUpdatedAt: number | null }
  counts: Record<BrowserTaskReliabilityResult, number>
  scriptCompleted: number; humanInterventions: number; passRate: number | null
  samples: { runId: string; result: BrowserTaskReliabilityResult; reason: string }[]
  warning?: string
}

export type BrowserTaskControlPayload =
  | { operation: 'browser.task.export'; browserId: string; assetId: string; expectedRevision: number; version?: number }
  | { operation: 'browser.task.import'; browserId: string; input: BrowserTaskImportInput }
  | { operation: 'browser.task.import-inspect'; browserId: string; input: BrowserTaskImportInput }
  | { operation: 'browser.task.source'; browserId: string }
  | { operation: 'browser.task.draft'; browserId: string; assetId: string }
  | { operation: 'browser.task.create'; browserId: string; input: BrowserTaskCreateInput }
  | { operation: 'browser.task.create-inspect'; browserId: string; input: BrowserTaskCreateInput }
  | { operation: 'browser.task.assets'; browserId: string }
  | { operation: 'browser.task.inspect'; browserId: string; runId?: string }
  | { operation: 'browser.task.parallel-continue'; browserId: string; operationId: string; targetId: string; input: BrowserTaskParallelContinuationInput }
  | { operation: 'browser.task.parallel-stop'; browserId: string; operationId: string }
  | { operation: 'browser.task.parallel'; browserId: string; assetId: string; version: number; input: BrowserTaskParallelInput }
  | { operation: 'browser.task.parallel-inspect'; browserId: string; operationId?: string; after?: string; limit?: number; continuationId?: string }
  | { operation: 'browser.task.parallel-list'; browserId: string; before?: string; limit?: number }
  | { operation: 'browser.task.edit'; browserId: string; assetId: string; expectedRevision: number; content: Record<string, unknown> }
  | { operation: 'browser.task.publish'; browserId: string; assetId: string; expectedRevision: number }
  | { operation: 'browser.task.batch'; browserId: string; assetId: string; version: number; items: { id: string; parameters: Record<string, string> }[]; parameters: Record<string, string>; batchId?: string }
  | { operation: 'browser.task.batch-stop'; browserId: string; batchId: string }
  | { operation: 'browser.task.run'; browserId: string; assetId: string; version: number; parameters: Record<string, string>; calls?: BrowserTaskInvocationCalls; mode?: 'run' | 'step'; runId?: string }
  | { operation: 'browser.task.stop'; browserId: string; runId: string }
  | { operation: 'browser.task.reliability'; browserId: string; assetId: string; version: number }
/** Confirmed write identity; cumulative definition/version history is read separately. */
export type AgentMuxBrowserTaskAssetReceipt = { id: string; browserId: string; revision: number }
export type BrowserTaskControlResult =
  | { operation: 'browser.task.export'; bundle: BrowserTaskPortableBundle }
  | { operation: 'browser.task.import'; creation: { createOperationId: string; assetId: string; browserId: string; status: 'created' } }
  | { operation: 'browser.task.import-inspect'; creation: BrowserTaskCreateStatus }
  | { operation: 'browser.task.source'; browserId: string; source: AgentMuxBrowserTaskSource | null }
  | { operation: 'browser.task.draft'; asset: AgentMuxBrowserTaskDraft }
  | { operation: 'browser.task.create'; creation: { createOperationId: string; assetId: string; browserId: string; status: 'created' } }
  | { operation: 'browser.task.create-inspect'; creation: BrowserTaskCreateStatus }
  | { operation: 'browser.task.assets'; state: AgentMuxBrowserTaskState }
  | { operation: 'browser.task.inspect'; inspection: AgentMuxBrowserTaskInspection | null }
  | ({ operation: 'browser.task.parallel-continue' } & BrowserTaskParallelContinuationReceipt)
  | { operation: 'browser.task.parallel-stop'; run: BrowserTaskParallelSummary | null }
  | { operation: 'browser.task.parallel'; run: BrowserTaskParallelSummary }
  | { operation: 'browser.task.parallel-inspect'; inspection: BrowserTaskParallelInspection | null }
  | { operation: 'browser.task.parallel-list'; history: BrowserTaskParallelList }
  | { operation: 'browser.task.edit'; asset: AgentMuxBrowserTaskAssetReceipt }
  | { operation: 'browser.task.publish'; asset: AgentMuxBrowserTaskAssetReceipt; publishedVersion: number }
  | { operation: 'browser.task.batch'; batch: AgentMuxBrowserTaskBatch }
  | { operation: 'browser.task.batch-stop'; batch: AgentMuxBrowserTaskBatch | null }
  | { operation: 'browser.task.run'; run: AgentMuxBrowserTaskRun }
  | { operation: 'browser.task.stop'; run: AgentMuxBrowserTaskRun | null }
  | { operation: 'browser.task.reliability'; reliability: AgentMuxBrowserTaskReliability }

const STATUSES = new Set<BrowserTaskRunStatus>(BROWSER_TASK_RUN_STATUSES)
const RESULTS: BrowserTaskReliabilityResult[] = ['passed', 'not-met', 'unavailable', 'unknown', 'failed', 'stopped', 'interrupted']
const MAX_BYTES = 1_048_576

export function isBrowserTaskControlOperation(operation: string): operation is BrowserTaskControlPayload['operation'] {
  return operation === 'browser.task.parallel-continue' || operation === 'browser.task.parallel-stop' || operation === 'browser.task.parallel-list' || operation === 'browser.task.parallel' || operation === 'browser.task.parallel-inspect' || operation === 'browser.task.export' || operation === 'browser.task.import' || operation === 'browser.task.import-inspect' || operation === 'browser.task.source' || operation === 'browser.task.draft' || operation === 'browser.task.create' || operation === 'browser.task.create-inspect' || operation === 'browser.task.assets' || operation === 'browser.task.inspect' || operation === 'browser.task.edit' || operation === 'browser.task.publish' || operation === 'browser.task.batch' || operation === 'browser.task.batch-stop' || operation === 'browser.task.run' || operation === 'browser.task.stop' || operation === 'browser.task.reliability'
}

function bad(message: string, request = false): never {
  throw new AgentMuxError(message, request ? 'INVALID_CONTROL_REQUEST' : 'CONTROL_PROTOCOL_ERROR')
}
function record(value: unknown, request = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('Browser task object is invalid.', request)
  return value as Record<string, unknown>
}
function identifier(value: unknown, request = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) bad('Browser task identity is invalid.', request)
  return value
}
function integer(value: unknown, request = false, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) bad('Browser task count or version is invalid.', request)
  return value
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) bad('Browser task timestamp is invalid.')
  return value
}
function nullableTime(value: unknown): number | null { return value === null ? null : time(value) }
function note(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384) bad('Browser task notice is invalid.')
  return value
}
function notices(source: Record<string, unknown>): { warning?: string; completionWarning?: string } {
  return { ...(source.warning === undefined ? {} : { warning: note(source.warning) }),
    ...(source.completionWarning === undefined ? {} : { completionWarning: note(source.completionWarning) }) }
}
function bounded(value: unknown, limit: number, request = false): unknown[] {
  if (!Array.isArray(value) || value.length > limit) bad('Browser task collection exceeds its budget.', request)
  return value
}

/** Transport-only JSON carrier. Step semantics stay with the Browser Client's asset owner. */
function definition(value: unknown, request = false): Record<string, unknown> {
  const code = request ? 'INVALID_CONTROL_REQUEST' : 'CONTROL_PROTOCOL_ERROR'
  const seen = new Set<object>()
  function json(value: unknown, depth: number): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
    if (!value || typeof value !== 'object' || depth > 64 || seen.has(value)) bad('Browser task definition must contain bounded JSON data.', request)
    seen.add(value)
    let result: unknown
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) bad('Browser task definition must contain JSON arrays.', request)
      result = Array.from({ length: value.length }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(value, String(index))
        if (!item || !('value' in item)) bad('Browser task definition must contain JSON data.', request)
        return json(item.value, depth + 1)
      })
    } else result = Object.fromEntries(Object.entries(rpcRecord(value, undefined, code)).map(([key, item]) => [key, json(item, depth + 1)]))
    seen.delete(value)
    return result
  }
  const result = rpcRecord(json(value, 0), undefined, code)
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) bad('Browser task definition byte budget exceeded.', request)
  return result
}

export function parseBrowserTaskPortableSource(value: unknown, request = true): BrowserTaskPortableSource {
  const row = rpcRecord(value, ['assetId', 'revision', 'publishedVersion'], request ? 'INVALID_CONTROL_REQUEST' : 'CONTROL_PROTOCOL_ERROR')
  return { assetId: identifier(row.assetId, request), revision: integer(row.revision, request, 1),
    ...(row.publishedVersion === undefined ? {} : { publishedVersion: integer(row.publishedVersion, request, 1) }) }
}
export function parseBrowserTaskPortableBundle(value: unknown, request = true): BrowserTaskPortableBundle {
  const row = rpcRecord(value, ['format', 'version', 'source', 'definition'], request ? 'INVALID_CONTROL_REQUEST' : 'CONTROL_PROTOCOL_ERROR')
  if (row.format !== 'agentmux.browser-task' || row.version !== 1) bad('Unsupported portable task format or version.', request)
  const result: BrowserTaskPortableBundle = { format: row.format, version: 1, source: parseBrowserTaskPortableSource(row.source, request), definition: definition(row.definition, request) }
  // Leave room for the RPC/CLI envelope before any import write can occur.
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES - 4096) bad('Portable task bundle byte budget exceeded.', request)
  return result
}
export function parseBrowserTaskImportInput(value: unknown): BrowserTaskImportInput {
  const row = rpcRecord(value, ['createOperationId', 'assetId', 'browserId', 'bundle'], 'INVALID_CONTROL_REQUEST')
  return { createOperationId: identifier(row.createOperationId, true), assetId: identifier(row.assetId, true), browserId: identifier(row.browserId, true), bundle: parseBrowserTaskPortableBundle(row.bundle) }
}
/** Retain this exact input before dispatch; unknown writes continue the same proposed identities. */
export function browserTaskImportInput(browserId: string, bundle: BrowserTaskPortableBundle): BrowserTaskImportInput {
  return parseBrowserTaskImportInput({ createOperationId: mintObjectId(), assetId: mintObjectId(), browserId, bundle })
}
export function parseBrowserTaskPortableBinding(value: unknown): BrowserTaskPortableBinding {
  const row = rpcRecord(value, ['kind', 'createOperationId', 'assetId', 'browserId', 'bundleSha256', 'source'], 'INVALID_CONTROL_REQUEST')
  if (row.kind !== 'portable' || typeof row.bundleSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.bundleSha256)) bad('Invalid portable task creation binding.', true)
  return { kind: 'portable', createOperationId: identifier(row.createOperationId, true), assetId: identifier(row.assetId, true), browserId: identifier(row.browserId, true), bundleSha256: row.bundleSha256, source: parseBrowserTaskPortableSource(row.source) }
}

export function parseBrowserTaskControlPayload(value: unknown): BrowserTaskControlPayload {
  const source = record(value, true)
  const browserId = identifier(source.browserId, true)
  if (source.operation === 'browser.task.export') {
    rpcRecord(source, ['operation', 'browserId', 'assetId', 'expectedRevision', 'version', 'schemaVersion', 'requestId'], 'INVALID_CONTROL_REQUEST')
    return { operation: source.operation, browserId, assetId: identifier(source.assetId, true), expectedRevision: integer(source.expectedRevision, true, 1), ...(source.version === undefined ? {} : { version: integer(source.version, true, 1) }) }
  }
  if (source.operation === 'browser.task.import' || source.operation === 'browser.task.import-inspect') {
    rpcRecord(source, ['operation', 'browserId', 'input', 'schemaVersion', 'requestId'], 'INVALID_CONTROL_REQUEST')
    const input = parseBrowserTaskImportInput(source.input)
    if (input.browserId !== browserId) bad('Task import input belongs to another Browser.', true)
    return { operation: source.operation, browserId, input }
  }
  if (source.operation === 'browser.task.source' || source.operation === 'browser.task.draft' || source.operation === 'browser.task.create' || source.operation === 'browser.task.create-inspect') {
    const fields = source.operation === 'browser.task.draft' ? ['assetId'] : source.operation === 'browser.task.source' ? [] : ['input']
    rpcRecord(source, ['operation', 'browserId', ...fields, 'schemaVersion', 'requestId'], 'INVALID_CONTROL_REQUEST')
    if (source.operation === 'browser.task.source') return { operation: source.operation, browserId }
    if (source.operation === 'browser.task.draft') return { operation: source.operation, browserId, assetId: identifier(source.assetId, true) }
    const input = parseBrowserTaskCreateInput(source.input)
    if (input.browserId !== browserId) bad('Task creation input belongs to another Browser.', true)
    return { operation: source.operation, browserId, input }
  }
  if (source.operation === 'browser.task.edit' || source.operation === 'browser.task.publish') {
    rpcRecord(source, ['operation', 'browserId', 'assetId', 'expectedRevision', ...(source.operation === 'browser.task.edit' ? ['content'] : []), 'schemaVersion', 'requestId'])
    const common = { browserId, assetId: identifier(source.assetId, true), expectedRevision: integer(source.expectedRevision, true, 1) }
    return source.operation === 'browser.task.edit' ? { operation: source.operation, ...common, content: definition(source.content, true) } : { operation: source.operation, ...common }
  }
  if (source.operation === 'browser.task.parallel-continue') {
    rpcRecord(source, ['operation', 'browserId', 'operationId', 'targetId', 'input', 'schemaVersion', 'requestId', 'caller'])
    return { operation: source.operation, browserId, operationId: identifier(source.operationId, true), targetId: identifier(source.targetId, true), input: parseBrowserTaskParallelContinuationInput(source.input) }
  }
  if (source.operation === 'browser.task.parallel-stop') {
    rpcRecord(source, ['operation', 'browserId', 'operationId', 'schemaVersion', 'requestId'])
    return { operation: source.operation, browserId, operationId: identifier(source.operationId, true) }
  }
  if (source.operation === 'browser.task.parallel') {
    rpcRecord(source, ['operation', 'browserId', 'assetId', 'version', 'input', 'schemaVersion', 'requestId', 'caller'])
    return { operation: source.operation, browserId, assetId: identifier(source.assetId, true), version: integer(source.version, true, 1), input: parseBrowserTaskParallelInput(source.input) }
  }
  if (source.operation === 'browser.task.parallel-list') {
    rpcRecord(source, ['operation', 'browserId', 'before', 'limit', 'schemaVersion', 'requestId'])
    const limit = source.limit === undefined ? undefined : integer(source.limit, true, 1)
    if (limit !== undefined && limit > 64) bad('Task execution history limit must be 1–64.', true)
    return { operation: source.operation, browserId, ...(source.before === undefined ? {} : { before: identifier(source.before, true) }), ...(limit === undefined ? {} : { limit }) }
  }
  if (source.operation === 'browser.task.parallel-inspect') {
    rpcRecord(source, ['operation', 'browserId', 'operationId', 'after', 'limit', 'continuationId', 'schemaVersion', 'requestId'])
    if (source.continuationId !== undefined && source.operationId === undefined) bad('Continuation inspection requires its original parallel operation.', true)
    const limit = source.limit === undefined ? undefined : integer(source.limit, true, 1)
    if (limit !== undefined && limit > 64) bad('Task execution inspection limit must be 1–64.', true)
    return { operation: source.operation, browserId, ...(source.operationId === undefined ? {} : { operationId: identifier(source.operationId, true) }),
      ...(source.after === undefined ? {} : { after: identifier(source.after, true) }), ...(limit === undefined ? {} : { limit }),
      ...(source.continuationId === undefined ? {} : { continuationId: identifier(source.continuationId, true) }) }
  }
  if (source.operation === 'browser.task.inspect') {
    rpcRecord(source, ['operation', 'browserId', 'runId', 'schemaVersion', 'requestId'])
    return { operation: source.operation, browserId, ...(source.runId === undefined ? {} : { runId: identifier(source.runId, true) }) }
  }
  if (source.operation === 'browser.task.assets') return { operation: source.operation, browserId }
  if (source.operation === 'browser.task.batch-stop') return { operation: source.operation, browserId, batchId: identifier(source.batchId, true) }
  if (source.operation === 'browser.task.stop') return { operation: source.operation, browserId, runId: identifier(source.runId, true) }
  if (source.operation !== 'browser.task.run' && source.operation !== 'browser.task.reliability' && source.operation !== 'browser.task.batch') bad('Browser task operation is invalid.', true)
  const assetId = identifier(source.assetId, true), version = integer(source.version, true, 1)
  if (source.operation === 'browser.task.reliability') return { operation: source.operation, browserId, assetId, version }
  if (source.operation === 'browser.task.run') {
    rpcRecord(source, ['operation', 'browserId', 'assetId', 'version', 'parameters', 'calls', 'mode', 'runId', 'schemaVersion', 'requestId', 'caller'], 'INVALID_CONTROL_REQUEST')
    const invocation = parseBrowserTaskInvocation({ parameters: source.parameters, ...(source.calls === undefined ? {} : { calls: source.calls }) })
    if (source.mode !== undefined && source.mode !== 'run' && source.mode !== 'step') bad('Browser task execution mode is invalid.', true)
    return { operation: source.operation, browserId, assetId, version, ...invocation,
      ...(source.mode === undefined ? {} : { mode: source.mode }),
      ...(source.runId === undefined ? {} : { runId: identifier(source.runId, true) }) }
  }
  const supplied = record(source.parameters, true), entries = Object.entries(supplied)
  if (entries.length > 32) bad('Browser task parameter budget exceeded.', true)
  let bytes = 0
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 16_384) bad('Browser task parameter is invalid.', true)
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value)
  }
  if (bytes > 65_536) bad('Browser task parameter byte budget exceeded.', true)
  if (source.operation === 'browser.task.batch') {
    const items = bounded(source.items, 16, true).map(value => {
      const item = record(value, true), values = record(item.parameters, true), keys = Object.entries(values)
      if (keys.length > 32) bad('Browser task batch parameter budget exceeded.', true)
      for (const [key, value] of keys) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 16_384) bad('Browser task batch parameter is invalid.', true)
        bytes += Buffer.byteLength(key) + Buffer.byteLength(value)
      }
      return { id: identifier(item.id, true), parameters: Object.fromEntries(keys) as Record<string, string> }
    })
    if (items.length === 0 || new Set(items.map(item => item.id)).size !== items.length || bytes > 65_536) bad('Browser task batch items or value budget are invalid.', true)
    return { operation: source.operation, browserId, assetId, version, parameters: Object.fromEntries(entries) as Record<string, string>, items,
      ...(source.batchId === undefined ? {} : { batchId: identifier(source.batchId, true) }) }
  }
  bad('Browser task operation is invalid.', true)
}

function run(value: unknown): AgentMuxBrowserTaskRun {
  const source = record(value)
  if (!STATUSES.has(source.status as BrowserTaskRunStatus)) bad('Browser task run status is invalid.')
  const operationIds = bounded(source.operationIds, 128).map(value => identifier(value))
  if (new Set(operationIds).size !== operationIds.length) bad('Browser task operation identity is duplicated.')
  const startedAt = time(source.startedAt), updatedAt = time(source.updatedAt)
  if (updatedAt < startedAt) bad('Browser task run timestamps are inconsistent.')
  const stepExecutions = source.stepExecutions === undefined ? undefined : bounded(source.stepExecutions, 128).map(value => {
    const fact = record(value)
    const operationId = identifier(fact.operationId)
    if (!operationIds.includes(operationId)) bad('Browser task step operation is not bound to its run.')
    return { stepId: identifier(fact.stepId), operationId }
  })
  if (stepExecutions && new Set(stepExecutions.map(fact => fact.operationId)).size !== stepExecutions.length) bad('Browser task executed path is duplicated.')
  const branchDecisions = source.branchDecisions === undefined ? undefined : bounded(source.branchDecisions, 16).map(value => {
    const fact = record(value)
    if (!['true', 'false', 'unknown'].includes(fact.result as string) || !stepExecutions?.some(step => step.operationId === fact.operationId && step.stepId === fact.stepId)) bad('Browser task condition operation is not bound to its step.')
    if (fact.result === 'unknown' ? fact.nextStepId !== undefined : fact.nextStepId === undefined) bad('Browser task condition path is inconsistent.')
    return { stepId: identifier(fact.stepId), operationId: identifier(fact.operationId), navigationId: note(fact.navigationId), result: fact.result as 'true' | 'false' | 'unknown',
      ...(fact.nextStepId === undefined ? {} : { nextStepId: fact.nextStepId === null ? null : identifier(fact.nextStepId) }) }
  })
  if (branchDecisions && new Set(branchDecisions.map(fact => fact.stepId)).size !== branchDecisions.length) bad('Browser task condition identity is duplicated.')
  const failedSteps = source.failedSteps === undefined ? undefined : bounded(source.failedSteps, 128).map(value => {
    const fact = record(value)
    const stepId = identifier(fact.stepId), operationId = identifier(fact.operationId)
    if (!stepExecutions?.some(step => step.operationId === operationId && step.stepId === stepId)) bad('Browser task failed step is not bound to its executed operation.')
    return { stepId, operationId }
  })
  if (failedSteps && new Set(failedSteps.map(fact => fact.stepId)).size !== failedSteps.length) bad('Browser task failed step identity is duplicated.')
  if (failedSteps?.length && source.status === 'completed') bad('Browser task run with failed steps cannot be completed.')
  return { id: identifier(source.id), browserId: identifier(source.browserId), assetId: identifier(source.assetId), version: integer(source.version, false, 1),
    nextStep: integer(source.nextStep), status: source.status as BrowserTaskRunStatus, operationIds, startedAt, updatedAt,
    ...(stepExecutions === undefined ? {} : { stepExecutions }), ...(branchDecisions === undefined ? {} : { branchDecisions }),
    ...(failedSteps === undefined ? {} : { failedSteps }),
    ...(source.executedMillis === undefined ? {} : { executedMillis: time(source.executedMillis) }),
    ...(source.parent === undefined ? {} : { parent: parseBrowserTaskRunParent(source.parent) }),
    ...(source.orchestration === undefined ? {} : { orchestration: parseBrowserTaskParallelBinding(source.orchestration) }),
    ...(source.calls === undefined ? {} : { calls: parseBrowserTaskCallProgress(source.calls) }),
    ...(source.pendingCheckpointId === undefined ? {} : { pendingCheckpointId: identifier(source.pendingCheckpointId) }), ...notices(source) }
}
export function parseBrowserTaskRunParent(value: unknown): BrowserTaskRunParent {
  const row = rpcRecord(value, ['runId', 'stepId', 'itemId'], 'CONTROL_PROTOCOL_ERROR')
  return { runId: identifier(row.runId), stepId: identifier(row.stepId), itemId: identifier(row.itemId) }
}
export function parseBrowserTaskCallProgress(value: unknown): BrowserTaskCallProgress[] {
  const calls = bounded(value, 32).map(value => {
    const row = rpcRecord(value, ['stepId', 'assetId', 'version', 'nextItem', 'items'], 'CONTROL_PROTOCOL_ERROR')
    const items = bounded(row.items, 16).map(value => {
      const item = rpcRecord(value, ['id', 'runId'], 'CONTROL_PROTOCOL_ERROR')
      return { id: identifier(item.id), ...(item.runId === undefined ? {} : { runId: identifier(item.runId) }) }
    })
    const nextItem = integer(row.nextItem)
    if (!items.length || nextItem > items.length || new Set(items.map(item => item.id)).size !== items.length || items.slice(0, nextItem).some(item => !item.runId)) bad('Task call progress is inconsistent.')
    return { stepId: identifier(row.stepId), assetId: identifier(row.assetId), version: integer(row.version, false, 1), nextItem, items }
  })
  if (new Set(calls.map(call => call.stepId)).size !== calls.length) bad('Task call identity is duplicated.')
  return calls
}
function inspection(value: unknown): AgentMuxBrowserTaskInspection {
  const row = rpcRecord(value, ['rootRunId', 'currentRunId', 'runs', 'operationCount', 'executedMillis', 'completions', 'warning'], 'CONTROL_PROTOCOL_ERROR')
  const runs = bounded(row.runs, 33).map(run), rootRunId = identifier(row.rootRunId), currentRunId = identifier(row.currentRunId)
  const byId = new Map(runs.map(run => [run.id, run]))
  if (byId.size !== runs.length || !byId.has(rootRunId) || byId.get(rootRunId)!.parent || !byId.has(currentRunId)) bad('Task inspection has no exact original root or cursor.')
  const visited = new Set<string>()
  const visit = (id: string, depth: number): void => {
    if (depth > 4 || visited.has(id)) bad('Task inspection contains a cyclic or excessive call tree.')
    visited.add(id)
    const parent = byId.get(id)!
    for (const call of parent.calls ?? []) for (const item of call.items) {
      if (!item.runId) continue
      const child = byId.get(item.runId)
      if (!child || child.browserId !== parent.browserId || child.assetId !== call.assetId || child.version !== call.version ||
          child.parent?.runId !== id || child.parent.stepId !== call.stepId || child.parent.itemId !== item.id) bad('Task child is not bound to its original call item.')
      visit(child.id, depth + 1)
    }
  }
  visit(rootRunId, 1)
  const operationCount = integer(row.operationCount), executedMillis = time(row.executedMillis)
  if (visited.size !== runs.length || operationCount !== runs.reduce((sum, run) => sum + run.operationIds.length, 0) ||
      executedMillis !== runs.reduce((sum, run) => sum + (run.executedMillis ?? 0), 0)) bad('Task inspection costs do not match its original runs.')
  const completionRead = row.completions === undefined ? undefined : completionObservations(row.completions, runs)
  return { rootRunId, currentRunId, runs, operationCount, executedMillis, ...(completionRead ? { completions: completionRead.values } : {}),
    ...((row.warning !== undefined || completionRead?.warning) ? { warning: [row.warning === undefined ? '' : note(row.warning), completionRead?.warning].filter(Boolean).join(' ') } : {}) }
}
function batch(value: unknown): AgentMuxBrowserTaskBatch {
  const source = record(value), items = bounded(source.items, 16).map(value => {
    const item = record(value)
    return { id: identifier(item.id), ...(item.runId === undefined ? {} : { runId: identifier(item.runId) }) }
  })
  const nextItem = integer(source.nextItem), operationCount = integer(source.operationCount)
  if (!items.length || new Set(items.map(item => item.id)).size !== items.length ||
      new Set(items.flatMap(item => item.runId ? [item.runId] : [])).size !== items.filter(item => item.runId).length ||
      nextItem > items.length || operationCount > 256 || !STATUSES.has(source.status as BrowserTaskRunStatus) ||
      (source.status === 'completed' && nextItem !== items.length) || items.slice(0, nextItem).some(item => !item.runId)) bad('Browser task batch progress is inconsistent.')
  const startedAt = time(source.startedAt), updatedAt = time(source.updatedAt)
  if (updatedAt < startedAt) bad('Browser task batch timestamps are inconsistent.')
  return { id: identifier(source.id), browserId: identifier(source.browserId), assetId: identifier(source.assetId), version: integer(source.version, false, 1),
    items, nextItem, status: source.status as BrowserTaskRunStatus, operationCount, executedMillis: time(source.executedMillis), startedAt, updatedAt, ...notices(source) }
}
export function parseBrowserTaskRunCompletion(value: unknown): BrowserTaskRunCompletion {
  const row = rpcRecord(value, ['runId', 'browserId', 'assetId', 'version', 'status', 'conditions', 'warning'], 'CONTROL_PROTOCOL_ERROR')
  const status = (value: unknown): BrowserTaskRunCompletion['status'] => {
    if (value !== 'passed' && value !== 'not-met' && value !== 'unavailable') bad('Task completion status is invalid.')
    return value
  }
  const conditions = bounded(row.conditions, 8).map(value => {
    const condition = rpcRecord(value, ['criterion', 'status', 'reason', 'operationId'], 'CONTROL_PROTOCOL_ERROR')
    const raw = record(condition.criterion)
    let criterion: BrowserTaskRunCompletion['conditions'][number]['criterion']
    if (raw.kind === 'field-equals') {
      rpcRecord(raw, ['kind', 'stepId', 'key', 'expected'], 'CONTROL_PROTOCOL_ERROR')
      if (!(typeof raw.expected === 'string' && raw.expected.length <= 16_384) &&
          !(typeof raw.expected === 'number' && Number.isFinite(raw.expected)) && typeof raw.expected !== 'boolean') bad('Task expected scalar is invalid.')
      criterion = { kind: raw.kind, stepId: identifier(raw.stepId), key: identifier(raw.key), expected: raw.expected }
    } else if (raw.kind === 'download-readable') {
      rpcRecord(raw, ['kind', 'stepId', 'path'], 'CONTROL_PROTOCOL_ERROR')
      criterion = { kind: raw.kind, stepId: identifier(raw.stepId), path: note(raw.path) }
    } else if (raw.kind === 'human-checkpoint') {
      rpcRecord(raw, ['kind', 'checkpointId'], 'CONTROL_PROTOCOL_ERROR')
      criterion = { kind: raw.kind, checkpointId: identifier(raw.checkpointId) }
    } else bad('Task completion criterion is invalid.')
    return { criterion, status: status(condition.status), reason: note(condition.reason),
      ...(condition.operationId === undefined ? {} : { operationId: identifier(condition.operationId) }) }
  })
  const aggregate = !conditions.length || conditions.some(item => item.status === 'unavailable') ? 'unavailable'
    : conditions.every(item => item.status === 'passed') ? 'passed' : 'not-met'
  if (status(row.status) !== aggregate) bad('Task completion aggregate disagrees with its conditions.')
  return { runId: identifier(row.runId), browserId: identifier(row.browserId), assetId: identifier(row.assetId), version: integer(row.version, false, 1),
    status: aggregate, conditions, ...notices(row) }
}
function strictCompletionForRun(value: unknown, runs: AgentMuxBrowserTaskRun[]): BrowserTaskRunCompletion {
  const completion = parseBrowserTaskRunCompletion(value)
  const run = runs.find(run => run.id === completion.runId && run.browserId === completion.browserId && run.assetId === completion.assetId && run.version === completion.version)
  if (!run || completion.conditions.some(condition => condition.operationId !== undefined && !run.operationIds.includes(condition.operationId)) ||
      run.status !== 'completed' && completion.status !== 'unavailable') bad('Task completion belongs to another original run or producer.')
  return completion
}
const COMPLETION_OBSERVATION_WARNING = 'Some recorded task completion observations are unavailable. Original runs and operation identities remain; no data was extracted again.'
function unavailableCompletion(run: AgentMuxBrowserTaskRun): BrowserTaskRunCompletion {
  return { runId: run.id, browserId: run.browserId, assetId: run.assetId, version: run.version, status: 'unavailable', conditions: [], warning: COMPLETION_OBSERVATION_WARNING }
}
function completionObservations(value: unknown, runs: AgentMuxBrowserTaskRun[]): { values: BrowserTaskRunCompletion[]; warning?: string } {
  if (!Array.isArray(value) || value.length > 33) return { values: [], warning: COMPLETION_OBSERVATION_WARNING }
  let unavailable = false
  const byRun = new Map<string, BrowserTaskRunCompletion>()
  for (const item of value) {
    let completion: BrowserTaskRunCompletion
    try { completion = strictCompletionForRun(item, runs) }
    catch {
      unavailable = true
      const runId = item && typeof item === 'object' ? (item as Record<string, unknown>).runId : undefined
      const run = runs.find(run => run.id === runId)
      if (!run) continue
      completion = unavailableCompletion(run)
    }
    if (byRun.has(completion.runId)) {
      unavailable = true
      completion = unavailableCompletion(runs.find(run => run.id === completion.runId)!)
    }
    byRun.set(completion.runId, completion)
  }
  return { values: [...byRun.values()], ...(unavailable ? { warning: COMPLETION_OBSERVATION_WARNING } : {}) }
}
function state(value: unknown): AgentMuxBrowserTaskState {
  const source = record(value)
  const assets = bounded(source.assets, 32).map(value => record(value))
  const runs = bounded(source.runs, 64).map(run)
  const selectedRunId = source.selectedRunId === undefined ? undefined : source.selectedRunId === null ? null : identifier(source.selectedRunId)
  if (selectedRunId && !runs.some(run => run.id === selectedRunId)) bad('Browser task selected run is not present.')
  const batches = source.batches === undefined ? undefined : bounded(source.batches, 32).map(batch)
  const activeBatchId = source.activeBatchId === undefined ? undefined : source.activeBatchId === null ? null : identifier(source.activeBatchId)
  if (activeBatchId && !batches?.some(batch => batch.id === activeBatchId)) bad('Browser task active batch is not present.')
  if (batches && (new Set(batches.map(batch => batch.id)).size !== batches.length || batches.some(batch => batch.items.some((item, index) => {
    const original = runs.find(run => run.id === item.runId)
    return item.runId !== undefined && (!original || index > batch.nextItem || original.browserId !== batch.browserId || original.assetId !== batch.assetId || original.version !== batch.version || (index < batch.nextItem && original.status !== 'completed'))
  })))) bad('Browser task batch references do not match their original runs.')
  for (const batch of batches ?? []) {
    const related = batch.items.flatMap(item => { const original = runs.find(run => run.id === item.runId); return original ? [original] : [] })
    if (batch.operationCount !== related.reduce((sum, run) => sum + run.operationIds.length, 0) ||
        batch.executedMillis !== related.reduce((sum, run) => sum + (run.executedMillis ?? 0), 0)) bad('Browser task batch costs are not bound to original runs.')
  }
  const completionRead = source.completion === undefined ? undefined : completionObservations([source.completion], runs)
  if (completionRead?.values[0] && completionRead.values[0].runId !== selectedRunId) {
    const selected = runs.find(run => run.id === selectedRunId)
    completionRead.values = selected ? [unavailableCompletion(selected)] : []
    completionRead.warning = COMPLETION_OBSERVATION_WARNING
  }
  const noticesRead = notices(source)
  if (completionRead?.warning) noticesRead.warning = [noticesRead.warning, completionRead.warning].filter(Boolean).join(' ')
  return { assets, runs, ...(completionRead?.values[0] ? { completion: completionRead.values[0] } : {}), ...(source.parallel === undefined ? {} : { parallel: source.parallel === null ? null : parseBrowserTaskParallelSummary(source.parallel) }), ...(batches === undefined ? {} : { batches }), ...(selectedRunId === undefined ? {} : { selectedRunId }), ...(activeBatchId === undefined ? {} : { activeBatchId }), ...noticesRead }
}
function reliability(value: unknown): AgentMuxBrowserTaskReliability {
  const source = record(value), population = record(source.population), counts = record(source.counts)
  const parsedCounts = Object.fromEntries(RESULTS.map(key => [key, integer(counts[key])])) as Record<BrowserTaskReliabilityResult, number>
  const retainedRuns = integer(population.retainedRuns), terminalRuns = integer(population.terminalRuns), pendingRuns = integer(population.pendingRuns)
  if (retainedRuns > 64 || terminalRuns + pendingRuns !== retainedRuns || RESULTS.reduce((n, key) => n + parsedCounts[key], 0) !== terminalRuns) bad('Browser task reliability population is inconsistent.')
  const passRate = source.passRate
  if (terminalRuns === 0 ? passRate !== null : typeof passRate !== 'number' || !Number.isFinite(passRate) || passRate !== parsedCounts.passed / terminalRuns) bad('Browser task pass rate is inconsistent.')
  const samples = bounded(source.samples, 64).map(value => {
    const row = record(value)
    if (!RESULTS.includes(row.result as BrowserTaskReliabilityResult)) bad('Browser task reliability sample is invalid.')
    return { runId: identifier(row.runId), result: row.result as BrowserTaskReliabilityResult, reason: note(row.reason) }
  })
  if (samples.length !== terminalRuns || new Set(samples.map(row => row.runId)).size !== samples.length) bad('Browser task reliability samples are inconsistent.')
  for (const key of RESULTS) if (samples.filter(row => row.result === key).length !== parsedCounts[key]) bad('Browser task reliability sample counts are inconsistent.')
  if (source.selectedRunStatus !== undefined && !STATUSES.has(source.selectedRunStatus as BrowserTaskRunStatus)) bad('Browser task selected run status is invalid.')
  const scriptCompleted = integer(source.scriptCompleted), humanInterventions = integer(source.humanInterventions)
  if (scriptCompleted > terminalRuns) bad('Browser task script completion count is inconsistent.')
  return { browserId: identifier(source.browserId), assetId: identifier(source.assetId), version: integer(source.version, false, 1),
    selectedRunId: source.selectedRunId === null ? null : identifier(source.selectedRunId),
    ...(source.selectedRunStatus === undefined ? {} : { selectedRunStatus: source.selectedRunStatus as BrowserTaskRunStatus }),
    population: { retainedRuns, terminalRuns, pendingRuns, firstStartedAt: nullableTime(population.firstStartedAt), lastUpdatedAt: nullableTime(population.lastUpdatedAt) },
    counts: parsedCounts, scriptCompleted, humanInterventions, passRate: passRate as number | null, samples, ...notices(source) }
}

export function parseBrowserTaskControlResult(operation: BrowserTaskControlPayload['operation'], value: unknown): BrowserTaskControlResult {
  const source = record(value)
  let serialized: string
  try { serialized = JSON.stringify(source) } catch { bad('Browser task result cannot be serialized.') }
  if (Buffer.byteLength(serialized) > MAX_BYTES) bad('Browser task result byte budget exceeded.')
  switch (operation) {
    case 'browser.task.export': {
      rpcRecord(source, ['operation', 'bundle'], 'CONTROL_PROTOCOL_ERROR')
      return { operation, bundle: parseBrowserTaskPortableBundle(source.bundle, false) }
    }
    case 'browser.task.source': {
      rpcRecord(source, ['operation', 'browserId', 'source'], 'CONTROL_PROTOCOL_ERROR')
      const browserId = identifier(source.browserId)
      if (source.source === null) return { operation, browserId, source: null }
      const row = rpcRecord(source.source, ['id', 'browserId', 'revision', 'status', 'stepCount', 'warning'], 'CONTROL_PROTOCOL_ERROR')
      if (!['recording', 'stopped', 'interrupted'].includes(row.status as string)) bad('Task source status is invalid.')
      return { operation, browserId, source: { id: identifier(row.id), browserId: identifier(row.browserId), revision: integer(row.revision, false, 1), status: row.status as AgentMuxBrowserTaskSource['status'], stepCount: integer(row.stepCount), ...notices(row) } }
    }
    case 'browser.task.draft': {
      rpcRecord(source, ['operation', 'asset'], 'CONTROL_PROTOCOL_ERROR')
      const row = rpcRecord(source.asset, ['id', 'browserId', 'revision', 'sourceRecordingId', 'importedFrom', 'draft', 'warning'], 'CONTROL_PROTOCOL_ERROR')
      if ((row.sourceRecordingId === undefined) === (row.importedFrom === undefined)) bad('Task draft source is ambiguous or missing.')
      return { operation, asset: { id: identifier(row.id), browserId: identifier(row.browserId), revision: integer(row.revision, false, 1),
        ...(row.sourceRecordingId === undefined ? { importedFrom: parseBrowserTaskPortableSource(row.importedFrom, false) } : { sourceRecordingId: identifier(row.sourceRecordingId) }), draft: definition(row.draft), ...notices(row) } }
    }
    case 'browser.task.import':
    case 'browser.task.create': {
      rpcRecord(source, ['operation', 'creation'], 'CONTROL_PROTOCOL_ERROR')
      const row = rpcRecord(source.creation, ['createOperationId', 'assetId', 'browserId', 'status'], 'CONTROL_PROTOCOL_ERROR')
      if (row.status !== 'created') bad('Task creation receipt is not confirmed.')
      return { operation, creation: { createOperationId: identifier(row.createOperationId), assetId: identifier(row.assetId), browserId: identifier(row.browserId), status: 'created' } }
    }
    case 'browser.task.import-inspect':
    case 'browser.task.create-inspect': {
      rpcRecord(source, ['operation', 'creation'], 'CONTROL_PROTOCOL_ERROR')
      const row = rpcRecord(source.creation, ['createOperationId', 'assetId', 'browserId', 'status', 'warning'], 'CONTROL_PROTOCOL_ERROR')
      if (!['created', 'not-found', 'unknown'].includes(row.status as string)) bad('Task creation status is invalid.')
      return { operation, creation: { createOperationId: identifier(row.createOperationId), assetId: identifier(row.assetId), browserId: identifier(row.browserId), status: row.status as BrowserTaskCreateStatus['status'], ...notices(row) } }
    }
    case 'browser.task.assets': return { operation, state: state(source.state) }
    case 'browser.task.edit':
    case 'browser.task.publish': {
      const row = rpcRecord(source.asset, ['id', 'browserId', 'revision'], 'CONTROL_PROTOCOL_ERROR')
      const asset = { id: identifier(row.id), browserId: identifier(row.browserId), revision: integer(row.revision, false, 1) }
      return operation === 'browser.task.edit' ? { operation, asset } : { operation, asset, publishedVersion: integer(source.publishedVersion, false, 1) }
    }
    case 'browser.task.batch': return { operation, batch: batch(source.batch) }
    case 'browser.task.batch-stop': return { operation, batch: source.batch === null ? null : batch(source.batch) }
    case 'browser.task.inspect': return { operation, inspection: source.inspection === null ? null : inspection(source.inspection) }
    case 'browser.task.parallel-continue':
      rpcRecord(source, ['operation', 'run', 'continuation'], 'CONTROL_PROTOCOL_ERROR')
      return { operation, ...parseBrowserTaskParallelContinuationReceipt({ run: source.run, continuation: source.continuation }) }
    case 'browser.task.parallel-stop':
      rpcRecord(source, ['operation', 'run'], 'CONTROL_PROTOCOL_ERROR')
      return { operation, run: source.run === null ? null : parseBrowserTaskParallelSummary(source.run) }
    case 'browser.task.parallel': return { operation, run: parseBrowserTaskParallelSummary(source.run) }
    case 'browser.task.parallel-list': return { operation, history: parseBrowserTaskParallelList(source.history) }
    case 'browser.task.parallel-inspect':
      rpcRecord(source, ['operation', 'inspection'], 'CONTROL_PROTOCOL_ERROR')
      return { operation, inspection: source.inspection === null ? null : parseBrowserTaskParallelInspection(source.inspection) }
    case 'browser.task.run': return { operation, run: run(source.run) }
    case 'browser.task.stop': return { operation, run: source.run === null ? null : run(source.run) }
    case 'browser.task.reliability': return { operation, reliability: reliability(source.reliability) }
  }
}

export function assertBrowserTaskControlTarget(request: BrowserTaskControlPayload, result: BrowserTaskControlResult): void {
  if (request.operation !== result.operation) bad('Browser task result operation does not match its request.')
  if (request.operation === 'browser.task.export' && result.operation === request.operation) {
    if (result.bundle.source.assetId !== request.assetId || result.bundle.source.revision !== request.expectedRevision || result.bundle.source.publishedVersion !== request.version) bad('Task export belongs to another asset revision or version.')
  } else if ((request.operation === 'browser.task.import' || request.operation === 'browser.task.import-inspect') && result.operation === request.operation) {
    if (result.creation.browserId !== request.browserId || result.creation.assetId !== request.input.assetId || result.creation.createOperationId !== request.input.createOperationId) bad('Task import receipt belongs to another original request.')
  } else if (request.operation === 'browser.task.source' && result.operation === request.operation) {
    if (result.browserId !== request.browserId || result.source && result.source.browserId !== request.browserId) bad('Task source belongs to another Browser.')
  } else if (request.operation === 'browser.task.parallel-continue' && result.operation === request.operation) {
    if (result.run.browserId !== request.browserId || result.run.operationId !== request.operationId || result.continuation.id !== request.input.continuationId || result.continuation.targetId !== request.targetId) bad('Continuation receipt belongs to another original target or request.')
  } else if (request.operation === 'browser.task.parallel-stop' && result.operation === request.operation) {
    if (result.run && (result.run.browserId !== request.browserId || result.run.operationId !== request.operationId)) bad('Parallel task stop belongs to another original operation.')
  } else if (request.operation === 'browser.task.parallel' && result.operation === request.operation) {
    if (result.run.operationId !== request.input.operationId || result.run.browserId !== request.browserId || result.run.assetId !== request.assetId || result.run.version !== request.version || result.run.targetCount !== request.input.targets.length) bad('Task execution receipt belongs to another original target set.')
  } else if (request.operation === 'browser.task.parallel-list' && result.operation === request.operation) {
    if (result.history.runs.some(run => run.browserId !== request.browserId) || result.history.page.before !== (request.before ?? null) || result.history.page.limit !== (request.limit ?? 32)) bad('Task execution history belongs to another original library or page.')
  } else if (request.operation === 'browser.task.parallel-inspect' && result.operation === request.operation) {
    if (request.continuationId !== undefined && result.inspection?.continuation && result.inspection.continuation.id !== request.continuationId) bad('Continuation inspection names another original request.')
    const inspection = result.inspection
    if (inspection && (inspection.run.browserId !== request.browserId || request.operationId && inspection.run.operationId !== request.operationId || inspection.page.after !== (request.after ?? null) || inspection.page.limit !== (request.limit ?? 32))) bad('Task execution inspection belongs to another original target set or page.')
  } else if (request.operation === 'browser.task.inspect' && result.operation === request.operation) {
    if (result.inspection && (result.inspection.runs.some(run => run.browserId !== request.browserId) || request.runId && !result.inspection.runs.some(run => run.id === request.runId))) bad('Task inspection belongs to another original run or Browser.')
  } else if (request.operation === 'browser.task.draft' && result.operation === request.operation) {
    if (result.asset.browserId !== request.browserId || result.asset.id !== request.assetId) bad('Task draft belongs to another asset.')
  } else if (request.operation === 'browser.task.create' && result.operation === request.operation) {
    if (result.creation.browserId !== request.browserId || result.creation.assetId !== request.input.assetId || result.creation.createOperationId !== request.input.createOperationId) bad('Task creation receipt belongs to another original request.')
  } else if (request.operation === 'browser.task.create-inspect' && result.operation === request.operation) {
    if (result.creation.browserId !== request.browserId || result.creation.assetId !== request.input.assetId || result.creation.createOperationId !== request.input.createOperationId) bad('Task creation inspection belongs to another original request.')
  } else if (request.operation === 'browser.task.assets' && result.operation === request.operation) {
    if (result.state.assets.some(asset => asset.browserId !== request.browserId) || result.state.runs.some(run => run.browserId !== request.browserId) || result.state.batches?.some(batch => batch.browserId !== request.browserId)) bad('Browser task state belongs to another Browser.')
  } else if ((request.operation === 'browser.task.edit' || request.operation === 'browser.task.publish') && result.operation === request.operation) {
    if (result.asset.id !== request.assetId || result.asset.browserId !== request.browserId || result.asset.revision !== request.expectedRevision + 1) bad('Browser task authoring receipt belongs to another asset or revision.')
  } else if (request.operation === 'browser.task.batch' && result.operation === request.operation) {
    if (result.batch.browserId !== request.browserId || result.batch.assetId !== request.assetId || result.batch.version !== request.version ||
        (request.batchId !== undefined && request.batchId !== result.batch.id) || result.batch.items.length !== request.items.length || result.batch.items.some((item, index) => item.id !== request.items[index]?.id)) bad('Browser task batch belongs to another invocation.')
  } else if (request.operation === 'browser.task.batch-stop' && result.operation === request.operation && result.batch) {
    if (result.batch.browserId !== request.browserId || result.batch.id !== request.batchId) bad('Browser task batch stop belongs to another batch.')
  } else if (request.operation === 'browser.task.reliability' && result.operation === request.operation) {
    if (result.reliability.browserId !== request.browserId || result.reliability.assetId !== request.assetId || result.reliability.version !== request.version) bad('Browser task reliability belongs to another version.')
  } else if (request.operation === 'browser.task.run' && result.operation === request.operation) {
    if (result.run.browserId !== request.browserId || result.run.assetId !== request.assetId || result.run.version !== request.version || (request.runId !== undefined && result.run.id !== request.runId)) bad('Browser task run belongs to another invocation.')
  } else if (request.operation === 'browser.task.stop' && result.operation === request.operation && result.run) {
    if (result.run.browserId !== request.browserId || result.run.id !== request.runId) bad('Browser task stop belongs to another run.')
  }
}
