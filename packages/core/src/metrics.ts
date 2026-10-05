import { readInputObservation } from './performance-diagnostics.js'
import type { ClientPerformanceDiagnostics, InputPerformanceSnapshot } from './performance-diagnostics.js'
import type { RendererPerformanceSnapshot } from './renderer-performance.js'
export type * from './renderer-performance.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxRuntimeResourceSnapshot } from './types.js'
import type { RuntimeStorageUsage } from './runtime-storage-usage.js'

export type RendererResourceOwnerCounts = {
  monacoEditors: number | null; monacoModels: number | null; documents: number
  runtimeSubscriptions: number; terminalViews: number; terminalAddons: number; terminalListeners: number
}
export type RunUsage = {
  runId: string; hostId: string; rootPid: number; processCount: number | null
  cpuPercent: number | null; rssKib: number | null; rootRssKib: number | null
  descendantsRssKib: number | null; descendantProcessCount: number | null
}
/** Totals of the same claimed PID batch; availability and observation time belong to process. */
export type RunUsageTotals = {
  coverage: { trackedRuns: number; observedRoots: number; missingRoots: number }
  processCount: number | null; cpuPercent: number | null; rssKib: number | null
}
export type AppProcessRole = 'main' | 'renderer' | 'browser' | 'gpu' | 'utility' | 'other'
export type AppUsageGroup = { role: AppProcessRole; processCount: number; cpuPercent: number | null; rssKib: number }
export type AppProcessType = string
/** Latest cumulative-counter interval, distinct from the group's 10s reading peak. */
export type AppUsageProcess = {
  pid: number; creationTime: number; role: AppProcessRole; type: AppProcessType
  cpuPercent: number | null; intervalMs: number | null; rssKib: number
}
export type AppUsage = {
  processCount: number | null; cpuPercent: number | null; rssKib: number | null
  groups: AppUsageGroup[]; processes: AppUsageProcess[]; omittedProcesses: number; logicalCpuCount: number | null; unavailable: string | null
}
export type MainResourceOwnerCounts = {
  sessionAttachmentOwners: number; sessionAttachmentLeases: number; fileWatchers: number
  browserViews: number; releasedBrowserViews: number
}
export type RuntimeUsage = {
  hostId: string; resources: AgentMuxRuntimeResourceSnapshot | null; unavailable: string | null
  process: { cpuPercent: null; rssKib: null; unavailable: string }
  runtimeStorage: RuntimeStorageUsage | null; runtimeStorageUnavailable: string | null
  runtimeStorageObservedAt: number | null
}
export type MetricsSource<T> = {
  state: 'pending' | 'available' | 'stale' | 'unavailable'
  observedAt: number | null; lastSuccessAt: number | null; reason: string | null; data: T | null
}
export type MetricsWindow = { windowId: number; webContentsId: number; generation: number }
export type RendererProcessIdentity = { pid: number | null; creationTime: number | null }
export type RendererMemoryObservation = {
  sampledAt: number; scope: 'renderer-v8-isolate'
  heap: { usedHeapKib: number; totalHeapKib: number; physicalHeapKib: number; heapLimitKib: number } | null
  unavailable: string | null
}
export type RendererMemorySnapshot = { process: RendererProcessIdentity; memory: RendererMemoryObservation }
export type MetricsRenderer = RendererMemorySnapshot & { window: MetricsWindow; counts: RendererResourceOwnerCounts; performance: RendererPerformanceSnapshot }
export type MetricsRendererRequest = { operation: 'metrics.renderer'; requestId: string; window: MetricsWindow }
export type MetricsRendererResult = MetricsRenderer & { operation: 'metrics.renderer'; observedAt: number }
export type MetricsObservation = {
  schema: 'agentmux.metrics.v1'; observedAt: number
  scope: { kind: 'unix-host'; hostId: 'local'; hostname: string; mainPid: number }
  window: MetricsWindow | null
  units: { cpu: 'percent'; cpuBasis: 'one-logical-core'; rss: 'KiB'; storage: 'bytes'; cpuAggregate: '10s-reading-peak'; rssAggregate: 'latest' }
  process: MetricsSource<RunUsage[]>; runTotals: RunUsageTotals | null; app: MetricsSource<AppUsage>
  runtime: MetricsSource<RuntimeUsage[]>; main: MetricsSource<MainResourceOwnerCounts>
  diagnostics: MetricsSource<PerformanceDiagnostics>
  renderer: MetricsSource<MetricsRenderer>
}
export type PerformanceDiagnostics = {
  main: ClientPerformanceDiagnostics
  hosts: { hostId: string; data: ClientPerformanceDiagnostics | null; unavailable: string | null }[]
  omittedHosts: number
  storage: { location: 'main-user-home-volume'; availableBytes: number; totalBytes: number } | null
  storageUnavailable: string | null
  eventLoop: { resolutionMs: 20; generation: number; count: number; meanMs: number | null; maxMs: number | null }
}
export type MetricsSubscription = { dispose(): void }
/** The host owns observation. Core only frames, validates and releases consumption. */
export interface AgentMuxMetricsPort {
  subscribe(onSnapshot: (value: MetricsObservation) => void, onEnd: (error?: Error) => void,
    signal: AbortSignal): Promise<MetricsSubscription>
}

