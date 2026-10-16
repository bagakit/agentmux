import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { consumeConversationWindowPage, projectConversationWindow, conversationSourceKey, CONVERSATION_MAX_READ_BYTES, type ConversationWindowAssembly,
  type ConversationWindowSnapshot, type ConversationTimelineReadInput, type ConversationChangesInput,
  type ConversationObservationHandle, type ConversationRef } from '@agentmux/core/conversation'
import type { AgentMuxClient } from '@agentmux/core'

export type ConversationViewClient = Pick<AgentMuxClient, 'readAgentConversation' | 'readConversationChanges' | 'observeConversation' | 'releaseConversationView'>
export type ConversationViewOperation = 'latest' | 'older' | 'newer' | 'changes' | 'resume' | 'reopen'
type Operation = ConversationViewOperation
export type ConversationSourceRead = { reference: ConversationRef; nativeSource: NonNullable<ConversationTimelineReadInput['nativeSource']> }
type Selection = Pick<ConversationTimelineReadInput, 'nativeSource' | 'anchor'>
type ViewState = { snapshot: ConversationWindowSnapshot | null; loading: boolean; operation: Operation | null; sourceRead: ConversationSourceRead | null; error: Error | null; errorOperation: Operation | null; sourceError: Error | null; observationError: Error | null; held: boolean; historical: boolean; newerAvailable: boolean }
const empty = (): ViewState => ({ snapshot: null, loading: false, operation: null, sourceRead: null, error: null, errorOperation: null, sourceError: null, observationError: null, held: false, historical: false, newerAvailable: false })
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))
function sourceReadError(snapshot: ConversationWindowSnapshot): Error | null {
  const failures = snapshot.coverage.filter(source => source.current === 'unavailable')
  if (!failures.length) return null
  const message = failures.map(source => `${source.source.kind === 'captured' ? 'Captured' : 'Native'} conversation could not be read: ${source.gaps.map(gap => gap.message).join(' ')}`).join(' ')
  return Object.assign(new Error(`${message} Existing messages remain available.`), { code: 'AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE' })
}

/** Presentation lifetime for the original public Reader. The client retains only
 * complete accepted frames and transport assembly; Core owns source pages/joins. */
