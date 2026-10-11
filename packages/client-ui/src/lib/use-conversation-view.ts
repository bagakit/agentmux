import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { consumeConversationWindowPage, projectConversationWindow, conversationSourceKey, type ConversationWindowAssembly,
  type ConversationWindowSnapshot, type ConversationTimelineReadInput, type ConversationChangesInput,
  type ConversationObservationHandle, type ConversationRef } from '@agentmux/core/conversation'
import type { AgentMuxClient } from '@agentmux/core'

export type ConversationViewClient = Pick<AgentMuxClient, 'readAgentConversation' | 'readConversationChanges' | 'observeConversation' | 'releaseConversationView'>
export type ConversationViewOperation = 'latest' | 'older' | 'newer' | 'changes' | 'resume'
type Operation = ConversationViewOperation
type Selection = Pick<ConversationTimelineReadInput, 'nativeSource' | 'anchor'>
type ViewState = { snapshot: ConversationWindowSnapshot | null; loading: boolean; error: Error | null; observationError: Error | null; held: boolean; historical: boolean; newerAvailable: boolean }
const empty = (): ViewState => ({ snapshot: null, loading: false, error: null, observationError: null, held: false, historical: false, newerAvailable: false })
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))

/** Presentation lifetime for the original public Reader. The client retains only
 * complete accepted frames and transport assembly; Core owns source pages/joins. */
