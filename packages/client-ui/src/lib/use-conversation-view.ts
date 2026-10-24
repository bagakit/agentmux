import { readConversationProcessDetail, type ConversationProcessDetailReader } from './read-conversation-process-detail.js'
import { mintObjectId } from '@agentmux/core/object-id'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { consumeConversationWindowPage, projectConversationWindow, conversationSourceKey, CONVERSATION_MAX_READ_BYTES, type ConversationWindowAssembly,
  type ConversationWindowSnapshot, type ConversationTimelineReadInput, type ConversationChangesInput,
  type ConversationObservationHandle, type ConversationReadOptions, type ConversationRef } from '@agentmux/core/conversation'
import type { AgentMuxClient } from '@agentmux/core'
import type { ReadingDiagnosticReason } from '@agentmux/core/reading-diagnostic'
import { createReadingDiagnosticRecorder } from '@agentmux/core/reading-diagnostic-recorder'
import { conversationDiagnosticFrame, conversationDiagnosticSource, type ConversationDiagnosticEvent, type ConversationViewDiagnostics } from './conversation-reading-diagnostics.js'

export type ConversationViewClient = Pick<AgentMuxClient, 'readAgentConversation' | 'readConversationChanges' | 'observeConversation' | 'releaseConversationView'>
export type ConversationViewOperation = 'latest' | 'older' | 'newer' | 'changes' | 'resume' | 'reopen'
type Operation = ConversationViewOperation
export type ConversationSourceRead = { reference: ConversationRef; nativeSource: NonNullable<ConversationTimelineReadInput['nativeSource']> }
type Selection = Pick<ConversationTimelineReadInput, 'nativeSource' | 'record' | 'anchor' | 'limit' | 'preserveCurrent'>
type ObservedConversation = { view: ConversationWindowSnapshot['window']['view']; frame: ReturnType<typeof conversationDiagnosticFrame> }
type PendingFrame = { snapshot: ConversationWindowSnapshot; historical: boolean; operation: Operation; selection: Selection;
  admission?: { accept(): void; cancel(): void } }
type PreparedObservation = { install(): void; dispose(): void }
type ReadAttempt = { id: string; operation: Operation; superseded: boolean; error: Error | null }
type ViewState = { snapshot: ConversationWindowSnapshot | null; loading: boolean; operation: Operation | null; sourceRead: ConversationSourceRead | null; error: Error | null; errorOperation: Operation | null; sourceError: Error | null; observationError: Error | null; held: boolean; historical: boolean; newerAvailable: boolean }
const empty = (): ViewState => ({ snapshot: null, loading: false, operation: null, sourceRead: null, error: null, errorOperation: null, sourceError: null, observationError: null, held: false, historical: false, newerAvailable: false })
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))
/** Cancellation settles the owned opening even when transport returns its handle later. */
function awaitObservation(observed: Promise<ConversationObservationHandle>, signal: AbortSignal): Promise<ConversationObservationHandle> {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(signal.reason)
    signal.addEventListener('abort', cancelled, { once: true })
    if (signal.aborted) cancelled()
    observed.then(value => {
      signal.removeEventListener('abort', cancelled)
      if (signal.aborted) value.dispose()
      else resolve(value)
    }, error => {
      signal.removeEventListener('abort', cancelled)
      reject(error)
    })
  })
}
function diagnosticErrorReason(error: unknown): ReadingDiagnosticReason {
  try {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'CONTROL_PROTOCOL_ERROR') return 'protocol'
    if (code === 'CONTROL_TIMEOUT') return 'deadline'
    if (code === 'CONTROL_UNAVAILABLE' || code === 'AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE') return 'source-unavailable'
    if (code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED') return 'source-changed'
    if (code === 'AGENT_CONVERSATION_WINDOW_FULL') return 'budget'
  } catch { /* A diagnostic explanation cannot replace the original error. */ }
  return 'unknown'
}
function sourceReadError(snapshot: ConversationWindowSnapshot): Error | null {
  const failures = snapshot.coverage.filter(source => source.current === 'unavailable')
  if (!failures.length) return null
  const message = failures.map(source => `${source.source.kind === 'captured' ? 'Captured' : 'Native'} conversation could not be read: ${source.gaps.map(gap => gap.message).join(' ')}`).join(' ')
  return Object.assign(new Error(`${message} Existing messages remain available.`), { code: 'AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE' })
}

/** Presentation lifetime for the original public Reader. The client retains only
 * complete accepted frames and transport assembly; Core owns source pages/joins. */
