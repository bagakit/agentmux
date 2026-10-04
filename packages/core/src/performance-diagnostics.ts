/** Read-only, process-local costs. No input data, replay authority or capability gates. */
export type PerformanceTiming = { count: number; totalMs: number; maxMs: number }
export type InputPerformanceKind = 'user' | 'mouse' | 'protocol' | 'paste' | 'semantic' | 'terminal'
export type InputPerformanceStage = 'queued' | 'current-run' | 'operation' | 'native-input'
export type InputPerformanceEntry = {
  id: number; sessionId: string | null; runId: string; kind: InputPerformanceKind; bytes: number | null
  enqueuedAt: number; stage: InputPerformanceStage; stageMs: number; totalMs: number
  result: 'pending' | 'completed' | 'failed'
}
export type InputPerformanceSnapshot = {
  startedAt: number; started: number; completed: number; failed: number; pending: number
  kinds: Record<InputPerformanceKind, number>
  /** operation is enclosing wall time and includes nativeInput; the two are not additive. */
  queueWait: PerformanceTiming; currentRun: PerformanceTiming; operation: PerformanceTiming; nativeInput: PerformanceTiming
  active: InputPerformanceEntry[]; omittedActive: number; recent: InputPerformanceEntry[]; omittedRecent: number
}
export type InputPerformanceHandle = ReturnType<ReturnType<typeof createInputPerformanceRecorder>['begin']>
const timing = (): PerformanceTiming => ({ count: 0, totalMs: 0, maxMs: 0 })
function add(target: PerformanceTiming, ms: number): void {
  target.count++; target.totalMs += ms; target.maxMs = Math.max(target.maxMs, ms)
}
export function createInputPerformanceRecorder(now = () => performance.now(), wall = Date.now) {
  const startedAt = wall(), active = new Map<number, { entry: InputPerformanceEntry; start: number; stageStart: number }>()
  const kinds = { user: 0, mouse: 0, protocol: 0, paste: 0, semantic: 0, terminal: 0 }
  const queueWait = timing(), currentRun = timing(), operation = timing(), nativeInput = timing()
  const recent: InputPerformanceEntry[] = []
  let started = 0, completed = 0, failed = 0, pending = 0, omittedRecent = 0
  return {
    begin(input: Pick<InputPerformanceEntry, 'sessionId' | 'runId' | 'kind' | 'bytes'>) {
      const start = now(), entry: InputPerformanceEntry = { ...input, id: ++started, enqueuedAt: wall(),
        stage: 'queued', stageMs: 0, totalMs: 0, result: 'pending' }
      kinds[input.kind]++; pending++
      const observed = { entry, start, stageStart: start }
      if (active.size < 64) active.set(entry.id, observed)
      let settled = false
      return {
        stage(stage: InputPerformanceStage) {
          entry.stage = stage; observed.stageStart = now()
        },
        async measure<T>(stage: Exclude<InputPerformanceStage, 'queued'>, action: () => Promise<T>): Promise<T> {
          const previous = entry.stage, previousStart = observed.stageStart, at = now()
          entry.stage = stage; observed.stageStart = at
          let ok = false
          try { const value = await action(); ok = true; return value } finally {
            add(stage === 'current-run' ? currentRun : stage === 'native-input' ? nativeInput : operation, Math.max(0, now() - at))
            // A failure retains its actual innermost stage; a completed nested read restores the enclosing phase.
            if (ok) { entry.stage = previous; observed.stageStart = previousStart }
          }
        },
        dequeue() { add(queueWait, Math.max(0, now() - start)); entry.stage = 'operation'; observed.stageStart = now() },
        settle(ok: boolean) {
          if (settled) return
          settled = true; pending--; if (ok) completed++; else failed++
          active.delete(entry.id)
          entry.result = ok ? 'completed' : 'failed'; entry.stageMs = Math.max(0, now() - observed.stageStart)
          entry.totalMs = Math.max(0, now() - start)
          if (recent.length === 32) { recent.shift(); omittedRecent++ }
          recent.push({ ...entry })
        }
      }
    },
    snapshot(): InputPerformanceSnapshot {
      const at = now()
      return { startedAt, started, completed, failed, pending, kinds: { ...kinds }, queueWait: { ...queueWait },
        currentRun: { ...currentRun }, operation: { ...operation }, nativeInput: { ...nativeInput },
        active: [...active.values()].map(({ entry, start, stageStart }) => ({ ...entry, stageMs: Math.max(0, at - stageStart), totalMs: Math.max(0, at - start) })),
        omittedActive: pending - active.size, recent: recent.map(entry => ({ ...entry })), omittedRecent }
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