type Parser = (value: unknown) => void
function invalid(): never { throw new AgentMuxError('Metrics observation is invalid.', 'CONTROL_PROTOCOL_ERROR') }
const number: Parser = v => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) invalid() }
const count: Parser = v => { number(v); if (!Number.isSafeInteger(v)) invalid() }
const text: Parser = v => { if (typeof v !== 'string' || v.length > 4096) invalid() }
const identity: Parser = v => { text(v); if (!(v as string).trim() || /[\0\r\n]/u.test(v as string)) invalid() }
const nullable = (p: Parser): Parser => v => { if (v !== null) p(v) }
const literal = (expected: unknown): Parser => v => { if (v !== expected) invalid() }
const record = (fields: Record<string, Parser>): Parser => v => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid()
  const source = v as Record<string, unknown>
  if ((Object.getPrototypeOf(source) !== Object.prototype && Object.getPrototypeOf(source) !== null) ||
    Reflect.ownKeys(source).length !== Object.keys(fields).length) invalid()
  for (const [key, parse] of Object.entries(fields)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid()
    parse(descriptor.value)
  }
}
const boundedArray = (max: number, parse: Parser): Parser => v => {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > max ||
    Reflect.ownKeys(v).length !== v.length + 1) invalid()
  for (let index = 0; index < v.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(v, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid()
    parse(descriptor.value)
  }
}
const array = (parse: Parser): Parser => boundedArray(4096, parse)
const windowParser = record({ windowId: count, webContentsId: count, generation: count })
const countsParser = record({ monacoEditors: nullable(count), monacoModels: nullable(count), documents: count,
  runtimeSubscriptions: count, terminalViews: count, terminalAddons: count, terminalListeners: count })
const boolean: Parser = v => { if (typeof v !== 'boolean') invalid() }
const timingParser = record({ count, totalMs: number, maxMs: number })
const terminalInteractionParser = record({ observedSinceAt: number,
  keydown: record({ count, unknownDelayCount: count, delay: timingParser }),
  wheel: record({ count, unknownDelayCount: count, delay: timingParser }),
  writeRequests: record({ started: count, completed: count, failed: count, pending: count, wall: timingParser,
    lastStartedAt: nullable(number), lastSettledAt: nullable(number) }),
  lastEvent: nullable(record({ kind: v => { if (!['keydown', 'wheel'].includes(v as string)) invalid() },
    observedAt: number, delayMs: nullable(number), visible: boolean, liveReady: boolean, acceptsInput: boolean, readOnly: boolean,
    buffer: v => { if (!['normal', 'alternate'].includes(v as string)) invalid() }, mouseTrackingMode: identity })) })
const inputParentParser: Parser = value => { if (!readInputObservation(value)) invalid() }
const inputPhasesParser = record(Object.fromEntries(['queued','current-run','operation','native-input','received','connected-client','host-call','reply-ready'].map(key => [key, nullable(number)])))
const inputEntryParser = record({ id: count, sessionId: nullable(identity), runId: identity,
  hostId: nullable(identity), ownerInstanceId: nullable(identity), sender: nullable(record({ webContentsId: count, window: nullable(windowParser) })),
  parent: nullable(inputParentParser), parentMatch: v => { if (!['absent','unique','ambiguous','unknown-omitted'].includes(v as string)) invalid() }, phases: inputPhasesParser,
  kind: v => { if (!['user','mouse','protocol','paste','semantic','terminal'].includes(v as string)) invalid() }, bytes: nullable(count),
  enqueuedAt: number, stage: v => { if (!['queued','current-run','operation','native-input','received','connected-client','host-call','reply-ready'].includes(v as string)) invalid() },
  stageMs: number, totalMs: number, result: v => { if (!['pending','completed','failed'].includes(v as string)) invalid() } })