export function useConversationView(client: ConversationViewClient | null, reference: ConversationRef | undefined, active: boolean,
  options: { identity?: string; diagnostics?: ConversationViewDiagnostics; heldReason?(): ReadingDiagnosticReason;
    beforeCommit?(snapshot: ConversationWindowSnapshot, operation: Operation, displayed: ConversationWindowSnapshot | null, replayingHeldIntent: boolean): boolean } = {}) {
  const key = reference ? JSON.stringify([reference.hostId, reference.agentSessionId, options.identity]) : ''
  const [state, setState] = useState<ViewState>(empty)
  const snapshot = state.snapshot && reference && state.snapshot.hostId === reference.hostId && state.snapshot.agentSessionId === reference.agentSessionId ? state.snapshot : null
  const committed = useRef({ state, key, snapshot, active })
  useLayoutEffect(() => { committed.current = { state, key, snapshot, active } }, [state, key, snapshot, active])
  const owner = useRef<{ key: string; controller: AbortController; snapshot: ConversationWindowSnapshot | null;
    request: AbortController | null; handle: ConversationObservationHandle | null; observed: ObservedConversation | null; inFlight: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null;
    retryTimer: ReturnType<typeof setTimeout> | null; retryDelay: number; historical: boolean; dirty: boolean; held: boolean;
    binding: ConversationWindowSnapshot | null; failures: Map<string, Error>; pending: PendingFrame | null; invalidations: number; unavailable: number;
    note(event: ConversationDiagnosticEvent): void; flush(trigger: 'progress' | 'held' | 'failure' | 'recovered' | 'release'): void;
    attempt: ReadAttempt | null; diagnosticWatchId: string | null } | null>(null)
  const retained = useRef<{ client: ConversationViewClient; key: string; snapshot: ConversationWindowSnapshot; historical: boolean; pending: PendingFrame | null } | null>(null)
  const beforeCommit = useRef(options.beforeCommit); beforeCommit.current = options.beforeCommit
  const heldReason = useRef(options.heldReason); heldReason.current = options.heldReason
  const diagnostics = useRef(options.diagnostics); diagnostics.current = options.diagnostics
  const operation = useRef<(kind: Operation, selection?: Selection, recoverObservation?: boolean, readOptions?: ConversationReadOptions) => Promise<void>>(async () => {})
  const retryOperation = useRef<{ client: ConversationViewClient | null; key: string; kind: Operation; selection: Selection }>({ client, key, kind: 'latest', selection: {} })

  useEffect(() => {
    if (!active || !reference || !client) return
    const ref = { hostId: reference.hostId, agentSessionId: reference.agentSessionId }
    const reporting = diagnostics.current
    let recorder: ReturnType<typeof createReadingDiagnosticRecorder> | null = null
    try {
      if (reporting) recorder = createReadingDiagnosticRecorder({ ...ref, runId: reporting.runId ?? null, sourceHostId: null,
        owner: 'renderer', ownerInstanceId: reporting.ownerInstanceId, producerBuildId: reporting.producerBuildId,
        consumerId: mintObjectId(), consumerKind: reporting.consumerKind }, { publish: record => reporting.publish(record) })
    } catch { /* Diagnostic setup cannot prevent the original reader from starting. */ }
    const note = (event: ConversationDiagnosticEvent) => recorder?.record(event)
    const flush = (trigger: 'progress' | 'held' | 'failure' | 'recovered' | 'release') => recorder?.flush(trigger)
    let attempts = 0, watches = 0
    const parked = retained.current?.key === key && retained.current.client === client ? retained.current : null
    if (retryOperation.current.client !== client || retryOperation.current.key !== key) retryOperation.current = { client, key, kind: 'latest', selection: {} }
    const current = { key, controller: new AbortController(), snapshot: parked?.snapshot ?? null as ConversationWindowSnapshot | null,
      request: null as AbortController | null, handle: null as ConversationObservationHandle | null, observed: null as ObservedConversation | null, inFlight: null as Promise<void> | null,
      timer: null as ReturnType<typeof setTimeout> | null, retryTimer: null as ReturnType<typeof setTimeout> | null, retryDelay: 100,
      historical: parked?.historical ?? false, dirty: false, held: Boolean(parked?.pending), pending: parked?.pending ?? null,
      binding: null as ConversationWindowSnapshot | null, failures: new Map<string, Error>(), invalidations: 0, unavailable: 0,
      note, flush, attempt: null as ReadAttempt | null, diagnosticWatchId: null as string | null }
    owner.current = current
    note({ phase: 'consumer-started' })
    setState(value => value.snapshot?.hostId === reference.hostId && value.snapshot.agentSessionId === reference.agentSessionId
      ? { ...value, loading: true, operation: parked ? 'resume' : 'latest', sourceRead: null } : { ...empty(), loading: true, operation: 'latest' })
    const signal = current.controller.signal
    const alive = () => owner.current === current && !signal.aborted
    let publishedDeferral: { reason: ReadingDiagnosticReason; operation: Operation; attemptId: string | null; watchId: string | null; windowId: string | undefined; revision: number | undefined } | null = null
    const deferred = (operation: Operation, reason: ReadingDiagnosticReason) => {
      const next = { reason, operation, attemptId: current.attempt?.id ?? null, watchId: current.diagnosticWatchId, windowId: current.snapshot?.window.id, revision: current.snapshot?.window.revision }
      note({ phase: 'read-deferred', operation, reason, ...(current.snapshot ? conversationDiagnosticFrame(current.snapshot) : {}) })
      // Publish a new obstruction before any later user action. Repeated source
      // notifications under this same obstruction stay in the bounded short ring.
      if (!publishedDeferral || next.reason !== publishedDeferral.reason || next.operation !== publishedDeferral.operation ||
        next.attemptId !== publishedDeferral.attemptId || next.watchId !== publishedDeferral.watchId ||
        next.windowId !== publishedDeferral.windowId || next.revision !== publishedDeferral.revision) {
        publishedDeferral = next; flush('progress')
      }
    }
    const schedule = () => {
      current.dirty = true
      if (!alive()) return
      const reason = current.inFlight ? 'in-flight' : current.timer ? 'coalesced' : current.held ? 'held' : current.historical ? 'historical' : null
      if (reason) { deferred('changes', reason); return }
      current.timer = setTimeout(() => { current.timer = null; void read('changes') }, 50)
    }
    const release = (view: ConversationWindowSnapshot['window']['view'] | undefined) => {
      if (view) void client.releaseConversationView({ ...ref, view }).catch(() => {})
    }
    const reconnect = () => {
      if (!alive() || current.retryTimer) return
      // Retry only this live consumer's observation, through its accepted view.
      // Transport recovery reuses the accepted view. Only a precise expired
      // current view may rebuild the same original source below.
      current.retryTimer = setTimeout(() => { current.retryTimer = null; void read('resume') }, current.retryDelay)
      current.retryDelay = Math.min(current.retryDelay * 2, 5000)
    }
    const watchError = (failures: Map<string, Error>) => failures.size
      ? Object.assign(new Error([...failures.values()].map(error => error.message).join(' ')), { code: ([...failures.values()][0] as Error & { code?: string }).code }) : null
    const bind = async (snapshot: ConversationWindowSnapshot, isCurrent: () => boolean, recover: boolean, attemptId: string,
      requestSignal: AbortSignal, deferInstallation: boolean): Promise<PreparedObservation | undefined> => {
      if (current.handle && !current.handle.closed.aborted && current.observed?.frame.windowId === snapshot.window.id && !(recover && current.failures.size)) return
      const oldHandle = current.handle, oldObserved = current.observed, oldWatchId = current.diagnosticWatchId
      const failures = new Map<string, Error>()
      let handle: ConversationObservationHandle | null = null, opening = true, disposed = false
      const openingController = new AbortController()
      const abortOpening = () => openingController.abort(requestSignal.aborted ? requestSignal.reason : signal.reason)
      signal.addEventListener('abort', abortOpening, { once: true })
      requestSignal.addEventListener('abort', abortOpening, { once: true })
      const detachOpening = () => {
        signal.removeEventListener('abort', abortOpening)
        requestSignal.removeEventListener('abort', abortOpening)
      }
      const dispose = () => {
        if (disposed) return
        disposed = true; opening = false; detachOpening(); openingController.abort(); handle?.dispose()
      }
      const watchId = String(++watches)
      // A live observer needs original identity and diagnostics, not the old body.
      const frame = conversationDiagnosticFrame(snapshot), scope = snapshot.scope
      current.binding = snapshot
      note({ phase: 'watch-opening', watchId, attemptId, ...conversationDiagnosticFrame(snapshot) })
      flush('progress')
      try {
        const observed = client.observeConversation({ ...ref, view: snapshot.window.view! }, observation => {
          // A binding owns its notifications only while opening or installed.
          // Disposed generations cannot settle or poison a replacement.
          if (disposed || !alive() || !opening && (!handle || current.handle !== handle)) return
          if (observation.kind === 'unavailable') {
            note({ phase: 'watch-unavailable', watchId, sourceHostId: observation.sourceHostId,
              ...conversationDiagnosticSource(observation.source), reason: 'source-unavailable' })
            flush('failure')
            current.unavailable++
            failures.set(conversationSourceKey(observation.source), Object.assign(new Error(observation.message), { code: observation.code }))
            if (!opening) setState(value => ({ ...value, observationError: watchError(failures) }))
          } else {
            note({ phase: 'invalidation-received', watchId, ...frame, sourceHostId: observation.sourceHostId,
              ...conversationDiagnosticSource(observation.source) })
            current.invalidations++
            // A qualified notification recovers only its original source. An
            // unrelated captured update cannot clear a native observation gap.
            failures.delete(conversationSourceKey(observation.source))
            if (!opening) {
              setState(value => ({ ...value, observationError: watchError(failures),
                newerAvailable: current.historical || current.held || value.newerAvailable }))
              schedule()
            }
          }
        }, { signal: openingController.signal })
        // Cancellation ends this read even when transport completion is late.
        // The original opening still owns and disposes its eventual handle.
        handle = await awaitObservation(observed, openingController.signal)
      } catch (error) {
        dispose()
        note({ phase: 'watch-closed', watchId, attemptId, reason: diagnosticErrorReason(error), ...conversationDiagnosticFrame(snapshot) })
        throw error
      } finally { if (current.binding === snapshot) current.binding = null }
      if (!isCurrent()) {
        note({ phase: 'watch-closed', watchId, attemptId, reason: 'cancelled', ...conversationDiagnosticFrame(snapshot) })
        dispose(); return
      }
      if (handle.sourceHostId !== snapshot.sourceHostId || handle.scope.sources.length !== snapshot.scope.sources.length ||
        handle.scope.sources.some(source => !scope.sources.some(original => conversationSourceKey(source) === conversationSourceKey(original)))) {
        note({ phase: 'watch-closed', watchId, attemptId, reason: 'protocol', ...conversationDiagnosticFrame(snapshot) })
        dispose(); throw Object.assign(new Error('The observation returned another original source scope. The accepted frame is retained.'), { code: 'CONTROL_PROTOCOL_ERROR' })
      }
      if (handle.closed.aborted) {
        note({ phase: 'watch-closed', watchId, attemptId, reason: 'source-unavailable', ...conversationDiagnosticFrame(snapshot) })
        const error = errorOf(handle.closed.reason ?? 'The original conversation observation ended while opening.')
        dispose(); throw error
      }
      // Startup notifications qualify the observer; checkpoint/read coverage is
      // a separate fact and cannot revoke an observer that opened successfully.
      if (failures.size && oldHandle && !oldHandle.closed.aborted && oldObserved?.frame.windowId === snapshot.window.id) {
        note({ phase: 'watch-closed', watchId, attemptId, reason: 'source-unavailable', ...conversationDiagnosticFrame(snapshot) })
        dispose()
        for (const [source, error] of failures) current.failures.set(source, error)
        setState(value => ({ ...value, observationError: watchError(current.failures) }))
        return
      }
      const installed = handle
      const prepared: PreparedObservation = { dispose, install: () => {
        opening = false; detachOpening()
        if (installed.closed.aborted) {
          const error = errorOf(installed.closed.reason ?? 'The original conversation observation ended before presentation.')
          dispose()
          note({ phase: 'watch-closed', watchId, reason: 'source-unavailable', ...frame }); flush('failure')
          setState(value => ({ ...value, observationError: error }))
          reconnect()
          return
        }
        current.handle = installed; current.observed = { view: snapshot.window.view, frame }; current.failures = failures
        current.diagnosticWatchId = watchId
        note({ phase: 'watch-opened', watchId, attemptId, ...conversationDiagnosticFrame(snapshot) })
        setState(value => ({ ...value, observationError: watchError(failures) }))
        current.retryDelay = 100
        if (current.retryTimer) { clearTimeout(current.retryTimer); current.retryTimer = null }
        if (oldHandle && oldWatchId) note({ phase: 'watch-closed', watchId: oldWatchId, reason: 'navigation', ...oldObserved?.frame })
        oldHandle?.dispose(); if (oldObserved?.frame.windowId !== snapshot.window.id) release(oldObserved?.view)
        installed.closed.addEventListener('abort', () => {
          if (alive() && current.handle === installed) {
            note({ phase: 'watch-closed', watchId, reason: 'source-unavailable', ...frame })
            flush('failure')
            setState(value => ({ ...value, observationError: errorOf(installed.closed.reason ?? 'Conversation observation ended. The original window remains available.') }))
            reconnect()
          }
        }, { once: true })
        // The same physical-page checkpoint closes the read→watch interval.
        current.dirty = true
      } }
      if (deferInstallation) return prepared
      prepared.install()
    }
    const read = (kind: Operation, selection: Selection = {}, recoverObservation = false, readOptions: ConversationReadOptions = {}): Promise<void> => {
      if (!alive() || readOptions.signal?.aborted) return Promise.resolve()
      if (current.inFlight && (kind === 'changes' || kind === 'resume')) {
        deferred(kind, 'in-flight'); return current.inFlight
      }
      if (kind !== 'latest' && !current.snapshot || kind === 'older' && !current.snapshot?.window.navigation.older || kind === 'newer' && !current.snapshot?.window.navigation.newer) return Promise.resolve()
      // An explicit navigation replaces only the related read, never its Run or
      // accepted frame. A late superseded reply cannot bind or commit a window.
      if (current.attempt && current.inFlight && !current.attempt.superseded) {
        current.attempt.superseded = true
        note({ phase: 'read-superseded', attemptId: current.attempt.id, operation: current.attempt.operation, reason: 'navigation' })
      }
      const continuation = kind === 'changes' || kind === 'resume' ? current.pending?.admission && current.pending : null
      if (!continuation) { current.pending?.admission?.cancel(); current.request?.abort() }
      if (current.timer) { clearTimeout(current.timer); current.timer = null }
      const requestController = new AbortController(), requestSignal = requestController.signal
      current.request = requestController
      const attempt: ReadAttempt = { id: String(++attempts), operation: kind, superseded: false, error: null }
      current.attempt = attempt
      publishedDeferral = null
      const abortRead = () => requestController.abort(signal.reason)
      const cancelRequested = () => requestController.abort(readOptions.signal?.reason)
      signal.addEventListener('abort', abortRead, { once: true })
      readOptions.signal?.addEventListener('abort', cancelRequested, { once: true })
      const detachCancellation = () => {
        signal.removeEventListener('abort', abortRead)
        readOptions.signal?.removeEventListener('abort', cancelRequested)
      }
      const isCurrent = () => alive() && current.request === requestController && !requestSignal.aborted
      const prior = current.snapshot
      const priorHistorical = current.historical, priorPending = current.pending, priorRetained = retained.current
      const originalNative = prior?.scope.sources.find(source => source.kind === 'native')
      // This consumer assembles a complete bounded frame before committing it.
      // Use the existing wire budget instead of fragmenting it into CLI-sized pages.
      const request: ConversationTimelineReadInput = { ...ref, ...(!selection.record && !selection.anchor && !(kind === 'resume' && prior?.window.anchor) ? { processDetails: 'deferred' as const } : {}), limit: 100, maxBytes: CONVERSATION_MAX_READ_BYTES,
        ...selection, ...(kind === 'reopen' && originalNative?.kind === 'native' ? { nativeSource: { providerId: originalNative.providerId, nativeSessionId: originalNative.nativeSessionId } } : {}),
        ...(kind === 'resume' && prior?.window.view ? { view: prior.window.view } : {}), ...(kind === 'older' && prior?.window.navigation.older ? { cursor: prior.window.navigation.older } : {}),
        ...(kind === 'newer' && prior?.window.navigation.newer ? { cursor: prior.window.navigation.newer } : {}) }
      const change: ConversationChangesInput | null = kind === 'changes' && prior ? {
        ...ref, ...(prior.processDetails ? { processDetails: prior.processDetails } : {}), checkpoint: prior.window.checkpoint, view: prior.window.view!, limit: 100, maxBytes: CONVERSATION_MAX_READ_BYTES
      } : null
      // Presentation follows this original request, never a retained frame's
      // source during an unqualified latest selection or a replay-only resume.
      const nativeSource = kind === 'resume' ? undefined : request.nativeSource ??
        (request.record?.source.kind === 'native' ? request.record.source : undefined) ??
        (request.anchor?.record.source.kind === 'native' ? request.anchor.record.source : undefined) ??
        (change || kind === 'older' || kind === 'newer' ? originalNative : undefined)
      const sourceRead = nativeSource ? { reference: ref, nativeSource: { providerId: nativeSource.providerId, nativeSessionId: nativeSource.nativeSessionId } } : null
      note({ phase: 'read-started', attemptId: attempt.id, operation: kind, ...(prior ? conversationDiagnosticFrame(prior) : {}),
        ...(sourceRead ? { sourceKind: 'native', nativeSource: sourceRead.nativeSource } : {}) })
      flush('progress')
      setState(value => ({ ...value, loading: true, operation: kind, sourceRead }))
      if (kind === 'changes' || kind === 'latest') current.dirty = false
      const pending = (async () => {
        let complete: ConversationWindowSnapshot | null = null
        let reopenExpired = false
        let prepared: PreparedObservation | undefined
        let currentSource: ConversationObservationHandle | undefined
        let admission: PendingFrame['admission']
        let released = false
        const releaseComplete = () => {
          if (!continuation && !released && complete && complete.window.id !== current.snapshot?.window.id) {
            released = true; release(complete.window.view)
          }
        }
        try {
          if (kind === 'latest' && !request.nativeSource && !request.record && !request.anchor) {
            // The original current observation owns discovery, including a
            // confirmed locator that could not yet be saved. Keep it alive
            // through this same consumer's current read→view-watch handoff.
            try {
              currentSource = await awaitObservation(client.observeConversation(ref, observation => {
                if (!isCurrent()) return
                if (observation.kind === 'unavailable') {
                  setState(value => ({ ...value, observationError: Object.assign(new Error(observation.message), { code: observation.code }) }))
                } else current.dirty = true
              }, { signal: requestSignal }), requestSignal)
            } catch (error) {
              if (!isCurrent()) return
              // Observation uncertainty cannot take away retained saved reads.
              setState(value => ({ ...value, observationError: errorOf(error) }))
            }
          }
          let assembly: ConversationWindowAssembly | undefined, cursor: string | undefined
          let more = false
          do {
            const page = change ? await client.readConversationChanges({ ...change, ...(cursor ? { cursor } : {}) }, { signal: requestSignal })
              : await client.readAgentConversation({ ...request, ...(cursor ? { cursor, limit: 100 } : {}) }, { signal: requestSignal })
            if (!isCurrent()) {
              if (!continuation && page.window.id !== current.snapshot?.window.id) release(page.window.view)
              return
            }
            note({ phase: 'read-page', attemptId: attempt.id, operation: kind, sourceHostId: page.sourceHostId, itemCount: page.items.length })
            const result = consumeConversationWindowPage(page, assembly)
            if (result.kind === 'complete') { complete = result.snapshot; more = 'more' in page && Boolean(page.more); break }
            assembly = result.pending
            if (!page.nextCursor || page.nextCursor === cursor) throw new Error('The original conversation window did not complete. Its displayed records are kept.')
            cursor = page.nextCursor
          } while (true)
          if (!isCurrent() || !complete) return
          note({ phase: 'assembly-complete', attemptId: attempt.id, operation: kind, ...conversationDiagnosticFrame(complete) })
          if (prior && kind !== 'latest') {
            // Exact Host, source epoch and view identity precede revision arithmetic.
            if (complete.hostId !== prior.hostId || complete.sourceHostId !== prior.sourceHostId || complete.agentSessionId !== prior.agentSessionId ||
              (kind !== 'reopen' && complete.window.id !== prior.window.id) || complete.scope.sources.length !== prior.scope.sources.length ||
              complete.scope.sources.some(source => !prior.scope.sources.some(original => conversationSourceKey(source) === conversationSourceKey(original))))
              throw Object.assign(new Error('The original conversation scope changed. Its displayed frame and position are retained.'), { code: 'CONTROL_PROTOCOL_ERROR' })
            if (kind !== 'reopen' && complete.window.revision < prior.window.revision) throw Object.assign(new Error('This response predates the accepted conversation frame. Its displayed originals are retained.'), { code: 'CONTROL_PROTOCOL_ERROR' })
          }
          const sourceError = sourceReadError(complete)
          // A fresh cut cannot replace readable originals with an unavailable
          // source. Keep their existing view and observer for recovery.
          if (sourceError && (kind === 'reopen' || kind === 'latest' && prior)) throw sourceError
          const cancellableRecord = Boolean(selection.record && readOptions.signal)
          try { if (!continuation) prepared = await bind(complete, isCurrent, recoverObservation || kind === 'resume', attempt.id, requestSignal, cancellableRecord) }
          catch (error) { if (isCurrent()) {
            note({ phase: 'watch-unavailable', reason: diagnosticErrorReason(error), ...conversationDiagnosticFrame(complete) }); flush('failure')
            setState(value => ({ ...value, observationError: errorOf(error) })); reconnect()
          } }
          if (!isCurrent()) return
          current.snapshot = complete
          const wasHistorical = current.historical
          current.historical = Boolean(complete.window.anchor || complete.window.navigation.newer)
          // Preloading older pages does not close a still-retained source head.
          // Returning from an evicted-head window must catch up its original cut.
          if (wasHistorical && !current.historical) current.dirty = true
          // A replay or live delta of the same pending view keeps the original
          // navigation intent. Explicit navigation starts its own transaction.
          const original = (kind === 'resume' || kind === 'changes') && current.pending?.snapshot.window.id === complete.window.id ? current.pending : null
          const frame: PendingFrame = continuation ?? { snapshot: complete, historical: current.historical, operation: original?.operation ?? kind, selection: original?.selection ?? selection }
          frame.snapshot = complete; frame.historical = current.historical
          if (cancellableRecord) {
            let resolved = false
            const finishAdmission = () => {
              resolved = true
              requestSignal.removeEventListener('abort', cancelPending)
              detachCancellation()
            }
            const cancelPending = () => admission?.cancel()
            admission = {
              accept: () => {
                if (resolved) return
                finishAdmission(); prepared?.install(); prepared = undefined
              },
              cancel: () => {
                if (resolved) return
                finishAdmission(); prepared?.dispose(); prepared = undefined
                if (current.pending === frame) {
                  if (current.request !== requestController) current.request?.abort()
                  current.snapshot = prior; current.historical = priorHistorical
                  current.pending = priorPending; current.held = Boolean(priorPending)
                  retained.current = priorRetained
                  setState(value => ({ ...value, held: current.held }))
                }
                releaseComplete()
                if (current.dirty && !current.inFlight) schedule()
              },
            }
            frame.admission = admission
            requestSignal.addEventListener('abort', cancelPending, { once: true })
          }
          current.held = beforeCommit.current?.(complete, frame.operation, committed.current.snapshot, Boolean(original)) === false
          let protectionReason: ReadingDiagnosticReason = 'unknown'
          // Diagnostic explanation cannot change the original boolean admission.
          if (current.held) { try { protectionReason = heldReason.current?.() ?? 'unknown' } catch { /* Only this explanation is unavailable. */ } }
          note({ phase: current.held ? 'admission-held' : 'admission-accepted', attemptId: attempt.id, operation: frame.operation,
            ...(current.held ? { reason: protectionReason } : {}), ...conversationDiagnosticFrame(complete) })
          // Healthy admission and its synchronous read end share one publication.
          // A protected frame is independently useful before any later action.
          if (current.held) flush('held')
          current.pending = current.held ? frame : null
          if (!current.held) frame.admission?.accept()
          retained.current = { client, key, snapshot: complete, historical: current.historical, pending: current.pending }
          attempt.error = sourceError
          if (sourceError) { note({ phase: 'read-failed', attemptId: attempt.id, operation: kind, reason: 'source-unavailable', ...conversationDiagnosticFrame(complete) }); flush('failure') }
          // Resume replays the retained frame. It cannot replace the failed cut's
          // retry intent with another replay of that same unavailable coverage.
          if (sourceError && kind !== 'resume') retryOperation.current = { client, key, kind, selection }
          setState(value => ({ ...value, ...(current.held ? {} : { snapshot: complete, historical: frame.historical, sourceError }), held: current.held,
            // A live update or retained-frame replay does not fulfill a failed
            // navigation. Resolve only its operation, a new explicit cut, or
            // replace it with the current frame's actual source failure.
            ...(current.held && sourceError ? { error: sourceError, errorOperation: kind }
              : sourceError || kind === 'latest' || kind === 'reopen' || value.errorOperation === kind ? { error: null, errorOperation: null } : {}),
            newerAvailable: kind === 'latest' || kind === 'changes' && !more && !current.held && !current.historical ? false : value.newerAvailable }))
          if (more) current.dirty = true
        } catch (error) { if (isCurrent()) {
          attempt.error = errorOf(error)
          note({ phase: 'read-failed', attemptId: attempt.id, operation: kind, reason: diagnosticErrorReason(error) })
          flush('failure')
          releaseComplete()
          retryOperation.current = { client, key, kind, selection }
          setState(value => ({ ...value, error: errorOf(error), errorOperation: kind }))
          const code = (error as { code?: string })?.code
          // A parked current view is a disposable reader, not a durable source.
          // Rebuild it once from the original source; the normal commit guard
          // still owns reading position, selection and the displayed frame.
          if (code === 'AGENT_CONVERSATION_VIEW_EXPIRED' && !current.historical) {
            retryOperation.current = { client, key, kind: 'reopen', selection: {} }
            reopenExpired = kind === 'resume'
          }
          if (kind === 'resume' && ['CONTROL_UNAVAILABLE', 'CONTROL_TIMEOUT'].includes(code ?? '')) reconnect()
        } }
        finally {
          currentSource?.dispose()
          note({ phase: 'read-ended', attemptId: attempt.id, operation: kind,
            ...(requestSignal.aborted ? { reason: 'cancelled' as const } : {}) })
          flush('progress')
          // A held record retains the same cancellation lease until admission.
          // Ordinary completed reads leave no operation listener behind.
          if (!admission || current.pending?.admission !== admission) detachCancellation()
          if (requestSignal.aborted) admission?.cancel()
          if (prepared && (!admission || current.pending?.admission !== admission)) prepared.dispose()
          if (!alive() || current.request !== requestController) { releaseComplete(); return }
          if (requestSignal.aborted) releaseComplete()
          current.inFlight = null
          current.attempt = null
          setState(value => ({ ...value, loading: false, operation: null, sourceRead: null }))
          if (reopenExpired) void read('reopen')
          else if (current.dirty) schedule()
        }
      })()
      current.inFlight = pending
      return pending
    }
    operation.current = read
    void read(parked ? 'resume' : 'latest')
    return () => {
      if (current.attempt && current.inFlight && !current.attempt.superseded) {
        current.attempt.superseded = true
        note({ phase: 'read-superseded', attemptId: current.attempt.id, operation: current.attempt.operation, reason: 'disposed' })
      }
      if (current.handle && current.diagnosticWatchId) note({ phase: 'watch-closed', watchId: current.diagnosticWatchId, reason: 'disposed', ...current.observed?.frame })
      note({ phase: 'consumer-ended', reason: 'disposed' }); flush('release')
      current.pending?.admission?.cancel()
      current.controller.abort(); if (current.timer) clearTimeout(current.timer); if (current.retryTimer) clearTimeout(current.retryTimer)
      current.handle?.dispose()
      if (owner.current === current) owner.current = null
    }
  }, [client, key, active])
  useEffect(() => () => {
    const value = retained.current
    if (value?.client === client && value.key === key) {
      retained.current = null
      if (value.snapshot.window.view) void value.client.releaseConversationView({ hostId: value.snapshot.hostId, agentSessionId: value.snapshot.agentSessionId, view: value.snapshot.window.view }).catch(() => {})
    }
  }, [client, key])

  const readProcessDetail = useCallback<ConversationProcessDetailReader>((anchor, signal) => {
    if (!client || !reference || anchor.frontier.hostId !== reference.hostId || anchor.frontier.agentSessionId !== reference.agentSessionId) return Promise.reject(new Error('The original process detail belongs to another reading scope.'))
    return readConversationProcessDetail(client, anchor, signal)
  }, [client, reference?.hostId, reference?.agentSessionId])
  const earlier = useCallback(async (limit?: number, options: Pick<ConversationTimelineReadInput, 'preserveCurrent'> = {}) => {
    await operation.current('older', { ...options, ...(limit === undefined ? {} : { limit }) }); return owner.current?.snapshot ?? null
  }, [])
  const newer = useCallback(async () => { await operation.current('newer'); return owner.current?.snapshot ?? null }, [])
  const selectSource = useCallback((nativeSource: NonNullable<ConversationTimelineReadInput['nativeSource']>) => operation.current('latest', { nativeSource }), [])
  const selectRecord = useCallback((record: NonNullable<ConversationTimelineReadInput['record']>, readOptions?: ConversationReadOptions) => operation.current('latest', { record }, false, readOptions), [])
  const reveal = useCallback((anchor: NonNullable<ConversationTimelineReadInput['anchor']>) => operation.current('latest', { anchor }), [])
  const refresh = useCallback(() => operation.current('latest'), [])
  const resume = useCallback(() => operation.current(owner.current?.snapshot ? 'resume' : 'latest'), [])
  const settle = useCallback(async () => {
    const current = owner.current, request = current?.request, attempt = current?.attempt, pending = current?.inFlight
    await pending
    if (!current || owner.current !== current || current.request !== request || pending && (request?.signal.aborted || attempt?.superseded)) return null
    return { snapshot: current.snapshot, error: pending && attempt ? attempt.error : committed.current.state.error ?? committed.current.state.sourceError,
      historical: current.historical }
  }, [])
  const changes = useCallback(() => operation.current('changes'), [])
  /** Instantaneous pointers to this mounted consumer; no read, retry or copied frame store. */
  const inspect = useCallback(() => {
    const accepted = committed.current, current = owner.current?.key === accepted.key ? owner.current : null
    return { ...accepted.state, snapshot: accepted.snapshot, loading: accepted.active && accepted.state.loading,
      error: accepted.state.error ?? accepted.state.sourceError,
      pending: current?.held ? current.snapshot : null,
      dirty: current?.dirty ?? null, inFlight: Boolean(current?.inFlight),
      watch: { binding: Boolean(current?.binding), bound: Boolean(current?.handle), closed: current?.handle?.closed.aborted ?? null,
        windowId: current?.observed?.frame.windowId ?? null, invalidations: current?.invalidations ?? 0, unavailable: current?.unavailable ?? 0 } }
  }, [])
  const retry = useCallback(() => {
    const value = committed.current.state
    return value.observationError && !value.error && !value.sourceError
      ? operation.current('resume', {}, true)
      : operation.current(retryOperation.current.kind, retryOperation.current.selection, Boolean(value.observationError))
  }, [])
  const acceptHeld = useCallback(() => {
    const current = owner.current
    const frame = current?.pending
    if (!current?.held || !frame || beforeCommit.current?.(frame.snapshot, frame.operation, committed.current.snapshot, true) === false) return
    frame.admission?.accept()
    current.held = false; current.pending = null
    current.note({ phase: 'held-released', operation: frame.operation, ...conversationDiagnosticFrame(frame.snapshot) })
    current.note({ phase: 'admission-accepted', operation: frame.operation, ...conversationDiagnosticFrame(frame.snapshot) })
    current.flush('recovered')
    if (retained.current?.key === current.key) retained.current.pending = null
    setState(value => ({ ...value, snapshot: frame.snapshot, historical: frame.historical, sourceError: sourceReadError(frame.snapshot), held: false,
      newerAvailable: frame.historical || current.dirty ? value.newerAvailable : false }))
    if (current.dirty && !current.historical) void operation.current('changes')
  }, [])
  /** The presentation owner may report its actual commit/visibility without another reader. */
  const noteDiagnostic = useCallback((event: ConversationDiagnosticEvent) => {
    const current = owner.current
    if (!current || current.key !== committed.current.key) return
    current.note(event); current.flush('progress')
  }, [])
  const reading = useMemo(() => snapshot ? projectConversationWindow(snapshot) : null, [snapshot])
  return { ...state, error: state.error ?? state.sourceError, errorOperation: state.error ? state.errorOperation : null, snapshot, reading, loading: active && state.loading, hasMore: Boolean(snapshot?.window.navigation.older), hasNewer: Boolean(snapshot?.window.navigation.newer), readProcessDetail, earlier, newer, refresh, resume, settle, changes, retry, inspect, acceptHeld, selectSource, selectRecord, reveal, noteDiagnostic }
}
