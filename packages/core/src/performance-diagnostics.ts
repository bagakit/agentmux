/** Read-only, process-local costs. No input data, replay authority or capability gates. */
export type PerformanceTiming = { count: number; totalMs: number; maxMs: number }
export type InputObservationReference = { observerId: string; source: 'user' | 'protocol' | 'paste'; sequence: number }
export type InputPerformanceSender = { webContentsId: number; window: { windowId: number; webContentsId: number; generation: number } | null }
export type InputPerformanceKind = 'user' | 'mouse' | 'protocol' | 'paste' | 'semantic' | 'terminal'
export type InputPerformanceStage = 'queued' | 'current-run' | 'operation' | 'native-input' | 'received' | 'connected-client' | 'host-call' | 'reply-ready'
export type InputPerformancePhases = Record<InputPerformanceStage, number | null>
export type InputPerformanceEntry = {
  id: number; sessionId: string | null; runId: string; kind: InputPerformanceKind; bytes: number | null
  hostId: string | null; ownerInstanceId: string | null; sender: InputPerformanceSender | null
  parent: InputObservationReference | null
  /** A retained duplicate is ambiguous; omitted entries prevent a unique-match claim. */
  parentMatch: 'absent' | 'unique' | 'ambiguous' | 'unknown-omitted'
  enqueuedAt: number; stage: InputPerformanceStage; stageMs: number; totalMs: number
  /** Completed local measurements only. operation/host-call include their nested phases. */
  phases: InputPerformancePhases
  result: 'pending' | 'completed' | 'failed'
}
export type InputPerformanceSnapshot = {
  startedAt: number; started: number; completed: number; failed: number; pending: number
  kinds: Record<InputPerformanceKind, number>
  /** operation is enclosing wall time and includes nativeInput; the two are not additive. */
  queueWait: PerformanceTiming; currentRun: PerformanceTiming; operation: PerformanceTiming; nativeInput: PerformanceTiming
  active: InputPerformanceEntry[]; omittedActive: number; recent: InputPerformanceEntry[]; omittedRecent: number
  /** null with pending>0 means omitted coverage, not a zero-age request. No timer is used. */
  oldestPendingMs: number | null
}
/** Invalid optional diagnostics never become an input capability gate. No getters are evaluated. */
export function readInputObservation(value: unknown): InputObservationReference | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== 3) return null
    const values = Object.getOwnPropertyDescriptors(value)
    const observerId = values.observerId?.value, source = values.source?.value, sequence = values.sequence?.value
    if (!values.observerId?.enumerable || !values.source?.enumerable || !values.sequence?.enumerable ||
      typeof observerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(observerId) ||
      !['user', 'protocol', 'paste'].includes(source) || !Number.isSafeInteger(sequence) || sequence < 1) return null
    return { observerId, source, sequence }
  } catch { return null }
}
export function readInputObservationField(value: unknown): InputObservationReference | null {
  try { return readInputObservation(Object.getOwnPropertyDescriptor(value, 'observation')?.value) } catch { return null }
}
/** Exact finite SDK input positions, before structured cloning or value decoding. Business fields stay untouched. */
export function sanitizeInputObservationArguments(method: string, args: unknown[]): unknown[] {
  return inputObservationArguments(method, args, false)
}
function inputObservationArguments(method: string, args: unknown[], encodedWire: boolean): unknown[] {
  if (method === 'writeTerminal') return args.length > 2 ? [args[0], args[1], readInputObservation(args[2]) ?? undefined, ...args.slice(3)] : args
  if (method !== 'writeAgent' && method !== 'pasteAgent') return args
  const input = args[0]
  if (!input || typeof input !== 'object' || Array.isArray(input)) return args
  // The hosted value codec escapes an ordinary record with its reserved key. Strip the exact
  // optional entry before decoding, so even malformed marker data cannot reject healthy input.
  const encoded = encodedWire ? Object.getOwnPropertyDescriptors(input) : undefined
  if (encoded && encoded.$agentmuxValue?.value === 'record' && Array.isArray(encoded.entries?.value) && Reflect.ownKeys(input).length === 2) {
    const wire = input as { $agentmuxValue: 'record'; entries: unknown[] }
    const entries = wire.entries.filter(entry => !Array.isArray(entry) || entry[0] !== 'observation')
    const original = wire.entries.find(entry => Array.isArray(entry) && entry[0] === 'observation')
    const parent = Array.isArray(original) ? readInputObservation(original[1]) : null
    if (parent) entries.push(['observation', parent])
    return [{ ...wire, entries }, ...args.slice(1)]
  }
  if (!Object.hasOwn(input, 'observation')) return args
  const descriptors = encoded ?? Object.getOwnPropertyDescriptors(input), parent = readInputObservationField(input)
  delete descriptors.observation
  const value = Object.create(Object.getPrototypeOf(input), descriptors) as Record<string, unknown>
  if (parent) Object.defineProperty(value, 'observation', { value: parent, enumerable: true, writable: true, configurable: true })
  return [value, ...args.slice(1)]
}
export function sanitizeHostedInputInvocation(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const input = value as { method?: unknown; args?: unknown }
  if (typeof input.method !== 'string' || !Array.isArray(input.args)) return value
  return { ...input, args: inputObservationArguments(input.method, input.args, true) }
}
export type InputPerformanceHandle = ReturnType<ReturnType<typeof createInputPerformanceRecorder>['begin']>
const timing = (): PerformanceTiming => ({ count: 0, totalMs: 0, maxMs: 0 })
const phases = (): InputPerformancePhases => ({ queued: null, 'current-run': null, operation: null, 'native-input': null,
  received: null, 'connected-client': null, 'host-call': null, 'reply-ready': null })