const inputPerformanceParser = record({ startedAt: number, started: count, completed: count, failed: count, pending: count,
  kinds: record({ user: count, mouse: count, protocol: count, paste: count, semantic: count, terminal: count }),
  queueWait: timingParser, currentRun: timingParser, operation: timingParser, nativeInput: timingParser,
  active: boundedArray(64, inputEntryParser), omittedActive: count, recent: boundedArray(32, inputEntryParser), omittedRecent: count, oldestPendingMs: nullable(number) })
const clientPerformanceParser = record({ processId: count, observedAt: number, input: inputPerformanceParser,
  carrier: record({ encoded: timingParser, decodedFrames: timingParser, decodedValues: timingParser,
    encodedBytes: count, encodedFrames: count, decodedBytes: count, rejected: count }) })
/** Validate one source before combining it with independent local and Host facts. */
export function parseClientPerformanceDiagnostics(value: unknown): ClientPerformanceDiagnostics {
  clientPerformanceParser(value)
  return value as ClientPerformanceDiagnostics
}
const diagnosticsParser = record({ main: clientPerformanceParser,
  hosts: boundedArray(64, record({ hostId: identity, data: nullable(clientPerformanceParser), unavailable: nullable(text) })),
  omittedHosts: count, storage: nullable(record({ location: literal('main-user-home-volume'), availableBytes: count, totalBytes: count })), storageUnavailable: nullable(text), eventLoop: record({ resolutionMs: literal(20), generation: count, count, meanMs: nullable(number), maxMs: nullable(number) }) })
const consumerParser = record({ checks: count, changes: count, commits: count })
const visibilityParser = record({ visible: consumerParser, hidden: consumerParser })
const tabSwitchParser = record({ id: count,
  elapsedMs: number, pendingStage: nullable(v => { if (!['selection', 'placement', 'terminal', 'frame', 'input-gate'].includes(v as string)) invalid() }),
  target: record({ displayWorkspaceId: identity, groupId: identity, tabId: identity, regionId: identity, presentationId: identity }),
  handlerAt: number, inputDelayMs: nullable(number), selectedMs: nullable(number), placedMs: nullable(number),
  terminalMs: nullable(number), inputReadyMs: nullable(number), frameMs: nullable(number),
  state: v => { if (!['pending', 'observed', 'superseded'].includes(v as string)) invalid() },
  mode: v => { if (!['unknown', 'terminal', 'activity', 'other'].includes(v as string)) invalid() },
  terminal: nullable(record({ sessionId: identity, runId: identity, readySinceAt: nullable(number),
    visible: boolean, revealed: boolean, liveReady: boolean, acceptsInput: boolean, readOnly: boolean, replaying: boolean })) })
const timingKinds = ['session-event', 'terminal-write', 'long-task', 'input-delay', 'terminal-interaction'] as const
const timingKind: Parser = v => { if (!timingKinds.includes(v as typeof timingKinds[number])) invalid() }
const timingKindRecord = (parse: Parser): Parser => record(Object.fromEntries(timingKinds.map(kind => [kind, parse])))
const timingEpochParser = record({ startMonoMs: number, endMonoMs: number, timings: timingKindRecord(timingParser) })
const slowEventParser = record({ id: count, kind: timingKind, detail: text, observedAt: number, durationMs: number,
  occurredAtMonoMs: nullable(number), deliveredAtMonoMs: number })
