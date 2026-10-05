import { createInputPerformanceRecorder, readInputObservation } from '@agentmux/core/control'
import type { RendererConsumerCost, RendererOverlayObservation, RendererPerformanceSnapshot, RendererTerminalCost, RendererWorkTiming } from '@agentmux/core/control'
import { tabSwitchObservation } from './tab-switch-observation'

const timing = (): RendererWorkTiming => ({ count: 0, totalMs: 0, maxMs: 0 })
const consumer = (): RendererConsumerCost => ({ checks: 0, changes: 0, commits: 0 })
function add(target: RendererWorkTiming, duration: number) {
  const ms = Math.max(0, duration)
  target.count++; target.totalMs += ms; target.maxMs = Math.max(target.maxMs, ms)
}
const timingKinds = ['session-event', 'terminal-write', 'long-task', 'input-delay', 'terminal-interaction'] as const
type TimingKind = typeof timingKinds[number]
const kindCounts = (): Record<TimingKind, number> => ({ 'session-event': 0, 'terminal-write': 0, 'long-task': 0, 'input-delay': 0, 'terminal-interaction': 0 })
const epoch = (startMonoMs: number): RendererPerformanceSnapshot['timingEpochs']['current'] => ({
  startMonoMs, endMonoMs: startMonoMs + 10_000,
  timings: { 'session-event': timing(), 'terminal-write': timing(), 'long-task': timing(), 'input-delay': timing(), 'terminal-interaction': timing() }
})
const copyEpoch = (value: ReturnType<typeof epoch>): ReturnType<typeof epoch> => ({
  ...value, timings: Object.fromEntries(timingKinds.map(kind => [kind, { ...value.timings[kind] }])) as ReturnType<typeof epoch>['timings']
})
/** No clock, subscription, payload or historical buffer scan on a selector check. */
export function createRendererPerformance(now = () => performance.now(), wall = Date.now, nonce: () => string = () => globalThis.crypto.randomUUID()) {
  const startedAt = wall()
  const observerId = (() => { try { return readInputObservation({ observerId: nonce(), source: 'user', sequence: 1 })?.observerId ?? null } catch { return null } })()
  const inputDetails = createInputPerformanceRecorder(now, wall)
  const recordingSinceMonoMs = now()
  let currentEpoch = epoch(Math.floor(recordingSinceMonoMs / 10_000) * 10_000)
  let previousEpoch: ReturnType<typeof epoch> | null = null
  const late = kindCounts(), unknown = kindCounts(), slowEventsOmitted = kindCounts()
  const slowByKind: Record<TimingKind, RendererPerformanceSnapshot['slowEvents']> = {
    'session-event': [], 'terminal-write': [], 'long-task': [], 'input-delay': [], 'terminal-interaction': []
  }
  let eventSerial = 0
  const consumers = { composer: { visible: consumer(), hidden: consumer() }, sessionPane: { visible: consumer(), hidden: consumer() } }
  const overlay: RendererPerformanceSnapshot['overlay'] = {
    triggers: { initial: 0, demand: 0, mutation: 0, resize: 0, scroll: 0, toggle: 0, font: 0, collect: 0 },
    scheduled: 0, coalesced: 0, candidates: 0, geometryReads: 0, nativeDemandCount: null,
    latestCandidates: null, latestGeometryReads: null, collect: timing()
  }
  const requestCost = () => ({ started: 0, completed: 0, failed: 0, pending: 0, wall: timing() })
  const inputRequests = { user: requestCost(), protocol: requestCost(), paste: requestCost() }
  const sessionEvents = timing()
  const terminalWrites = { visible: timing(), hidden: timing(), stringCodeUnits: 0, bytes: 0 }
  const longTasks: RendererPerformanceSnapshot['longTasks'] = { state: 'stopped', reason: null, timing: timing() }
  const inputDelay: RendererPerformanceSnapshot['inputDelay'] = { state: 'stopped', reason: null, durationThresholdMs: 16, timing: timing() }
  const observerCost = { snapshots: timing(), performanceCallbacks: timing() }
  const terminals = new Set<() => RendererTerminalCost>()
  let observer: PerformanceObserver | undefined, inputObserver: PerformanceObserver | undefined, observerOwners = 0, observerGeneration = 0
  // Fixed epochs, not a rolling window: current is partial; the first previous epoch may also have partial coverage.
  function rotate(deliveredAtMonoMs: number): void {
    const startMonoMs = Math.floor(deliveredAtMonoMs / 10_000) * 10_000
    if (startMonoMs <= currentEpoch.startMonoMs) return
    previousEpoch = startMonoMs === currentEpoch.endMonoMs ? currentEpoch : epoch(startMonoMs - 10_000)
    currentEpoch = epoch(startMonoMs)
  }
  function record(kind: TimingKind, detail: string, durationMs: number, occurrence: number | null, deliveredAtMonoMs: number): void {
    rotate(deliveredAtMonoMs)
    const occurredAtMonoMs = occurrence !== null && Number.isFinite(occurrence) && occurrence >= recordingSinceMonoMs && occurrence <= deliveredAtMonoMs ? occurrence : null
    if (occurredAtMonoMs === null) unknown[kind]++
    else if (occurredAtMonoMs >= currentEpoch.startMonoMs) add(currentEpoch.timings[kind], durationMs)
    else if (previousEpoch && occurredAtMonoMs >= previousEpoch.startMonoMs) add(previousEpoch.timings[kind], durationMs)
    else late[kind]++
    if (durationMs < 50) return
    const records = slowByKind[kind]
    if (records.length === 6) { records.shift(); slowEventsOmitted[kind]++ }
    records.push({ id: ++eventSerial, kind, detail, observedAt: wall(), durationMs, occurredAtMonoMs, deliveredAtMonoMs })
  }
  return {
    check(kind: keyof typeof consumers, visible: boolean, changed: boolean) {
      const cost = consumers[kind][visible ? 'visible' : 'hidden']
      cost.checks++; if (changed) cost.changes++
    },
    commit(kind: keyof typeof consumers, visible: boolean) { consumers[kind][visible ? 'visible' : 'hidden'].commits++ },
    start: now,
    beginInputRequest(kind: keyof typeof inputRequests, start: number, target: { hostId: string; sessionId: string | null; runId: string }) {
      const cost = inputRequests[kind]
      cost.started++; cost.pending++
      const parent = observerId ? readInputObservation({ observerId, source: kind, sequence: cost.started }) : null
      const diagnostic = inputDetails.begin({ ...target, kind, bytes: null, parent, stage: 'received' })
      let observing = false, settled = false
      const settle = (ok: boolean) => {
        if (settled) return
        settled = true
        cost.pending--; if (ok) cost.completed++; else cost.failed++
        add(cost.wall, now() - start); diagnostic.settle(ok)
      }
      return { parent: parent ?? undefined, fail: () => settle(false), observe(request: Promise<unknown>) {
        if (observing) return
        observing = true
        void request.then(() => settle(true), () => settle(false))
      } }
    },
    observeOverlay(observation: RendererOverlayObservation) {
      overlay.triggers[observation.reason]++
      if (observation.scheduled) overlay.scheduled++
      if (observation.coalesced) overlay.coalesced++
      overlay.nativeDemandCount = observation.nativeDemandCount
      if (observation.candidateCount !== undefined) {
        overlay.candidates += observation.candidateCount; overlay.latestCandidates = observation.candidateCount
      }
      if (observation.geometryReadCount !== undefined) {
        overlay.geometryReads += observation.geometryReadCount; overlay.latestGeometryReads = observation.geometryReadCount
      }
      if (observation.collectMs !== undefined) add(overlay.collect, observation.collectMs)
    },
    terminalInteraction(detail: 'keydown-dispatch' | 'wheel-dispatch' | 'write-request', duration: number, occurrenceMonoMs: number) {
      const delivered = now()
      record('terminal-interaction', detail, duration, occurrenceMonoMs, delivered)
    },
    // Event type is not a public free-text channel. No prompt/body supplied by a caller is retained.
    sessionEvent(_kind: string, start: number) {
      const delivered = now(), elapsed = Math.max(0, delivered - start)
      add(sessionEvents, elapsed); record('session-event', 'session-event', elapsed, start, delivered)
    },
    terminalWrite(visible: boolean, data: string | Uint8Array, start: number) {
      const delivered = now(), elapsed = Math.max(0, delivered - start)
      add(terminalWrites[visible ? 'visible' : 'hidden'], elapsed)
      if (typeof data === 'string') terminalWrites.stringCodeUnits += data.length
      else terminalWrites.bytes += data.byteLength
      record('terminal-write', visible ? 'visible' : 'hidden', elapsed, start, delivered)
    },
    registerTerminal(read: () => RendererTerminalCost) {
      terminals.add(read)
      return () => { terminals.delete(read) }
    },
    observeMainThread(Observer = globalThis.PerformanceObserver) {
      observerOwners++
      if (observerOwners === 1) {
        const generation = ++observerGeneration
        if (!Observer?.supportedEntryTypes?.includes('longtask')) {
          longTasks.state = 'unsupported'; longTasks.reason = 'Longtask entries are not supported in this Renderer.'
        }
        else {
          try {
            observer = new Observer(list => {
            if (observerOwners === 0 || generation !== observerGeneration) return
            const start = now()
            for (const entry of list.getEntries()) {
              add(longTasks.timing, entry.duration); record('long-task', 'renderer-main-thread', entry.duration, entry.startTime, start)
            }
            add(observerCost.performanceCallbacks, now() - start)
          })
            observer.observe({ type: 'longtask' }); longTasks.state = 'observing'; longTasks.reason = null
          } catch (error) {
            observer?.disconnect(); observer = undefined; longTasks.state = 'unavailable'
            longTasks.reason = String(error).slice(0, 4096)
          }
        }
        if (!Observer?.supportedEntryTypes?.includes('event')) {
          inputDelay.state = 'unsupported'; inputDelay.reason = 'Event Timing entries are not supported in this Renderer.'
        } else {
          try {
            inputObserver = new Observer(list => {
              if (observerOwners === 0 || generation !== observerGeneration) return
              const start = now()
              for (const entry of list.getEntries()) {
                const event = entry as PerformanceEventTiming
                // Only Event Timing latency; never event names, target, keys or input text.
                const delay = event.processingStart - event.startTime
                if (!Number.isFinite(delay) || delay < 0) continue
                add(inputDelay.timing, delay); record('input-delay', 'event-timing', delay, event.startTime, start)
              }
              add(observerCost.performanceCallbacks, now() - start)
            })
            inputObserver.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit)
            inputDelay.state = 'observing'; inputDelay.reason = null
          } catch (error) {
            inputObserver?.disconnect(); inputObserver = undefined; inputDelay.state = 'unavailable'
            inputDelay.reason = String(error).slice(0, 4096)
          }
        }
      }
      let released = false
      return () => {
        if (released) return
        released = true
        if (--observerOwners === 0) {
          observerGeneration++
          observer?.disconnect(); observer = undefined
          inputObserver?.disconnect(); inputObserver = undefined
          if (inputDelay.state === 'observing') inputDelay.state = 'stopped'
          if (longTasks.state === 'observing') longTasks.state = 'stopped'
        }
      }
    },
    snapshot(): RendererPerformanceSnapshot {
      const start = now(), current: RendererTerminalCost[] = []
      rotate(start)
      let attempted = 0, unavailableTerminals = 0
      for (const read of terminals) {
        if (attempted === 64) break
        attempted++
        try { current.push(read()) } catch { unavailableTerminals++ }
      }
      // All returned objects are detached facts; consumers cannot mutate the recorder.
      const value: RendererPerformanceSnapshot = {
        startedAt, observedAt: wall(), recording: 'bounded-lifetime', selectorTiming: 'counts-only', writeTiming: 'parser-callback-wall',
        consumers: { composer: { visible: { ...consumers.composer.visible }, hidden: { ...consumers.composer.hidden } },
          sessionPane: { visible: { ...consumers.sessionPane.visible }, hidden: { ...consumers.sessionPane.hidden } } },
        inputRequests: { user: { ...inputRequests.user, wall: { ...inputRequests.user.wall } }, protocol: { ...inputRequests.protocol, wall: { ...inputRequests.protocol.wall } }, paste: { ...inputRequests.paste, wall: { ...inputRequests.paste.wall } } },
        inputRequestDetails: inputDetails.snapshot(),
        overlay: { ...overlay, triggers: { ...overlay.triggers }, collect: { ...overlay.collect } },
        sessionEvents: { ...sessionEvents }, terminalWrites: { ...terminalWrites, visible: { ...terminalWrites.visible }, hidden: { ...terminalWrites.hidden } },
        inputDelay: { ...inputDelay, timing: { ...inputDelay.timing } },
        longTasks: { ...longTasks, timing: { ...longTasks.timing } }, terminals: current, omittedTerminals: terminals.size - attempted, unavailableTerminals,
        slowEvents: timingKinds.flatMap(kind => slowByKind[kind].map(event => ({ ...event }))).sort((a, b) => a.id - b.id),
        slowEventsOmitted: { ...slowEventsOmitted },
        timingEpochs: { durationMs: 10_000, basis: 'monotonic-occurrence-start', recordingSinceMonoMs, observedMonoMs: start,
          current: copyEpoch(currentEpoch), previous: previousEpoch && copyEpoch(previousEpoch), late: { ...late }, unknown: { ...unknown } },
        tabSwitches: tabSwitchObservation.snapshot(), tabSwitchesOmitted: tabSwitchObservation.omitted(),
        observerCost: { snapshots: { ...observerCost.snapshots }, performanceCallbacks: { ...observerCost.performanceCallbacks } }
      }
      add(observerCost.snapshots, now() - start)
      value.observerCost.snapshots = { ...observerCost.snapshots }
      return value
    }
  }
}
export const rendererPerformance = createRendererPerformance()
