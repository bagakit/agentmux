import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { consumeConversationWindowPage, projectConversationWindow, conversationSourceKey, CONVERSATION_MAX_READ_BYTES, type ConversationWindowAssembly,
  type ConversationWindowSnapshot, type ConversationTimelineReadInput, type ConversationChangesInput,
  type ConversationObservationHandle, type ConversationRef } from '@agentmux/core/conversation'
import type { AgentMuxClient } from '@agentmux/core'
import type { ReadingDiagnosticReason } from '@agentmux/core/reading-diagnostic'
import { createReadingDiagnosticRecorder } from '@agentmux/core/reading-diagnostic-recorder'
import { conversationDiagnosticFrame, conversationDiagnosticSource, type ConversationDiagnosticEvent, type ConversationViewDiagnostics } from './conversation-reading-diagnostics.js'

export type ConversationViewClient = Pick<AgentMuxClient, 'readAgentConversation' | 'readConversationChanges' | 'observeConversation' | 'releaseConversationView'>
export type ConversationViewOperation = 'latest' | 'older' | 'newer' | 'changes' | 'resume' | 'reopen'
type Operation = ConversationViewOperation
export type ConversationSourceRead = { reference: ConversationRef; nativeSource: NonNullable<ConversationTimelineReadInput['nativeSource']> }
type Selection = Pick<ConversationTimelineReadInput, 'nativeSource' | 'anchor' | 'limit' | 'preserveCurrent'>
type PendingFrame = { snapshot: ConversationWindowSnapshot; historical: boolean; operation: Operation; selection: Selection }
type ViewState = { snapshot: ConversationWindowSnapshot | null; loading: boolean; operation: Operation | null; sourceRead: ConversationSourceRead | null; error: Error | null; errorOperation: Operation | null; sourceError: Error | null; observationError: Error | null; held: boolean; historical: boolean; newerAvailable: boolean }
const empty = (): ViewState => ({ snapshot: null, loading: false, operation: null, sourceRead: null, error: null, errorOperation: null, sourceError: null, observationError: null, held: false, historical: false, newerAvailable: false })
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))
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
    request: AbortController | null; handle: ConversationObservationHandle | null; observed: ConversationWindowSnapshot | null; inFlight: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null;
    retryTimer: ReturnType<typeof setTimeout> | null; retryDelay: number; historical: boolean; dirty: boolean; held: boolean;
    binding: ConversationWindowSnapshot | null; failures: Map<string, Error>; pending: PendingFrame | null; invalidations: number; unavailable: number;
    note(event: ConversationDiagnosticEvent): void; flush(trigger: 'progress' | 'held' | 'failure' | 'recovered' | 'release'): void;
    attempt: { id: string; operation: Operation; superseded: boolean } | null; diagnosticWatchId: string | null } | null>(null)
  const retained = useRef<{ client: ConversationViewClient; key: string; snapshot: ConversationWindowSnapshot; historical: boolean; pending: PendingFrame | null } | null>(null)
  const beforeCommit = useRef(options.beforeCommit); beforeCommit.current = options.beforeCommit
  const heldReason = useRef(options.heldReason); heldReason.current = options.heldReason
  const diagnostics = useRef(options.diagnostics); diagnostics.current = options.diagnostics
  const operation = useRef<(kind: Operation, selection?: Selection, recoverObservation?: boolean) => Promise<void>>(async () => {})
  const retryOperation = useRef<{ client: ConversationViewClient | null; key: string; kind: Operation; selection: Selection }>({ client, key, kind: 'latest', selection: {} })

  useEffect(() => {
    if (!active || !reference || !client) return
    const ref = { hostId: reference.hostId, agentSessionId: reference.agentSessionId }
    const reporting = diagnostics.current
    let recorder: ReturnType<typeof createReadingDiagnosticRecorder> | null = null
    try {
      if (reporting) recorder = createReadingDiagnosticRecorder({ ...ref, runId: reporting.runId ?? null, sourceHostId: null,
        owner: 'renderer', ownerInstanceId: reporting.ownerInstanceId, producerBuildId: reporting.producerBuildId,
        consumerId: crypto.randomUUID(), consumerKind: reporting.consumerKind }, { publish: record => reporting.publish(record) })
    } catch { /* Diagnostic setup cannot prevent the original reader from starting. */ }
    const note = (event: ConversationDiagnosticEvent) => recorder?.record(event)
    const flush = (trigger: 'progress' | 'held' | 'failure' | 'recovered' | 'release') => recorder?.flush(trigger)
    let attempts = 0, watches = 0
    const parked = retained.current?.key === key && retained.current.client === client ? retained.current : null
    if (retryOperation.current.client !== client || retryOperation.current.key !== key) retryOperation.current = { client, key, kind: 'latest', selection: {} }
    const current = { key, controller: new AbortController(), snapshot: parked?.snapshot ?? null as ConversationWindowSnapshot | null,
      request: null as AbortController | null, handle: null as ConversationObservationHandle | null, observed: null as ConversationWindowSnapshot | null, inFlight: null as Promise<void> | null,
      timer: null as ReturnType<typeof setTimeout> | null, retryTimer: null as ReturnType<typeof setTimeout> | null, retryDelay: 100,
      historical: parked?.historical ?? false, dirty: false, held: Boolean(parked?.pending), pending: parked?.pending ?? null,
      binding: null as ConversationWindowSnapshot | null, failures: new Map<string, Error>(), invalidations: 0, unavailable: 0,
      note, flush, attempt: null as { id: string; operation: Operation; superseded: boolean } | null, diagnosticWatchId: null as string | null }
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
    const release = (snapshot: ConversationWindowSnapshot | null) => {
      if (snapshot?.window.view) void client.releaseConversationView({ ...ref, view: snapshot.window.view }).catch(() => {})
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
    const bind = async (snapshot: ConversationWindowSnapshot, isCurrent: () => boolean, recover: boolean, attemptId: string) => {
      if (current.handle && !current.handle.closed.aborted && current.observed?.window.id === snapshot.window.id && !(recover && current.failures.size)) return
      const oldHandle = current.handle, oldSnapshot = current.observed, oldWatchId = current.diagnosticWatchId
      const failures = new Map<string, Error>()
      let handle: ConversationObservationHandle | null = null, opening = true
      const watchId = String(++watches)
      current.binding = snapshot
      note({ phase: 'watch-opening', watchId, attemptId, ...conversationDiagnosticFrame(snapshot) })
      flush('progress')
      try { handle = await client.observeConversation({ ...ref, view: snapshot.window.view! }, observation => {
        // A binding owns its notifications only while opening or installed.
        // Disposed generations cannot settle or poison a replacement.
        if (!alive() || !opening && (!handle || current.handle !== handle)) return
        if (observation.kind === 'unavailable') {
          note({ phase: 'watch-unavailable', watchId, sourceHostId: observation.sourceHostId,
            ...conversationDiagnosticSource(observation.source), reason: 'source-unavailable' })
          flush('failure')
          current.unavailable++
          failures.set(conversationSourceKey(observation.source), Object.assign(new Error(observation.message), { code: observation.code }))
          if (!opening) setState(value => ({ ...value, observationError: watchError(failures) }))
        } else {
          note({ phase: 'invalidation-received', watchId, ...conversationDiagnosticFrame(snapshot), sourceHostId: observation.sourceHostId,
            ...conversationDiagnosticSource(observation.source) })
          current.invalidations++
          if (!opening) {
            setState(value => ({ ...value, newerAvailable: current.historical || current.held || value.newerAvailable }))
            schedule()
          }
        }
      }, { signal }) } catch (error) {
        note({ phase: 'watch-closed', watchId, attemptId, reason: diagnosticErrorReason(error), ...conversationDiagnosticFrame(snapshot) })
        throw error
      } finally { opening = false; if (current.binding === snapshot) current.binding = null }
      if (!isCurrent()) {
        note({ phase: 'watch-closed', watchId, attemptId, reason: 'cancelled', ...conversationDiagnosticFrame(snapshot) })
        handle.dispose(); if (snapshot.window.id !== current.snapshot?.window.id) release(snapshot); return
      }
      if (handle.sourceHostId !== snapshot.sourceHostId || handle.scope.sources.length !== snapshot.scope.sources.length ||
        handle.scope.sources.some(source => !snapshot.scope.sources.some(original => conversationSourceKey(source) === conversationSourceKey(original)))) {
        note({ phase: 'watch-closed', watchId, attemptId, reason: 'protocol', ...conversationDiagnosticFrame(snapshot) })
        handle.dispose(); throw Object.assign(new Error('The observation returned another original source scope. The accepted frame is retained.'), { code: 'CONTROL_PROTOCOL_ERROR' })
      }
      if (handle.closed.aborted) {
        note({ phase: 'watch-closed', watchId, attemptId, reason: 'source-unavailable', ...conversationDiagnosticFrame(snapshot) })
        handle.dispose(); throw errorOf(handle.closed.reason ?? 'The original conversation observation ended while opening.')
      }
      // Startup notifications qualify the observer; checkpoint/read coverage is
      // a separate fact and cannot revoke an observer that opened successfully.
      if (failures.size && oldHandle && !oldHandle.closed.aborted && oldSnapshot?.window.id === snapshot.window.id) {
        note({ phase: 'watch-closed', watchId, attemptId, reason: 'source-unavailable', ...conversationDiagnosticFrame(snapshot) })
        handle.dispose()
        for (const [source, error] of failures) current.failures.set(source, error)
        setState(value => ({ ...value, observationError: watchError(current.failures) }))
        return
      }
      current.handle = handle; current.observed = snapshot; current.failures = failures
      current.diagnosticWatchId = watchId
      note({ phase: 'watch-opened', watchId, attemptId, ...conversationDiagnosticFrame(snapshot) })
      setState(value => ({ ...value, observationError: watchError(failures) }))
      current.retryDelay = 100
      if (current.retryTimer) { clearTimeout(current.retryTimer); current.retryTimer = null }
      if (oldHandle && oldWatchId) note({ phase: 'watch-closed', watchId: oldWatchId, reason: 'navigation', ...(oldSnapshot ? conversationDiagnosticFrame(oldSnapshot) : {}) })
      oldHandle?.dispose(); if (oldSnapshot?.window.id !== snapshot.window.id) release(oldSnapshot)
      const installed = handle
      handle.closed.addEventListener('abort', () => {
        if (alive() && current.handle === installed) {
          note({ phase: 'watch-closed', watchId, reason: 'source-unavailable', ...conversationDiagnosticFrame(snapshot) })
          flush('failure')
          setState(value => ({ ...value, observationError: errorOf(installed.closed.reason ?? 'Conversation observation ended. The original window remains available.') }))
          reconnect()
        }
      }, { once: true })
      // The same physical-page checkpoint closes the read→watch interval.
      current.dirty = true
    }
    const read = (kind: Operation, selection: Selection = {}, recoverObservation = false): Promise<void> => {
      if (!alive()) return Promise.resolve()
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
      current.request?.abort()
      if (current.timer) { clearTimeout(current.timer); current.timer = null }
      const requestController = new AbortController(), requestSignal = requestController.signal
      current.request = requestController
      const attempt = { id: String(++attempts), operation: kind, superseded: false }
      current.attempt = attempt
      publishedDeferral = null
      const abortRead = () => requestController.abort(signal.reason)
      signal.addEventListener('abort', abortRead, { once: true })
      const isCurrent = () => alive() && current.request === requestController && !requestSignal.aborted
      const prior = current.snapshot
      const originalNative = prior?.scope.sources.find(source => source.kind === 'native')
      // This consumer assembles a complete bounded frame before committing it.
      // Use the existing wire budget instead of fragmenting it into CLI-sized pages.
      const request: ConversationTimelineReadInput = { ...ref, limit: 100, maxBytes: CONVERSATION_MAX_READ_BYTES,
        ...selection, ...(kind === 'reopen' && originalNative?.kind === 'native' ? { nativeSource: { providerId: originalNative.providerId, nativeSessionId: originalNative.nativeSessionId } } : {}),
        ...(kind === 'resume' && prior?.window.view ? { view: prior.window.view } : {}), ...(kind === 'older' && prior?.window.navigation.older ? { cursor: prior.window.navigation.older } : {}),
        ...(kind === 'newer' && prior?.window.navigation.newer ? { cursor: prior.window.navigation.newer } : {}) }
      const change: ConversationChangesInput | null = kind === 'changes' && prior ? {
        ...ref, checkpoint: prior.window.checkpoint, view: prior.window.view!, limit: 100, maxBytes: CONVERSATION_MAX_READ_BYTES
      } : null
      // Presentation follows this original request, never a retained frame's
      // source during an unqualified latest selection or a replay-only resume.
      const nativeSource = kind === 'resume' ? undefined : request.nativeSource ??
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
        try {
          let assembly: ConversationWindowAssembly | undefined, cursor: string | undefined
          let more = false
          do {
            const page = change ? await client.readConversationChanges({ ...change, ...(cursor ? { cursor } : {}) }, { signal: requestSignal })
              : await client.readAgentConversation({ ...request, ...(cursor ? { cursor, limit: 100 } : {}) }, { signal: requestSignal })
            if (!isCurrent()) return
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
          if (kind === 'reopen') {
            const failure = sourceReadError(complete)
            if (failure) throw failure
          }
          try { await bind(complete, isCurrent, recoverObservation || kind === 'resume', attempt.id) }
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
          const frame: PendingFrame = { snapshot: complete, historical: current.historical, operation: original?.operation ?? kind, selection: original?.selection ?? selection }
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
          retained.current = { client, key, snapshot: complete, historical: current.historical, pending: current.pending }
          const sourceError = sourceReadError(complete)
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
          note({ phase: 'read-failed', attemptId: attempt.id, operation: kind, reason: diagnosticErrorReason(error) })
          flush('failure')
          if (complete && complete.window.id !== current.snapshot?.window.id) release(complete)
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
          note({ phase: 'read-ended', attemptId: attempt.id, operation: kind,
            ...(requestSignal.aborted ? { reason: 'cancelled' as const } : {}) })
          flush('progress')
          signal.removeEventListener('abort', abortRead)
          if (!isCurrent()) { if (complete && complete.window.id !== current.snapshot?.window.id) release(complete); return }
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
      if (current.handle && current.diagnosticWatchId) note({ phase: 'watch-closed', watchId: current.diagnosticWatchId, reason: 'disposed', ...(current.observed ? conversationDiagnosticFrame(current.observed) : {}) })
      note({ phase: 'consumer-ended', reason: 'disposed' }); flush('release')
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

  const earlier = useCallback(async (limit?: number, options: Pick<ConversationTimelineReadInput, 'preserveCurrent'> = {}) => {
    await operation.current('older', { ...options, ...(limit === undefined ? {} : { limit }) }); return owner.current?.snapshot ?? null
  }, [])
  const newer = useCallback(async () => { await operation.current('newer'); return owner.current?.snapshot ?? null }, [])
  const selectSource = useCallback((nativeSource: NonNullable<ConversationTimelineReadInput['nativeSource']>) => operation.current('latest', { nativeSource }), [])
  const reveal = useCallback((anchor: NonNullable<ConversationTimelineReadInput['anchor']>) => operation.current('latest', { anchor }), [])
  const refresh = useCallback(() => operation.current('latest'), [])
  const resume = useCallback(() => operation.current(owner.current?.snapshot ? 'resume' : 'latest'), [])
  const settle = useCallback(async () => { const current = owner.current; await current?.inFlight; return owner.current === current ? current?.snapshot ?? null : null }, [])
  const changes = useCallback(() => operation.current('changes'), [])
  /** Instantaneous pointers to this mounted consumer; no read, retry or copied frame store. */
  const inspect = useCallback(() => {
    const accepted = committed.current, current = owner.current?.key === accepted.key ? owner.current : null
    return { ...accepted.state, snapshot: accepted.snapshot, loading: accepted.active && accepted.state.loading,
      error: accepted.state.error ?? accepted.state.sourceError,
      pending: current?.held ? current.snapshot : null,
      dirty: current?.dirty ?? null, inFlight: Boolean(current?.inFlight),
      watch: { binding: Boolean(current?.binding), bound: Boolean(current?.handle), closed: current?.handle?.closed.aborted ?? null,
        windowId: current?.observed?.window.id ?? null, invalidations: current?.invalidations ?? 0, unavailable: current?.unavailable ?? 0 } }
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
  return { ...state, error: state.error ?? state.sourceError, errorOperation: state.error ? state.errorOperation : null, snapshot, reading, loading: active && state.loading, hasMore: Boolean(snapshot?.window.navigation.older), hasNewer: Boolean(snapshot?.window.navigation.newer), earlier, newer, refresh, resume, settle, changes, retry, inspect, acceptHeld, selectSource, reveal, noteDiagnostic }
}