export function useConversationView(client: ConversationViewClient | null, reference: ConversationRef | undefined, active: boolean,
  options: { identity?: string; beforeCommit?(snapshot: ConversationWindowSnapshot, operation: Operation): boolean } = {}) {
  const key = reference ? JSON.stringify([reference.hostId, reference.agentSessionId, options.identity]) : ''
  const [state, setState] = useState<ViewState>(empty)
  const owner = useRef<{ key: string; controller: AbortController; snapshot: ConversationWindowSnapshot | null;
    request: AbortController | null; handle: ConversationObservationHandle | null; observed: ConversationWindowSnapshot | null; inFlight: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null;
    retryTimer: ReturnType<typeof setTimeout> | null; retryDelay: number; historical: boolean; dirty: boolean; held: boolean } | null>(null)
  const retained = useRef<{ client: ConversationViewClient; key: string; snapshot: ConversationWindowSnapshot; historical: boolean } | null>(null)
  const beforeCommit = useRef(options.beforeCommit); beforeCommit.current = options.beforeCommit
  const operation = useRef<(kind: Operation, selection?: Selection) => Promise<void>>(async () => {})

  useEffect(() => {
    if (!active || !reference || !client) return
    const ref = { hostId: reference.hostId, agentSessionId: reference.agentSessionId }
    const parked = retained.current?.key === key && retained.current.client === client ? retained.current : null
    const current = { key, controller: new AbortController(), snapshot: parked?.snapshot ?? null as ConversationWindowSnapshot | null,
      request: null as AbortController | null, handle: null as ConversationObservationHandle | null, observed: null as ConversationWindowSnapshot | null, inFlight: null as Promise<void> | null,
      timer: null as ReturnType<typeof setTimeout> | null, retryTimer: null as ReturnType<typeof setTimeout> | null, retryDelay: 100,
      historical: parked?.historical ?? false, dirty: false, held: false }
    owner.current = current
    setState(value => value.snapshot?.hostId === reference.hostId && value.snapshot.agentSessionId === reference.agentSessionId
      ? { ...value, loading: true, error: null } : { ...empty(), loading: true })
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
      // Expired views keep their originals and require an explicit new read.
      current.retryTimer = setTimeout(() => { current.retryTimer = null; void read('resume') }, current.retryDelay)
      current.retryDelay = Math.min(current.retryDelay * 2, 5000)
    }
    const bind = async (snapshot: ConversationWindowSnapshot, isCurrent: () => boolean) => {
      if (current.handle && !current.handle.closed.aborted && current.observed?.window.id === snapshot.window.id) return
      const oldHandle = current.handle, oldSnapshot = current.observed
      const handle = await client.observeConversation({ ...ref, view: snapshot.window.view! }, observation => {
        if (!alive()) return
        if (observation.kind === 'unavailable') setState(value => ({ ...value, observationError: Object.assign(new Error(observation.message), { code: observation.code }) }))
        else {
          setState(value => ({ ...value, observationError: null, newerAvailable: current.historical || current.held || value.newerAvailable }))
          schedule()
        }
      }, { signal })
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
      const request: ConversationTimelineReadInput = { ...ref, limit: 100,
        ...selection, ...(kind === 'resume' && prior?.window.view ? { view: prior.window.view } : {}), ...(kind === 'older' && prior?.window.navigation.older ? { cursor: prior.window.navigation.older } : {}),
        ...(kind === 'newer' && prior?.window.navigation.newer ? { cursor: prior.window.navigation.newer } : {}) }
      const change: ConversationChangesInput | null = kind === 'changes' && prior ? {
        ...ref, checkpoint: prior.window.checkpoint, view: prior.window.view!, limit: 100
      } : null
      setState(value => ({ ...value, loading: true, error: null }))
      if (kind === 'changes' || kind === 'latest') current.dirty = false
      const pending = (async () => {
        let complete: ConversationWindowSnapshot | null = null
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
              complete.window.id !== prior.window.id || complete.scope.sources.length !== prior.scope.sources.length ||
              complete.scope.sources.some(source => !prior.scope.sources.some(original => conversationSourceKey(source) === conversationSourceKey(original))))
              throw Object.assign(new Error('The original conversation scope changed. Its displayed frame and position are retained.'), { code: 'CONTROL_PROTOCOL_ERROR' })
            if (complete.window.revision < prior.window.revision) throw Object.assign(new Error('This response predates the accepted conversation frame. Its displayed originals are retained.'), { code: 'CONTROL_PROTOCOL_ERROR' })
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
          setState(value => ({ ...value, ...(current.held ? {} : { snapshot: complete }), held: current.held,
            historical: current.historical, newerAvailable: kind === 'latest' || kind === 'changes' && !more && !current.held && !current.historical ? false : value.newerAvailable }))
          if (more) current.dirty = true
        } catch (error) { if (isCurrent()) {
          setState(value => ({ ...value, error: errorOf(error) }))
          const code = (error as { code?: string })?.code
          if (kind === 'resume' && ['CONTROL_UNAVAILABLE', 'CONTROL_TIMEOUT'].includes(code ?? '')) reconnect()
        } }
        finally {
          signal.removeEventListener('abort', abortRead)
          if (!isCurrent()) { if (complete && complete.window.id !== current.snapshot?.window.id) release(complete); return }
          current.inFlight = null
          setState(value => ({ ...value, loading: false }))
          if (current.dirty) schedule()
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
  const acceptHeld = useCallback(() => {
    const current = owner.current
    if (!current?.held || !current.snapshot || beforeCommit.current?.(current.snapshot, 'changes') === false) return
    current.held = false
    setState(value => ({ ...value, snapshot: current.snapshot, held: false,
      newerAvailable: current.historical || current.dirty ? value.newerAvailable : false }))
    if (current.dirty && !current.historical) void operation.current('changes')
  }, [])
  const snapshot = state.snapshot && reference && state.snapshot.hostId === reference.hostId && state.snapshot.agentSessionId === reference.agentSessionId ? state.snapshot : null
  const reading = useMemo(() => snapshot ? projectConversationWindow(snapshot) : null, [snapshot])
  return { ...state, snapshot, reading, loading: active && state.loading, hasMore: Boolean(snapshot?.window.navigation.older), hasNewer: Boolean(snapshot?.window.navigation.newer), earlier, newer, refresh, resume, settle, changes, acceptHeld, selectSource, reveal }
}
