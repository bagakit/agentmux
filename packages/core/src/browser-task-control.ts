import { AgentMuxError } from './errors.js'

export type BrowserTaskRunStatus = 'ready' | 'running' | 'waiting-human' | 'completed' | 'interrupted' | 'failed' | 'stopped'
export type BrowserTaskReliabilityResult = 'passed' | 'not-met' | 'unavailable' | 'unknown' | 'failed' | 'stopped' | 'interrupted'

/** Typed Client facts only. Core neither interprets steps nor owns workflow execution. */
export type AgentMuxBrowserTaskRun = {
  id: string; assetId: string; version: number; browserId: string; nextStep: number
  status: BrowserTaskRunStatus; operationIds: string[]; pendingCheckpointId?: string
  stepExecutions?: { stepId: string; operationId: string }[]
  branchDecisions?: { stepId: string; operationId: string; navigationId: string; result: 'true' | 'false' | 'unknown'; nextStepId?: string | null }[]
  executedMillis?: number
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
  | { operation: 'browser.task.assets'; browserId: string }
  | { operation: 'browser.task.batch'; browserId: string; assetId: string; version: number; items: { id: string; parameters: Record<string, string> }[]; parameters: Record<string, string>; batchId?: string }
  | { operation: 'browser.task.batch-stop'; browserId: string; batchId: string }
  | { operation: 'browser.task.run'; browserId: string; assetId: string; version: number; parameters: Record<string, string>; mode?: 'run' | 'step'; runId?: string }
  | { operation: 'browser.task.stop'; browserId: string; runId: string }
  | { operation: 'browser.task.reliability'; browserId: string; assetId: string; version: number }
export type BrowserTaskControlResult =
  | { operation: 'browser.task.assets'; state: AgentMuxBrowserTaskState }
  | { operation: 'browser.task.batch'; batch: AgentMuxBrowserTaskBatch }
  | { operation: 'browser.task.batch-stop'; batch: AgentMuxBrowserTaskBatch | null }
  | { operation: 'browser.task.run'; run: AgentMuxBrowserTaskRun }
  | { operation: 'browser.task.stop'; run: AgentMuxBrowserTaskRun | null }
  | { operation: 'browser.task.reliability'; reliability: AgentMuxBrowserTaskReliability }

const STATUSES = new Set<BrowserTaskRunStatus>(['ready', 'running', 'waiting-human', 'completed', 'interrupted', 'failed', 'stopped'])
const RESULTS: BrowserTaskReliabilityResult[] = ['passed', 'not-met', 'unavailable', 'unknown', 'failed', 'stopped', 'interrupted']
const MAX_BYTES = 1_048_576

export function isBrowserTaskControlOperation(operation: string): operation is BrowserTaskControlPayload['operation'] {
  return operation === 'browser.task.assets' || operation === 'browser.task.batch' || operation === 'browser.task.batch-stop' || operation === 'browser.task.run' || operation === 'browser.task.stop' || operation === 'browser.task.reliability'
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

export function parseBrowserTaskControlPayload(value: unknown): BrowserTaskControlPayload {
  const source = record(value, true)
  const browserId = identifier(source.browserId, true)
  if (source.operation === 'browser.task.assets') return { operation: source.operation, browserId }
  if (source.operation === 'browser.task.batch-stop') return { operation: source.operation, browserId, batchId: identifier(source.batchId, true) }
  if (source.operation === 'browser.task.stop') return { operation: source.operation, browserId, runId: identifier(source.runId, true) }
  if (source.operation !== 'browser.task.run' && source.operation !== 'browser.task.reliability' && source.operation !== 'browser.task.batch') bad('Browser task operation is invalid.', true)
  const assetId = identifier(source.assetId, true), version = integer(source.version, true, 1)
  if (source.operation === 'browser.task.reliability') return { operation: source.operation, browserId, assetId, version }
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
  if (source.mode !== undefined && source.mode !== 'run' && source.mode !== 'step') bad('Browser task execution mode is invalid.', true)
  return { operation: source.operation, browserId, assetId, version, parameters: Object.fromEntries(entries) as Record<string, string>,
    ...(source.mode === undefined ? {} : { mode: source.mode }),
    ...(source.runId === undefined ? {} : { runId: identifier(source.runId, true) }) }
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
  return { id: identifier(source.id), browserId: identifier(source.browserId), assetId: identifier(source.assetId), version: integer(source.version, false, 1),
    nextStep: integer(source.nextStep), status: source.status as BrowserTaskRunStatus, operationIds, startedAt, updatedAt,
    ...(stepExecutions === undefined ? {} : { stepExecutions }), ...(branchDecisions === undefined ? {} : { branchDecisions }),
    ...(source.executedMillis === undefined ? {} : { executedMillis: time(source.executedMillis) }),
    ...(source.pendingCheckpointId === undefined ? {} : { pendingCheckpointId: identifier(source.pendingCheckpointId) }), ...notices(source) }
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
  return { assets, runs, ...(batches === undefined ? {} : { batches }), ...(selectedRunId === undefined ? {} : { selectedRunId }), ...(activeBatchId === undefined ? {} : { activeBatchId }), ...notices(source) }
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
    case 'browser.task.assets': return { operation, state: state(source.state) }
    case 'browser.task.batch': return { operation, batch: batch(source.batch) }
    case 'browser.task.batch-stop': return { operation, batch: source.batch === null ? null : batch(source.batch) }
    case 'browser.task.run': return { operation, run: run(source.run) }
    case 'browser.task.stop': return { operation, run: source.run === null ? null : run(source.run) }
    case 'browser.task.reliability': return { operation, reliability: reliability(source.reliability) }
  }
}

export function assertBrowserTaskControlTarget(request: BrowserTaskControlPayload, result: BrowserTaskControlResult): void {
  if (request.operation !== result.operation) bad('Browser task result operation does not match its request.')
  if (request.operation === 'browser.task.assets' && result.operation === request.operation) {
    if (result.state.assets.some(asset => asset.browserId !== request.browserId) || result.state.runs.some(run => run.browserId !== request.browserId) || result.state.batches?.some(batch => batch.browserId !== request.browserId)) bad('Browser task state belongs to another Browser.')
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