const slowEventsParser: Parser = value => {
  boundedArray(30, slowEventParser)(value)
  for (const kind of timingKinds) if ((value as {kind: string}[]).filter(event => event.kind === kind).length > 6) invalid()
}
const performanceParser = record({ startedAt: number, observedAt: number, recording: literal('bounded-lifetime'),
  selectorTiming: literal('counts-only'), writeTiming: literal('parser-callback-wall'),
  consumers: record({ composer: visibilityParser, sessionPane: visibilityParser }), sessionEvents: timingParser,
  inputRequestDetails: inputPerformanceParser,
  inputRequests: record(Object.fromEntries(['user', 'protocol', 'paste'].map(kind => [kind, record({ started: count, completed: count, failed: count, pending: count, wall: timingParser })]))),
  overlay: record({ triggers: record({ initial: count, demand: count, mutation: count, resize: count, scroll: count, toggle: count, font: count, collect: count }),
    scheduled: count, coalesced: count, candidates: count, geometryReads: count, nativeDemandCount: nullable(count),
    latestCandidates: nullable(count), latestGeometryReads: nullable(count), collect: timingParser }),
  terminalWrites: record({ visible: timingParser, hidden: timingParser, stringCodeUnits: count, bytes: count }),
  inputDelay: record({ state: v => { if (!['observing','unsupported','stopped','unavailable'].includes(v as string)) invalid() },
    reason: nullable(text), durationThresholdMs: literal(16), timing: timingParser }),
  longTasks: record({ state: v => { if (!['observing','unsupported','stopped','unavailable'].includes(v as string)) invalid() }, reason: nullable(text), timing: timingParser }),
  terminals: boundedArray(64, record({ sessionId: identity, runId: identity, regionId: nullable(identity),
    visible: boolean, visibleSinceAt: nullable(number), readySinceAt: nullable(number), revealed: boolean, liveReady: boolean, acceptsInput: boolean,
    replaying: boolean, inFlightWrites: count, queuedItems: count, queuedBytes: count, pendingItems: count, pendingBytes: count,
    cols: count, rows: count, normalLines: count, alternateLines: count, interaction: terminalInteractionParser })), omittedTerminals: count, unavailableTerminals: count,
  tabSwitches: boundedArray(16, tabSwitchParser), tabSwitchesOmitted: count,
  slowEvents: slowEventsParser, slowEventsOmitted: timingKindRecord(count),
  timingEpochs: record({ durationMs: literal(10000), basis: literal('monotonic-occurrence-start'),
    recordingSinceMonoMs: number, observedMonoMs: number, current: timingEpochParser, previous: nullable(timingEpochParser),
    late: timingKindRecord(count), unknown: timingKindRecord(count) }),
  observerCost: record({ snapshots: timingParser, performanceCallbacks: timingParser }) })
export function parseRendererPerformanceSnapshot(value: unknown): RendererPerformanceSnapshot {
  performanceParser(value); return value as RendererPerformanceSnapshot
}
export function parseRendererResourceOwnerCounts(value: unknown): RendererResourceOwnerCounts {
  countsParser(value); return value as RendererResourceOwnerCounts
}
const positiveCount: Parser = v => { count(v); if (v === 0) invalid() }
const rendererProcessParser = record({ pid: nullable(positiveCount), creationTime: nullable(number) })
const rendererMemoryShape = record({ sampledAt: number, scope: literal('renderer-v8-isolate'),
  heap: nullable(record({ usedHeapKib: number, totalHeapKib: number, physicalHeapKib: number, heapLimitKib: number })), unavailable: nullable(identity) })
const rendererMemoryParser: Parser = v => {
  rendererMemoryShape(v)
  const memory = v as RendererMemoryObservation
  if ((memory.heap === null) !== (memory.unavailable !== null)) invalid()
}
export function parseMetricsRendererResult(value: unknown): MetricsRendererResult {
  record({ operation: literal('metrics.renderer'), window: windowParser, observedAt: number, process: rendererProcessParser,
    memory: rendererMemoryParser, counts: countsParser, performance: performanceParser })(value)
  return value as MetricsRendererResult
}
const runParser = record({ runId: identity, hostId: identity, rootPid: count,
  processCount: nullable(count), cpuPercent: nullable(number), rssKib: nullable(number), rootRssKib: nullable(number),
  descendantsRssKib: nullable(number), descendantProcessCount: nullable(count) })
