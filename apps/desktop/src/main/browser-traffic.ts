import { mintObjectId } from '@agentmux/core/object-id'
import type { openBrowserHarCapture } from '@agentmux/browser/browser-har-capture'
import type { BrowserTrafficReceipt, BrowserTrafficTarget } from '../shared/browser-traffic.js'

type Recorder = Awaited<ReturnType<typeof openBrowserHarCapture>>
type NativeLog = Awaited<ReturnType<Recorder['finish']>>['log']
type Source = {
  target: BrowserTrafficTarget
  native?: Recorder
  stopped?: NativeLog
  error?: string
}
type Capture = {
  id: string
  startedAt: number
  endedAt: number | null
  sources: Source[]
  controller: AbortController
  closing?: Promise<unknown>
  ready: boolean
}

/** Desktop capture with exact native sources and one retained export. */
export class BrowserTraffic {
  private capture?: Capture

  constructor(private readonly ports: {
    targets(): BrowserTrafficTarget[]
    attach(browserId: string, signal: AbortSignal): Promise<Recorder>
  }) {}

  targets(): BrowserTrafficTarget[] { return this.ports.targets() }

  start(browserIds: unknown): BrowserTrafficReceipt {
    if (this.capture?.endedAt === null) throw new Error('Stop the original traffic capture before starting another.')
    if (!Array.isArray(browserIds) || !browserIds.length || browserIds.length > 8 ||
        browserIds.some(id => typeof id !== 'string') || new Set(browserIds).size !== browserIds.length)
      throw new Error('Select between one and eight exact Browser pages.')
    const available = new Map(this.targets().map(target => [target.id, target]))
    const sources = browserIds.map<Source>(id => {
      const target = available.get(id)
      if (!target) throw new Error('A selected Browser is no longer available for traffic capture.')
      return { target }
    })
    const controller = new AbortController()
    const capture: Capture = { id: mintObjectId(), startedAt: Date.now(), endedAt: null, controller, sources, ready: false }
    this.capture = capture
    void Promise.all(sources.map(async source => {
      try {
        const original = await this.ports.attach(source.target.id, controller.signal)
        if (controller.signal.aborted) await original.finish()
        else source.native = original
      } catch (error) {
        if (!controller.signal.aborted) source.error = error instanceof Error ? error.message : String(error)
      }
    })).then(() => {
      capture.ready = true
      if (capture.endedAt === null && !capture.closing && sources.every(source => !source.native)) capture.endedAt = Date.now()
    })
    return this.project(capture)
  }

  inspect(): BrowserTrafficReceipt | null { return this.capture ? this.project(this.capture) : null }

  async stop(captureId: string): Promise<BrowserTrafficReceipt> {
    const capture = this.require(captureId)
    if (capture.endedAt !== null) return this.project(capture)
    capture.closing ??= (async () => {
      capture.controller.abort()
      await Promise.all(capture.sources.map(async source => {
        if (source.native) source.stopped = (await source.native.finish()).log
      }))
      capture.endedAt = Date.now()
    })()
    await capture.closing
    return this.project(capture)
  }

  har(captureId: string) {
    const capture = this.require(captureId)
    if (capture.endedAt === null) throw new Error('Stop the original traffic capture before exporting it.')
    const sources = capture.sources.map(source => ({ browserId: source.target.id,
      coverage: source.stopped?._capture, ...(source.error ? { issue: source.error } : {}) }))
    const entries = capture.sources.flatMap(source => (source.stopped?.entries ?? []).map(entry => ({ ...entry,
      _browserId: source.target.id }))).sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime))
    return { log: { version: '1.2', creator: { name: 'AgentMux', version: '1' }, entries,
      _capture: { captureId, sources, startedAt: capture.startedAt, endedAt: capture.endedAt, content: 'metadata-only' } } }
  }

  shutdown(): void {
    if (this.capture && this.capture.endedAt === null) void this.stop(this.capture.id)
  }

  private require(id: string): Capture {
    if (this.capture?.id !== id) throw new Error('The original traffic capture is unavailable. No different capture was selected.')
    return this.capture
  }

  private project(capture: Capture): BrowserTrafficReceipt {
    const preview = 80
    let retained = 0, dropped = 0, unmatched = 0, pending = 0
    const sources: BrowserTrafficReceipt['sources'] = []
    const rows = capture.sources.flatMap(source => {
      const log = source.stopped ?? source.native?.snapshot(preview).log
      const detail = source.error ?? log?._capture.gap ?? (capture.endedAt !== null && !log ? 'Recording ended before the original native source was confirmed.' : undefined)
      sources.push({ ...source.target, status: detail ? 'unavailable' : capture.endedAt !== null ? 'finished' : source.native ? 'recording' : 'starting',
        ...(detail ? { detail } : {}) })
      if (!log) return []
      retained += log._capture.retained
      dropped += log._capture.dropped
      unmatched += log._capture.unmatched
      pending += log._capture.pending
      const entries = log.entries.slice(-preview)
      return entries.map((entry, index) => ({
        key: JSON.stringify([source.target.id, log._capture.retained - entries.length + index]),
        browserId: source.target.id, startedAt: entry.startedDateTime, method: entry.request.method,
        url: entry.request.url, status: entry.response.status, duration: entry.time, state: entry._state,
        mimeType: entry.response.content.mimeType, redirectURL: entry.response.redirectURL
      }))
    }).sort((left, right) => left.startedAt.localeCompare(right.startedAt)).slice(-preview)
    return { captureId: capture.id, status: capture.endedAt !== null ? 'finished' : capture.closing ? 'stopping' : capture.ready ? 'recording' : 'starting',
      startedAt: capture.startedAt, endedAt: capture.endedAt, rows, retained, dropped, unmatched, pending, sources }
  }
}
