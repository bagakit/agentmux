import { AgentMuxError } from './errors.js'

export type BrowserTaskRunStatus = 'ready' | 'running' | 'waiting-human' | 'completed' | 'interrupted' | 'failed' | 'stopped'
export type BrowserTaskReliabilityResult = 'passed' | 'not-met' | 'unavailable' | 'unknown' | 'failed' | 'stopped' | 'interrupted'

/** Typed Client facts only. Core neither interprets steps nor owns workflow execution. */
export type AgentMuxBrowserTaskRun = {
  id: string; assetId: string; version: number; browserId: string; nextStep: number
  status: BrowserTaskRunStatus; operationIds: string[]; pendingCheckpointId?: string
  startedAt: number; updatedAt: number; warning?: string; completionWarning?: string
}
export type AgentMuxBrowserTaskState = {
  /** Asset semantics and validation belong to the Browser Client. */
  assets: Record<string, unknown>[]
  runs: AgentMuxBrowserTaskRun[]
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
  | { operation: 'browser.task.run'; browserId: string; assetId: string; version: number; parameters: Record<string, string>; mode?: 'run' | 'step'; runId?: string }
  | { operation: 'browser.task.stop'; browserId: string; runId: string }
  | { operation: 'browser.task.reliability'; browserId: string; assetId: string; version: number }
export type BrowserTaskControlResult =
  | { operation: 'browser.task.assets'; state: AgentMuxBrowserTaskState }
  | { operation: 'browser.task.run'; run: AgentMuxBrowserTaskRun }
  | { operation: 'browser.task.stop'; run: AgentMuxBrowserTaskRun | null }
  | { operation: 'browser.task.reliability'; reliability: AgentMuxBrowserTaskReliability }

const STATUSES = new Set<BrowserTaskRunStatus>(['ready', 'running', 'waiting-human', 'completed', 'interrupted', 'failed', 'stopped'])
const RESULTS: BrowserTaskReliabilityResult[] = ['passed', 'not-met', 'unavailable', 'unknown', 'failed', 'stopped', 'interrupted']
const MAX_BYTES = 1_048_576

export function isBrowserTaskControlOperation(operation: string): operation is BrowserTaskControlPayload['operation'] {
  return operation === 'browser.task.assets' || operation === 'browser.task.run' || operation === 'browser.task.stop' || operation === 'browser.task.reliability'
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
function bounded(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) bad('Browser task collection exceeds its budget.')
  return value
}

export function parseBrowserTaskControlPayload(value: unknown): BrowserTaskControlPayload {
  const source = record(value, true)
  const browserId = identifier(source.browserId, true)
  if (source.operation === 'browser.task.assets') return { operation: source.operation, browserId }
  if (source.operation === 'browser.task.stop') return { operation: source.operation, browserId, runId: identifier(source.runId, true) }
  if (source.operation !== 'browser.task.run' && source.operation !== 'browser.task.reliability') bad('Browser task operation is invalid.', true)
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
  return { id: identifier(source.id), browserId: identifier(source.browserId), assetId: identifier(source.assetId), version: integer(source.version, false, 1),
    nextStep: integer(source.nextStep), status: source.status as BrowserTaskRunStatus, operationIds, startedAt, updatedAt,
    ...(source.pendingCheckpointId === undefined ? {} : { pendingCheckpointId: identifier(source.pendingCheckpointId) }), ...notices(source) }
}
function state(value: unknown): AgentMuxBrowserTaskState {
  const source = record(value)
  const assets = bounded(source.assets, 32).map(value => record(value))
  const runs = bounded(source.runs, 64).map(run)
  const selectedRunId = source.selectedRunId === undefined ? undefined : source.selectedRunId === null ? null : identifier(source.selectedRunId)
  if (selectedRunId && !runs.some(run => run.id === selectedRunId)) bad('Browser task selected run is not present.')
  return { assets, runs, ...(selectedRunId === undefined ? {} : { selectedRunId }), ...notices(source) }
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
    case 'browser.task.run': return { operation, run: run(source.run) }
    case 'browser.task.stop': return { operation, run: source.run === null ? null : run(source.run) }
    case 'browser.task.reliability': return { operation, reliability: reliability(source.reliability) }
  }
}

export function assertBrowserTaskControlTarget(request: BrowserTaskControlPayload, result: BrowserTaskControlResult): void {
  if (request.operation !== result.operation) bad('Browser task result operation does not match its request.')
  if (request.operation === 'browser.task.assets' && result.operation === request.operation) {
    if (result.state.assets.some(asset => asset.browserId !== request.browserId) || result.state.runs.some(run => run.browserId !== request.browserId)) bad('Browser task state belongs to another Browser.')
  } else if (request.operation === 'browser.task.reliability' && result.operation === request.operation) {
    if (result.reliability.browserId !== request.browserId || result.reliability.assetId !== request.assetId || result.reliability.version !== request.version) bad('Browser task reliability belongs to another version.')
  } else if (request.operation === 'browser.task.run' && result.operation === request.operation) {
    if (result.run.browserId !== request.browserId || result.run.assetId !== request.assetId || result.run.version !== request.version || (request.runId !== undefined && result.run.id !== request.runId)) bad('Browser task run belongs to another invocation.')
  } else if (request.operation === 'browser.task.stop' && result.operation === request.operation && result.run) {
    if (result.run.browserId !== request.browserId || result.run.id !== request.runId) bad('Browser task stop belongs to another run.')
  }
}
