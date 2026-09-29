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
export type AppProcessRole = 'main' | 'renderer' | 'browser' | 'gpu' | 'utility' | 'other'
export type AppUsageGroup = { role: AppProcessRole; processCount: number; cpuPercent: number | null; rssKib: number }
export type AppUsage = {
  processCount: number | null; cpuPercent: number | null; rssKib: number | null
  groups: AppUsageGroup[]; unavailable: string | null
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
export type MetricsRenderer = { window: MetricsWindow; counts: RendererResourceOwnerCounts }
export type MetricsRendererRequest = { operation: 'metrics.renderer'; requestId: string; window: MetricsWindow }
export type MetricsRendererResult = MetricsRenderer & { operation: 'metrics.renderer'; observedAt: number }
export type MetricsObservation = {
  schema: 'agentmux.metrics.v1'; observedAt: number
  scope: { kind: 'unix-host'; hostId: 'local'; hostname: string; mainPid: number }
  window: MetricsWindow | null
  units: { cpu: 'percent'; rss: 'KiB'; storage: 'bytes'; cpuAggregate: '10s-reading-peak'; rssAggregate: 'latest' }
  process: MetricsSource<RunUsage[]>; app: MetricsSource<AppUsage>
  runtime: MetricsSource<RuntimeUsage[]>; main: MetricsSource<MainResourceOwnerCounts>
  renderer: MetricsSource<MetricsRenderer>
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
  if (Object.keys(source).length !== Object.keys(fields).length) invalid()
  for (const [key, parse] of Object.entries(fields)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor || !('value' in descriptor)) invalid()
    parse(descriptor.value)
  }
}
const array = (parse: Parser): Parser => v => {
  if (!Array.isArray(v) || v.length > 4096) invalid()
  for (const item of v) parse(item)
}
const windowParser = record({ windowId: count, webContentsId: count, generation: count })
const countsParser = record({ monacoEditors: nullable(count), monacoModels: nullable(count), documents: count,
  runtimeSubscriptions: count, terminalViews: count, terminalAddons: count, terminalListeners: count })
export function parseRendererResourceOwnerCounts(value: unknown): RendererResourceOwnerCounts {
  countsParser(value); return value as RendererResourceOwnerCounts
}
export function parseMetricsRendererResult(value: unknown): MetricsRendererResult {
  record({ operation: literal('metrics.renderer'), window: windowParser, observedAt: number, counts: countsParser })(value)
  return value as MetricsRendererResult
}
const runParser = record({ runId: identity, hostId: identity, rootPid: count,
  processCount: nullable(count), cpuPercent: nullable(number), rssKib: nullable(number), rootRssKib: nullable(number),
  descendantsRssKib: nullable(number), descendantProcessCount: nullable(count) })
const appParser = record({ processCount: nullable(count), cpuPercent: nullable(number), rssKib: nullable(number),
  groups: array(record({ role: v => { if (!['main','renderer','browser','gpu','utility','other'].includes(v as string)) invalid() },
    processCount: count, cpuPercent: nullable(number), rssKib: number })), unavailable: nullable(text) })
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
  window: nullable(windowParser), units: record({ cpu: literal('percent'), rss: literal('KiB'), storage: literal('bytes'),
    cpuAggregate: literal('10s-reading-peak'), rssAggregate: literal('latest') }),
  process: source(array(runParser)), app: source(appParser), runtime: source(array(runtimeParser)),
  main: source(mainParser), renderer: source(record({ window: windowParser, counts: countsParser })) })
export function parseMetricsObservation(value: unknown): MetricsObservation {
  observationParser(value)
  const result = value as MetricsObservation
  const rendererWindow = result.renderer.data?.window
  if (rendererWindow && (!result.window || rendererWindow.windowId !== result.window.windowId ||
    rendererWindow.webContentsId !== result.window.webContentsId || rendererWindow.generation !== result.window.generation)) invalid()
  return result
}