export function useConversationView(client: ConversationViewClient | null, reference: ConversationRef | undefined, active: boolean,
  options: { identity?: string; beforeCommit?(snapshot: ConversationWindowSnapshot, operation: Operation): boolean } = {}) {
  const key = reference ? JSON.stringify([reference.hostId, reference.agentSessionId, options.identity]) : ''
  const [state, setState] = useState<ViewState>(empty)
  const snapshot = state.snapshot && reference && state.snapshot.hostId === reference.hostId && state.snapshot.agentSessionId === reference.agentSessionId ? state.snapshot : null
  const committed = useRef({ state, key, snapshot, active })
  useLayoutEffect(() => { committed.current = { state, key, snapshot, active } }, [state, key, snapshot, active])
  const owner = useRef<{ key: string; controller: AbortController; snapshot: ConversationWindowSnapshot | null;
    request: AbortController | null; handle: ConversationObservationHandle | null; observed: ConversationWindowSnapshot | null; inFlight: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null;
    retryTimer: ReturnType<typeof setTimeout> | null; retryDelay: number; historical: boolean; dirty: boolean; held: boolean;
    binding: ConversationWindowSnapshot | null; invalidations: number; unavailable: number } | null>(null)
  const retained = useRef<{ client: ConversationViewClient; key: string; snapshot: ConversationWindowSnapshot; historical: boolean } | null>(null)
  const beforeCommit = useRef(options.beforeCommit); beforeCommit.current = options.beforeCommit
  const operation = useRef<(kind: Operation, selection?: Selection) => Promise<void>>(async () => {})
  const retryOperation = useRef<{ client: ConversationViewClient | null; key: string; kind: Operation; selection: Selection }>({ client, key, kind: 'latest', selection: {} })

  useEffect(() => {
    if (!active || !reference || !client) return
    const ref = { hostId: reference.hostId, agentSessionId: reference.agentSessionId }
    const parked = retained.current?.key === key && retained.current.client === client ? retained.current : null
    if (retryOperation.current.client !== client || retryOperation.current.key !== key) retryOperation.current = { client, key, kind: 'latest', selection: {} }
    const current = { key, controller: new AbortController(), snapshot: parked?.snapshot ?? null as ConversationWindowSnapshot | null,
      request: null as AbortController | null, handle: null as ConversationObservationHandle | null, observed: null as ConversationWindowSnapshot | null, inFlight: null as Promise<void> | null,
      timer: null as ReturnType<typeof setTimeout> | null, retryTimer: null as ReturnType<typeof setTimeout> | null, retryDelay: 100,
      historical: parked?.historical ?? false, dirty: false, held: false,
      binding: null as ConversationWindowSnapshot | null, invalidations: 0, unavailable: 0 }
    owner.current = current
    setState(value => value.snapshot?.hostId === reference.hostId && value.snapshot.agentSessionId === reference.agentSessionId
      ? { ...value, loading: true, operation: parked ? 'resume' : 'latest', sourceRead: null } : { ...empty(), loading: true, operation: 'latest' })
    const signal = current.controller.signal
    const alive = () => owner.current === current && !signal.aborted
    const schedule = () => {
      current.dirty = true
      if (!alive() || current.inFlight || current.timer || current.held || current.historical) return
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
    const bind = async (snapshot: ConversationWindowSnapshot, isCurrent: () => boolean) => {
      if (current.handle && !current.handle.closed.aborted && current.observed?.window.id === snapshot.window.id) return
      const oldHandle = current.handle, oldSnapshot = current.observed
      current.binding = snapshot
      let handle: ConversationObservationHandle
      try { handle = await client.observeConversation({ ...ref, view: snapshot.window.view! }, observation => {
        if (!alive()) return
        if (observation.kind === 'unavailable') current.unavailable++
        else current.invalidations++
        if (observation.kind === 'unavailable') setState(value => ({ ...value, observationError: Object.assign(new Error(observation.message), { code: observation.code }) }))
        else {
          setState(value => ({ ...value, observationError: null, newerAvailable: current.historical || current.held || value.newerAvailable }))
          schedule()
        }
      }, { signal }) } finally { if (current.binding === snapshot) current.binding = null }
      if (!isCurrent()) { handle.dispose(); if (snapshot.window.id !== current.snapshot?.window.id) release(snapshot); return }
      if (handle.sourceHostId !== snapshot.sourceHostId || handle.scope.sources.length !== snapshot.scope.sources.length ||
        handle.scope.sources.some(source => !snapshot.scope.sources.some(original => conversationSourceKey(source) === conversationSourceKey(original)))) {
        handle.dispose(); throw Object.assign(new Error('The observation returned another original source scope. The accepted frame is retained.'), { code: 'CONTROL_PROTOCOL_ERROR' })
      }
      current.handle = handle; current.observed = snapshot
      current.retryDelay = 100
      if (current.retryTimer) { clearTimeout(current.retryTimer); current.retryTimer = null }
      oldHandle?.dispose(); if (oldSnapshot?.window.id !== snapshot.window.id) release(oldSnapshot)
      handle.closed.addEventListener('abort', () => {
        if (alive() && current.handle === handle) {
          setState(value => ({ ...value, observationError: errorOf(handle.closed.reason ?? 'Conversation observation ended. The original window remains available.') }))
          reconnect()
        }
      }, { once: true })
      // The same physical-page checkpoint closes the read→watch interval.
      current.dirty = true
    }
    const read = (kind: Operation, selection: Selection = {}): Promise<void> => {
      if (!alive()) return Promise.resolve()
      if (current.inFlight && (kind === 'changes' || kind === 'resume')) return current.inFlight
      if (kind !== 'latest' && !current.snapshot || kind === 'older' && !current.snapshot?.window.navigation.older || kind === 'newer' && !current.snapshot?.window.navigation.newer) return Promise.resolve()
      // An explicit navigation replaces only the related read, never its Run or
      // accepted frame. A late superseded reply cannot bind or commit a window.
      current.request?.abort()
      if (current.timer) { clearTimeout(current.timer); current.timer = null }
      const requestController = new AbortController(), requestSignal = requestController.signal
      current.request = requestController
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
              : await client.readAgentConversation({ ...request, ...(cursor ? { cursor } : {}) }, { signal: requestSignal })
            if (!isCurrent()) return
            const result = consumeConversationWindowPage(page, assembly)
            if (result.kind === 'complete') { complete = result.snapshot; more = 'more' in page && Boolean(page.more); break }
            assembly = result.pending
            if (!page.nextCursor || page.nextCursor === cursor) throw new Error('The original conversation window did not complete. Its displayed records are kept.')
            cursor = page.nextCursor
          } while (true)
          if (!isCurrent() || !complete) return
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
          try { await bind(complete, isCurrent) }
          catch (error) { if (isCurrent()) { setState(value => ({ ...value, observationError: errorOf(error) })); reconnect() } }
          if (!isCurrent()) return
          current.snapshot = complete
          const wasHistorical = current.historical
          current.historical = Boolean(complete.window.anchor || complete.window.navigation.newer)
          // Preloading older pages does not close a still-retained source head.
          // Returning from an evicted-head window must catch up its original cut.
          if (wasHistorical && !current.historical) current.dirty = true
          retained.current = { client, key, snapshot: complete, historical: current.historical }
          current.held = beforeCommit.current?.(complete, kind) === false
          const sourceError = sourceReadError(complete)
          // Resume replays the retained frame. It cannot replace the failed cut's
          // retry intent with another replay of that same unavailable coverage.
          if (sourceError && kind !== 'resume') retryOperation.current = { client, key, kind, selection }
          setState(value => ({ ...value, ...(current.held ? {} : { snapshot: complete }), held: current.held,
            // A live update or retained-frame replay does not fulfill a failed
            // navigation. Resolve only its operation, a new explicit cut, or
            // replace it with the current frame's actual source failure.
            ...(sourceError || kind === 'latest' || kind === 'reopen' || value.errorOperation === kind ? { error: null, errorOperation: null } : {}),
            sourceError, historical: current.historical, newerAvailable: kind === 'latest' || kind === 'changes' && !more && !current.held && !current.historical ? false : value.newerAvailable }))
          if (more) current.dirty = true
        } catch (error) { if (isCurrent()) {
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
          signal.removeEventListener('abort', abortRead)
          if (!isCurrent()) { if (complete && complete.window.id !== current.snapshot?.window.id) release(complete); return }
          current.inFlight = null
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

  const earlier = useCallback(async () => { await operation.current('older'); return owner.current?.snapshot ?? null }, [])
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
  const retry = useCallback(() => operation.current(retryOperation.current.kind, retryOperation.current.selection), [])
  const acceptHeld = useCallback(() => {
    const current = owner.current
    if (!current?.held || !current.snapshot || beforeCommit.current?.(current.snapshot, 'changes') === false) return
    current.held = false
    setState(value => ({ ...value, snapshot: current.snapshot, held: false,
      newerAvailable: current.historical || current.dirty ? value.newerAvailable : false }))
    if (current.dirty && !current.historical) void operation.current('changes')
  }, [])
  const reading = useMemo(() => snapshot ? projectConversationWindow(snapshot) : null, [snapshot])
  return { ...state, error: state.error ?? state.sourceError, errorOperation: state.error ? state.errorOperation : null, snapshot, reading, loading: active && state.loading, hasMore: Boolean(snapshot?.window.navigation.older), hasNewer: Boolean(snapshot?.window.navigation.newer), earlier, newer, refresh, resume, settle, changes, retry, inspect, acceptHeld, selectSource, reveal }
}