function add(target: PerformanceTiming, ms: number): void {
  target.count++; target.totalMs += ms; target.maxMs = Math.max(target.maxMs, ms)
}
const copyEntry = (entry: InputPerformanceEntry): InputPerformanceEntry => ({ ...entry, phases: { ...entry.phases },
  parent: entry.parent && { ...entry.parent }, sender: entry.sender && { ...entry.sender, window: entry.sender.window && { ...entry.sender.window } } })
export function createInputPerformanceRecorder(now = () => performance.now(), wall = Date.now) {
  const startedAt = wall(), active = new Map<number, { entry: InputPerformanceEntry; start: number; stageStart: number }>()
  const kinds = { user: 0, mouse: 0, protocol: 0, paste: 0, semantic: 0, terminal: 0 }
  const queueWait = timing(), currentRun = timing(), operation = timing(), nativeInput = timing()
  const recent: InputPerformanceEntry[] = []
  let started = 0, completed = 0, failed = 0, pending = 0, omittedRecent = 0
  return {
    begin(input: Pick<InputPerformanceEntry, 'sessionId' | 'runId' | 'kind' | 'bytes'> &
      Partial<Pick<InputPerformanceEntry, 'hostId' | 'ownerInstanceId' | 'sender' | 'parent' | 'stage'>>) {
      const start = now(), entry: InputPerformanceEntry = { ...input, id: ++started, enqueuedAt: wall(),
        hostId: input.hostId ?? null, ownerInstanceId: input.ownerInstanceId ?? null,
        sender: input.sender ? { ...input.sender, window: input.sender.window && { ...input.sender.window } } : null,
        parent: readInputObservation(input.parent), parentMatch: 'absent', phases: phases(),
        stage: input.stage ?? 'queued', stageMs: 0, totalMs: 0, result: 'pending' }
      kinds[input.kind]++; pending++
      const observed = { entry, start, stageStart: start }
      if (active.size < 64) active.set(entry.id, observed)
      let settled = false
      return {
        executionOwner(ownerInstanceId: string, hostId?: string) { entry.ownerInstanceId = ownerInstanceId; if (hostId !== undefined) entry.hostId = hostId },
        stage(stage: InputPerformanceStage) { entry.stage = stage; observed.stageStart = now() },
        async measure<T>(stage: Exclude<InputPerformanceStage, 'queued'>, action: () => Promise<T>): Promise<T> {
          const previous = entry.stage, previousStart = observed.stageStart, at = now()
          entry.stage = stage; observed.stageStart = at
          let ok = false
          try { const value = await action(); ok = true; return value } finally {
            const elapsed = Math.max(0, now() - at)
            entry.phases[stage] = (entry.phases[stage] ?? 0) + elapsed
            const aggregate = stage === 'current-run' ? currentRun : stage === 'native-input' ? nativeInput : stage === 'operation' ? operation : null
            if (aggregate) add(aggregate, elapsed)
            // Failure retains its actual innermost stage; successful nesting restores the enclosing phase.
            if (ok) { entry.stage = previous; observed.stageStart = previousStart }
          }
        },
        dequeue() { const elapsed = entry.stage === 'queued' ? Math.max(0, now() - observed.stageStart) : 0; add(queueWait, elapsed); entry.phases.queued = elapsed; entry.stage = 'operation'; observed.stageStart = now() },
        settle(ok: boolean) {
          if (settled) return
          settled = true; pending--; if (ok) completed++; else failed++
          active.delete(entry.id)
          entry.result = ok ? 'completed' : 'failed'; entry.stageMs = Math.max(0, now() - observed.stageStart)
          entry.totalMs = Math.max(0, now() - start)
          if (recent.length === 32) { recent.shift(); omittedRecent++ }
          recent.push(copyEntry(entry))
        }
      }
    },
    snapshot(): InputPerformanceSnapshot {
      const at = now(), pendingEntries = [...active.values()].map(({ entry, start, stageStart }) => ({ ...copyEntry(entry),
        stageMs: Math.max(0, at - stageStart), totalMs: Math.max(0, at - start) }))
      const completedEntries = recent.map(copyEntry), retained = [...pendingEntries, ...completedEntries]
      const omittedActive = pending - active.size
      // This temporary <=96-entry index is only a snapshot calculation, never a registry or deduplicator.
      const counts = new Map<string, number>(), key = (parent: InputObservationReference) => JSON.stringify([parent.observerId, parent.source, parent.sequence])
      for (const entry of retained) if (entry.parent) counts.set(key(entry.parent), (counts.get(key(entry.parent)) ?? 0) + 1)
      for (const entry of retained) entry.parentMatch = !entry.parent ? 'absent' : counts.get(key(entry.parent))! > 1 ? 'ambiguous'
        : omittedActive > 0 || omittedRecent > 0 ? 'unknown-omitted' : 'unique'
      return { startedAt, started, completed, failed, pending, kinds: { ...kinds }, queueWait: { ...queueWait },
        currentRun: { ...currentRun }, operation: { ...operation }, nativeInput: { ...nativeInput },
        active: pendingEntries, omittedActive, recent: completedEntries, omittedRecent,
        oldestPendingMs: omittedActive > 0 || pending === 0 ? null : Math.max(...pendingEntries.map(entry => entry.totalMs)) }
    }
  }
}
export type HostedCarrierCost = {
  encoded: PerformanceTiming; decodedFrames: PerformanceTiming; decodedValues: PerformanceTiming
  encodedBytes: number; encodedFrames: number; decodedBytes: number; rejected: number
}
const carrier: HostedCarrierCost = { encoded: timing(), decodedFrames: timing(), decodedValues: timing(),
  encodedBytes: 0, encodedFrames: 0, decodedBytes: 0, rejected: 0 }
export const hostedCarrierPerformance = {
  encoded(ms: number, bytes: number, frames: number) { add(carrier.encoded, ms); carrier.encodedBytes += bytes; carrier.encodedFrames += frames },
  frame(ms: number, bytes: number) { add(carrier.decodedFrames, ms); carrier.decodedBytes += bytes },
  value(ms: number) { add(carrier.decodedValues, ms) },
  rejected() { carrier.rejected++ },
  snapshot(): HostedCarrierCost { return { ...carrier, encoded: { ...carrier.encoded }, decodedFrames: { ...carrier.decodedFrames }, decodedValues: { ...carrier.decodedValues } } }
}
export type ClientPerformanceDiagnostics = {
  processId: number; observedAt: number; input: InputPerformanceSnapshot; carrier: HostedCarrierCost
}
