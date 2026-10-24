import { readFile, stat } from 'node:fs/promises'
import { app } from 'electron'
import { durableWriteFile } from '@agentmux/core'
import { APP_MEMORY_EVIDENCE_INTERVAL_MS, APP_MEMORY_EVIDENCE_MAX_PROCESSES, APP_MEMORY_EVIDENCE_MAX_SEGMENTS,
  parseAppMemoryArchive, type AppMemoryArchive, type AppMemoryEvidence, type AppMemoryProcess, type AppMemorySegment } from '@agentmux/core/control'

const reason = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 512) || 'Observation failed'
const valid = (value: number) => Number.isSafeInteger(value) && value >= 0
const creation = (value: number) => Number.isFinite(value) && value > 0

/** Bounded Electron process working-set evidence; no Host or Run process scan. */
export class AppMemoryEvidenceOwner {
  private archive: AppMemoryArchive = { schema: 'agentmux.app-memory-evidence.v1', segments: [] }
  private loaded: Promise<void> | null = null
  private starting: Promise<void> | null = null
  private disposed = false
  private writable = true
  private timer: ReturnType<typeof setInterval> | null = null
  private writeTask: Promise<void> | null = null
  private pendingWrite = false
  private sampling: AppMemoryEvidence['sampling'] = { state: 'unavailable', reason: 'No application process sample has completed.' }
  private persistence: AppMemoryEvidence['persistence'] = { state: 'confirmed', reason: null, coalescedWrites: 0 }

  constructor(private readonly path: string, private readonly dependencies: {
    metrics?: () => Electron.ProcessMetric[]; now?: () => number
    read?: (path: string, encoding: 'utf8') => Promise<string>; write?: typeof durableWriteFile
  } = {}) {}

  private async load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      try {
        if ((await stat(this.path)).size > 65_536) throw new Error('Existing memory evidence exceeds its archive bound.')
        const content = await (this.dependencies.read ?? readFile)(this.path, 'utf8')
        this.archive = parseAppMemoryArchive(JSON.parse(content))
        this.persistence = { ...this.persistence, state: 'unconfirmed', reason: 'Prior write acknowledgement is unavailable after restart.' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        // Preserve an unreadable original. A new empty archive must not overwrite it.
        this.writable = false
        this.persistence = { ...this.persistence, state: 'unconfirmed', reason: 'Existing memory evidence is unreadable: ' + reason(error).slice(0, 450) }
      }
    })()
    await this.loaded
  }

  async start(): Promise<void> {
    if (this.disposed || this.timer) return
    this.starting ??= (async () => {
      await this.sampleOnce()
      if (this.disposed) return
      this.timer = setInterval(() => { void this.sampleOnce() }, APP_MEMORY_EVIDENCE_INTERVAL_MS)
      this.timer.unref?.()
    })().finally(() => { this.starting = null })
    await this.starting
  }

  async sampleOnce(): Promise<void> {
    if (this.disposed) return
    try {
      await this.load()
      if (this.disposed) return
      const observedAt = (this.dependencies.now ?? Date.now)()
      if (!valid(observedAt)) throw new Error('Observation clock is unavailable.')
      const metrics = (this.dependencies.metrics ?? (() => app.getAppMetrics()))()
      if (new Set(metrics.map(metric => metric.pid)).size !== metrics.length) throw new Error('Application process identities are duplicated.')
      const processes: AppMemoryProcess[] = metrics.map(metric => ({ pid: metric.pid, creationTime: metric.creationTime,
        type: metric.type, rssKib: metric.memory.workingSetSize }))
      if (!processes.length || processes.some(item => !valid(item.pid) || item.pid === 0 || !creation(item.creationTime) ||
        !valid(item.rssKib) || !item.type || item.type.length > 64)) {
        throw new Error('Application process identity or working set is unavailable.')
      }
      const main = processes.find(item => item.pid === process.pid)
      if (!main) throw new Error('Main process identity is unavailable.')
      const previous = this.archive.segments.at(-1)
      const same = previous?.main.pid === main.pid && previous.main.creationTime === main.creationTime
      if (previous && observedAt < previous.lastObservedAt) throw new Error('Observation clock moved before retained evidence.')
      const ordered = [...processes].sort((a, b) => b.rssKib - a.rssKib || a.pid - b.pid)
      const rssKib = processes.reduce((sum, item) => sum + item.rssKib, 0)
      if (!valid(rssKib)) throw new Error('Application working-set total is unavailable.')
      const peak = { observedAt, rssKib, processCount: processes.length,
        processes: ordered.slice(0, APP_MEMORY_EVIDENCE_MAX_PROCESSES),
        omittedProcesses: Math.max(0, processes.length - APP_MEMORY_EVIDENCE_MAX_PROCESSES) }
      const largestProcess = { ...ordered[0]!, observedAt }
      const segment: AppMemorySegment = same ? { ...previous!, lastObservedAt: observedAt,
        sampleCount: previous!.sampleCount + 1,
        peak: rssKib > previous!.peak.rssKib ? peak : previous!.peak,
        largestProcess: largestProcess.rssKib > previous!.largestProcess.rssKib ? largestProcess : previous!.largestProcess }
        : { main: { pid: main.pid, creationTime: main.creationTime }, firstObservedAt: observedAt,
          lastObservedAt: observedAt, sampleCount: 1, peak, largestProcess }
      const retained = same ? [...this.archive.segments.slice(0, -1), segment] : [...this.archive.segments, segment]
      this.archive = { ...this.archive, segments: retained.slice(-APP_MEMORY_EVIDENCE_MAX_SEGMENTS) }
      this.sampling = { state: 'available', reason: null }
      this.scheduleWrite()
    } catch (error) { this.sampling = { state: 'unavailable', reason: reason(error) } }
  }

  private scheduleWrite(): void {
    if (!this.writable) return
    if (this.writeTask) {
      if (this.pendingWrite) this.persistence.coalescedWrites++
      this.pendingWrite = true
      this.persistence.state = 'pending'; this.persistence.reason = null
      return
    }
    this.persistence.state = 'pending'; this.persistence.reason = null
    this.writeTask = (async () => {
      do {
        this.pendingWrite = false
        try {
          await (this.dependencies.write ?? durableWriteFile)(this.path, JSON.stringify(this.archive) + '\n',
            { mode: 0o600, requireDirectorySync: true })
          this.persistence.state = this.pendingWrite ? 'pending' : 'confirmed'
          this.persistence.reason = null
        } catch (error) {
          this.persistence.state = 'unconfirmed'; this.persistence.reason = reason(error)
        }
      } while (this.pendingWrite)
    })().finally(() => {
      this.writeTask = null
      if (this.pendingWrite) this.scheduleWrite()
    })
  }

  async inspect(): Promise<AppMemoryEvidence> {
    await this.load()
    return structuredClone({ ...this.archive, intervalMs: APP_MEMORY_EVIDENCE_INTERVAL_MS,
      sampling: this.sampling, persistence: this.persistence })
  }

  async settle(): Promise<void> { await this.writeTask }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.timer = null }
}
