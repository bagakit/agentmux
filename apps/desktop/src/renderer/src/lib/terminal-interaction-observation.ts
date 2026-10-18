import type { RendererTerminalCost, RendererWorkSource, RendererWorkTiming } from '@agentmux/core/control'

type Interaction = RendererTerminalCost['interaction']
type Context = Omit<NonNullable<Interaction['lastEvent']>, 'kind' | 'observedAt' | 'delayMs'>
const timing = (): RendererWorkTiming => ({ count: 0, totalMs: 0, maxMs: 0 })
function add(timing: RendererWorkTiming, duration: number) {
  timing.count++; timing.totalMs += duration; timing.maxMs = Math.max(timing.maxMs, duration)
}

/** Passive observations only: no input values, DOM reads, timers or capability decisions. */
export function createTerminalInteractionObservation({ host, readContext, readSource, slow,
  now = () => performance.now(), wall = Date.now
}: {
  host: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>
  readContext: () => Context
  readSource: () => RendererWorkSource
  slow: (detail: 'keydown-dispatch' | 'wheel-dispatch' | 'write-request', duration: number, occurrenceMonoMs: number, source: RendererWorkSource) => void
  now?: () => number; wall?: () => number
}) {
  // Pending input replies outlive a retired view. Keep its callbacks and DOM owner
  // behind one removable reference rather than retaining them in every Promise reaction.
  let owner: { host: typeof host; readContext: typeof readContext; readSource: typeof readSource; slow: typeof slow;
    now: typeof now; wall: typeof wall } | null = { host, readContext, readSource, slow, now, wall }
  const state: Interaction = {
    observedSinceAt: wall(),
    keydown: { count: 0, unknownDelayCount: 0, delay: timing() },
    wheel: { count: 0, unknownDelayCount: 0, delay: timing() },
    writeRequests: { started: 0, completed: 0, failed: 0, pending: 0, wall: timing(), lastStartedAt: null, lastSettledAt: null },
    lastEvent: null
  }
  const event = (event: Event) => {
    const current = owner
    if (!current || !event.isTrusted || (event.type !== 'keydown' && event.type !== 'wheel')) return
    const kind = event.type, at = current.now(), stamp = event.timeStamp, item = state[kind]
    // Same-document trusted event timestamps use this Renderer monotonic origin.
    // Epoch, future and invalid timestamps remain unknown, never a zero-latency sample.
    const delayMs = Number.isFinite(at) && Number.isFinite(stamp) && stamp > 0 && stamp <= at ? at - stamp : null
    item.count++
    if (delayMs === null) item.unknownDelayCount++
    else { add(item.delay, delayMs); current.slow(`${kind}-dispatch`, delayMs, stamp, { ...current.readSource() }) }
    state.lastEvent = { ...current.readContext(), kind, observedAt: current.wall(), delayMs }
  }
  const options = { capture: true, passive: true }
  host.addEventListener('keydown', event, options)
  host.addEventListener('wheel', event, options)
  return {
    observeWriteRequest(request: Promise<unknown>, startedAt: number) {
      if (!owner) return
      const source = { ...owner.readSource() }
      const requests = state.writeRequests
      requests.started++; requests.pending++; requests.lastStartedAt = owner.wall()
      let settled = false
      const settle = (failed: boolean) => {
        const current = owner
        if (!current || settled) return
        settled = true
        requests.pending--; requests[failed ? 'failed' : 'completed']++; requests.lastSettledAt = current.wall()
        const elapsed = Math.max(0, current.now() - startedAt)
        add(requests.wall, elapsed); current.slow('write-request', elapsed, startedAt, source)
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
      const current = owner
      if (!current) return
      owner = null
      current.host.removeEventListener('keydown', event, options)
      current.host.removeEventListener('wheel', event, options)
    }
  }
}
