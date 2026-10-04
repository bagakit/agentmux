import type { RendererConsumerCost, RendererOverlayObservation, RendererPerformanceSnapshot, RendererTerminalCost, RendererWorkTiming } from '@agentmux/core/control'
import { tabSwitchObservation } from './tab-switch-observation'

const timing = (): RendererWorkTiming => ({ count: 0, totalMs: 0, maxMs: 0 })
const consumer = (): RendererConsumerCost => ({ checks: 0, changes: 0, commits: 0 })
function add(target: RendererWorkTiming, duration: number) {
  const ms = Math.max(0, duration)
  target.count++; target.totalMs += ms; target.maxMs = Math.max(target.maxMs, ms)
}
/** No clock, subscription, payload or historical buffer scan on a selector check. */
export function createRendererPerformance(now = () => performance.now(), wall = Date.now) {
  const startedAt = wall()
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
  const slowEvents: RendererPerformanceSnapshot['slowEvents'] = []
  let observer: PerformanceObserver | undefined, inputObserver: PerformanceObserver | undefined, observerOwners = 0, observerGeneration = 0
  function slow(kind: RendererPerformanceSnapshot['slowEvents'][number]['kind'], detail: string, durationMs: number) {
    if (durationMs < 50) return
    if (slowEvents.length === 32) slowEvents.shift()
    slowEvents.push({ kind, detail: detail.slice(0, 128), observedAt: wall(), durationMs })
  }
  return {
    check(kind: keyof typeof consumers, visible: boolean, changed: boolean) {
      const cost = consumers[kind][visible ? 'visible' : 'hidden']
      cost.checks++; if (changed) cost.changes++
    },
    commit(kind: keyof typeof consumers, visible: boolean) { consumers[kind][visible ? 'visible' : 'hidden'].commits++ },
    start: now,
    observeInputRequest(kind: keyof typeof inputRequests, request: Promise<unknown>, start: number) {
      const cost = inputRequests[kind]
      cost.started++; cost.pending++
      const settle = (ok: boolean) => {
        cost.pending--; if (ok) cost.completed++; else cost.failed++
        add(cost.wall, now() - start)
      }
      void request.then(() => settle(true), () => settle(false))
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
    terminalInteraction(detail: 'keydown-dispatch' | 'wheel-dispatch' | 'write-request', duration: number) {
      slow('terminal-interaction', detail, duration)
    },
    sessionEvent(kind: string, start: number) {
      const elapsed = Math.max(0, now() - start)
      add(sessionEvents, elapsed); slow('session-event', kind, elapsed)
    },
    terminalWrite(visible: boolean, data: string | Uint8Array, start: number) {
      const elapsed = Math.max(0, now() - start)
      add(terminalWrites[visible ? 'visible' : 'hidden'], elapsed)
      if (typeof data === 'string') terminalWrites.stringCodeUnits += data.length
      else terminalWrites.bytes += data.byteLength
      slow('terminal-write', visible ? 'visible' : 'hidden', elapsed)
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
              add(longTasks.timing, entry.duration); slow('long-task', 'renderer-main-thread', entry.duration)
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
                add(inputDelay.timing, delay); slow('input-delay', 'event-timing', delay)
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
        overlay: { ...overlay, triggers: { ...overlay.triggers }, collect: { ...overlay.collect } },
        sessionEvents: { ...sessionEvents }, terminalWrites: { ...terminalWrites, visible: { ...terminalWrites.visible }, hidden: { ...terminalWrites.hidden } },
        inputDelay: { ...inputDelay, timing: { ...inputDelay.timing } },
        longTasks: { ...longTasks, timing: { ...longTasks.timing } }, terminals: current, omittedTerminals: terminals.size - attempted, unavailableTerminals,
        slowEvents: slowEvents.map(event => ({ ...event })), tabSwitches: tabSwitchObservation.snapshot(), tabSwitchesOmitted: tabSwitchObservation.omitted(),
        observerCost: { snapshots: { ...observerCost.snapshots }, performanceCallbacks: { ...observerCost.performanceCallbacks } }
      }
      add(observerCost.snapshots, now() - start)
      value.observerCost.snapshots = { ...observerCost.snapshots }
      return value
    }
  }
}
export const rendererPerformance = createRendererPerformance()