const runTotalsParser: Parser = value => {
  record({ coverage: record({ trackedRuns: count, observedRoots: count, missingRoots: count }),
    processCount: nullable(count), cpuPercent: nullable(number), rssKib: nullable(number) })(value)
  const totals = value as RunUsageTotals
  if (totals.coverage.trackedRuns !== totals.coverage.observedRoots + totals.coverage.missingRoots) invalid()
  if (totals.coverage.missingRoots > 0 && [totals.processCount, totals.cpuPercent, totals.rssKib].some(v => v !== null)) invalid()
}
const appRoleParser: Parser = v => { if (!['main','renderer','browser','gpu','utility','other'].includes(v as string)) invalid() }
const appProcessShape = record({ pid: positiveCount, creationTime: number, role: appRoleParser,
  type: v => { identity(v); if ((v as string).length > 128) invalid() },
  cpuPercent: nullable(number), intervalMs: nullable(v => { number(v); if (v === 0) invalid() }), rssKib: number })
const appProcessParser: Parser = v => {
  appProcessShape(v)
  const process = v as AppUsageProcess
  if ((process.cpuPercent === null) !== (process.intervalMs === null)) invalid()
}
const appParser = record({ processCount: nullable(count), cpuPercent: nullable(number), rssKib: nullable(number),
  groups: boundedArray(6, record({ role: appRoleParser, processCount: count, cpuPercent: nullable(number), rssKib: number })),
  processes: boundedArray(256, appProcessParser), omittedProcesses: count, logicalCpuCount: nullable(positiveCount), unavailable: nullable(text) })
const runtimeParser = record({ hostId: identity,
  resources: nullable(record({ observedAt: number, runCount: count, runningRuns: count, terminatedRuns: count,
    terminatedUnattachedRuns: count, attachments: count, retainedOutputBytes: number })),
  unavailable: nullable(text), process: record({ cpuPercent: literal(null), rssKib: literal(null), unavailable: identity }),
  runtimeStorage: nullable(record({ path: identity, bytes: number })), runtimeStorageUnavailable: nullable(text),
  runtimeStorageObservedAt: nullable(number) })
const mainParser = record({ sessionAttachmentOwners: count, sessionAttachmentLeases: count, fileWatchers: count,
  browserViews: count, releasedBrowserViews: count })
function source(parse: Parser): Parser {
  const shape = record({ state: v => { if (!['pending','available','stale','unavailable'].includes(v as string)) invalid() },
    observedAt: nullable(number), lastSuccessAt: nullable(number), reason: nullable(text), data: nullable(parse) })
  return v => {
    shape(v)
    const s = v as MetricsSource<unknown>
    if (s.observedAt !== s.lastSuccessAt) invalid()
    if (s.state === 'available' && (s.data === null || s.observedAt === null || s.reason !== null)) invalid()
    if (s.state === 'stale' && (s.data === null || s.observedAt === null || !s.reason)) invalid()
    if (s.state === 'unavailable' && (s.data !== null || s.observedAt !== null || !s.reason)) invalid()
    if (s.state === 'pending' && (s.data !== null || s.observedAt !== null || s.reason !== null)) invalid()
  }
}
const observationParser = record({ schema: literal('agentmux.metrics.v1'), observedAt: number,
  scope: record({ kind: literal('unix-host'), hostId: literal('local'), hostname: identity, mainPid: count }),
  window: nullable(windowParser), units: record({ cpu: literal('percent'), cpuBasis: literal('one-logical-core'), rss: literal('KiB'), storage: literal('bytes'),
    cpuAggregate: literal('10s-reading-peak'), rssAggregate: literal('latest') }),
  process: source(array(runParser)), runTotals: nullable(runTotalsParser), app: source(appParser), runtime: source(array(runtimeParser)),
  diagnostics: source(diagnosticsParser), main: source(mainParser), renderer: source(record({ window: windowParser, process: rendererProcessParser, memory: rendererMemoryParser, counts: countsParser, performance: performanceParser })) })
export function parseMetricsObservation(value: unknown): MetricsObservation {
  observationParser(value)
  const result = value as MetricsObservation
  if ((result.process.data === null) !== (result.runTotals === null)) invalid()
  if (result.runTotals && result.runTotals.coverage.trackedRuns !== result.process.data!.length) invalid()
  const rendererWindow = result.renderer.data?.window
  if (rendererWindow && (!result.window || rendererWindow.windowId !== result.window.windowId ||
    rendererWindow.webContentsId !== result.window.webContentsId || rendererWindow.generation !== result.window.generation)) invalid()
  return result
}
