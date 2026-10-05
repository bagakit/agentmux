import type { RendererTerminalCost, RendererWorkTiming } from '@agentmux/core/control'

type Interaction = RendererTerminalCost['interaction']
type Context = Omit<NonNullable<Interaction['lastEvent']>, 'kind' | 'observedAt' | 'delayMs'>
const timing = (): RendererWorkTiming => ({ count: 0, totalMs: 0, maxMs: 0 })
function add(timing: RendererWorkTiming, duration: number) {
  timing.count++; timing.totalMs += duration; timing.maxMs = Math.max(timing.maxMs, duration)
}

/** Passive observations only: no input values, DOM reads, timers or capability decisions. */
export function createTerminalInteractionObservation({ host, readContext, slow,
  now = () => performance.now(), wall = Date.now
}: {
  host: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>
  readContext: () => Context
  slow: (detail: 'keydown-dispatch' | 'wheel-dispatch' | 'write-request', duration: number, occurrenceMonoMs: number) => void
  now?: () => number; wall?: () => number
}) {
  let disposed = false
  const state: Interaction = {
    observedSinceAt: wall(),
    keydown: { count: 0, unknownDelayCount: 0, delay: timing() },
    wheel: { count: 0, unknownDelayCount: 0, delay: timing() },
    writeRequests: { started: 0, completed: 0, failed: 0, pending: 0, wall: timing(), lastStartedAt: null, lastSettledAt: null },
    lastEvent: null
  }
  const event = (event: Event) => {
    if (disposed || !event.isTrusted || (event.type !== 'keydown' && event.type !== 'wheel')) return
    const kind = event.type, at = now(), stamp = event.timeStamp, item = state[kind]
    // Same-document trusted event timestamps use this Renderer monotonic origin.
    // Epoch, future and invalid timestamps remain unknown, never a zero-latency sample.
    const delayMs = Number.isFinite(at) && Number.isFinite(stamp) && stamp > 0 && stamp <= at ? at - stamp : null
    item.count++
    if (delayMs === null) item.unknownDelayCount++
    else { add(item.delay, delayMs); slow(`${kind}-dispatch`, delayMs, stamp) }
    state.lastEvent = { ...readContext(), kind, observedAt: wall(), delayMs }
  }
  const options = { capture: true, passive: true }
  host.addEventListener('keydown', event, options)
  host.addEventListener('wheel', event, options)
  return {
    observeWriteRequest(request: Promise<unknown>, startedAt: number) {
      if (disposed) return
      const requests = state.writeRequests
      requests.started++; requests.pending++; requests.lastStartedAt = wall()
      let settled = false
      const settle = (failed: boolean) => {
        if (disposed || settled) return
        settled = true
        requests.pending--; requests[failed ? 'failed' : 'completed']++; requests.lastSettledAt = wall()
        const elapsed = Math.max(0, now() - startedAt)
        add(requests.wall, elapsed); slow('write-request', elapsed, startedAt)
      }
      // Observe both outcomes without replacing the original Promise or its error handler.
      void request.then(() => settle(false), () => settle(true))
    },
    snapshot(): Interaction {
      return { observedSinceAt: state.observedSinceAt,
        keydown: { ...state.keydown, delay: { ...state.keydown.delay } }, wheel: { ...state.wheel, delay: { ...state.wheel.delay } },
        writeRequests: { ...state.writeRequests, wall: { ...state.writeRequests.wall } }, lastEvent: state.lastEvent && { ...state.lastEvent } }
    },
    dispose() {
      if (disposed) return
      disposed = true
      host.removeEventListener('keydown', event, options)
      host.removeEventListener('wheel', event, options)
    }
  }
}
