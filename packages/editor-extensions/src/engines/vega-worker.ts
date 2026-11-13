import type { Loader } from 'vega'
import type { VegaMode } from './vega-spec'
import type { ChartEvent, ChartRequest, ChartSnapshot } from './vega-chart-protocol'

/** A visible chart owns one terminatable worker, including all dataflow and interaction work. */
export function createVegaPreview(content: string, mode: VegaMode, loader: Loader, signal: AbortSignal, callbacks: { snapshot(value: ChartSnapshot): void; error(error: Error): void; phase?(phase: string): void }) {
  const worker = new Worker(new URL('./vega-chart.worker.ts', import.meta.url), { type: 'module' })
  let disposed = false, busy = false, serial = 0
  const queue: ChartRequest[] = []
  const send = (request: ChartRequest) => { if (!disposed) worker.postMessage(request) }
  const enqueue = (request: ChartRequest) => {
    if (disposed) return
    if (busy) {
      // Replace only consecutive continuous input. Discrete events are ordering barriers;
      // wheel deltas must all be retained rather than replaced by their last sample.
      const continuous = request.action === 'resize' || request.action === 'signal' || request.action === 'event' && /move$|resize$/.test(request.event.type)
      const previous = queue.at(-1)
      const replace = continuous && previous?.action === request.action && (request.action !== 'signal' || previous.action === 'signal' && previous.name === request.name) && (request.action !== 'event' || previous.action === 'event' && previous.event.type === request.event.type && previous.event.source === request.event.source)
      if (replace) queue[queue.length - 1] = request
      else queue.push(request)
    } else { busy = true; send({ ...request, serial: ++serial }) }
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    try { worker.postMessage({ action: 'dispose' }) } finally { worker.terminate() }
    worker.onmessage = null; worker.onerror = null
    signal.removeEventListener('abort', dispose)
  }
  const error = (value: unknown) => {
    if (disposed) return
    callbacks.error(value instanceof Error ? value : new Error(String(value)))
    dispose()
  }
  worker.onmessage = event => {
    if (disposed) return
    if (event.data.handled !== undefined) { busy = false; const next = queue.shift(); if (next) enqueue(next) }
    if (event.data.error) { error(event.data.error); return }
    if (event.data.phase) callbacks.phase?.(event.data.phase)
    if (event.data.snapshot) callbacks.snapshot(event.data.snapshot as ChartSnapshot)
    const request = event.data.resource
    if (request) {
      const method = request.method as 'load' | 'sanitize'
      if (!['load', 'sanitize'].includes(method)) { error('Unknown chart resource operation.'); return }
      void (loader[method] as (...args: any[]) => Promise<unknown>)(...request.args).then(
        value => send({ action: 'resource', id: request.id, value }),
        value => { send({ action: 'resource', id: request.id, error: String(value) }); error(value) }
      )
    }
  }
  worker.onerror = event => error(new Error(event.message || 'Chart worker failed. Retry preview.'))
  signal.addEventListener('abort', dispose, { once: true })
  if (signal.aborted) dispose()
  else enqueue({ action: 'start', content, mode })
  return { dispose, event: (event: ChartEvent) => enqueue({ action: 'event', event }), setSignal: (name: string, value: unknown) => enqueue({ action: 'signal', name, value }), resize: (width: number, height?: number) => enqueue({ action: 'resize', width, ...(height === undefined ? {} : { height }) }) }
}
