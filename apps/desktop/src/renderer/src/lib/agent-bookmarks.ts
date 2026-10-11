import { api } from './api'

export const AGENT_BOOKMARK_STORAGE_KEY = 'agentmux.agent-bookmarks.v1'
export type AgentBookmarkBounds = { x: number; y: number; width: number; height: number }
export type AgentBookmark = {
  key: string
  hostId: string
  agentSessionId: string
  /** A display hint only. Current control and Run must be resolved by the live consumer. */
  presentationId: string
  label: string
  workspaceName: string
  excerpt?: string | undefined
  excerptTruncated?: boolean | undefined
  bounds: AgentBookmarkBounds
}
export type AgentBookmarkSnapshot = Pick<AgentBookmark, 'label' | 'workspaceName' | 'excerpt' | 'excerptTruncated'>
export type AgentBookmarkState = {
  /** Last entry is frontmost. No time or execution identity is inferred from this order. */
  bookmarks: readonly AgentBookmark[]
  persistenceIssue: { phase: 'read' | 'write' | 'flush'; message: string } | null
}
type BookmarkInput = Omit<AgentBookmark, 'key'>
type BookmarkStorage = Pick<Storage, 'getItem' | 'setItem'>
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const identity = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
const finiteBounds = (value: unknown): value is AgentBookmarkBounds => record(value) &&
  ['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) &&
  (value.width as number) > 0 && (value.height as number) > 0
export const agentBookmarkKey = (hostId: string, agentSessionId: string): string => JSON.stringify([hostId, agentSessionId])
function boundedSnapshot(input: AgentBookmarkSnapshot): AgentBookmarkSnapshot {
  return { label: input.label.slice(0, 512), workspaceName: input.workspaceName.slice(0, 512),
    ...(input.excerpt === undefined ? {} : { excerpt: input.excerpt.slice(0, 4096),
      ...(input.excerptTruncated || input.excerpt.length > 4096 ? { excerptTruncated: true } : {}) }) }
}
function bookmark(input: BookmarkInput): AgentBookmark | null {
  if (!identity(input.hostId) || !identity(input.agentSessionId) || !identity(input.presentationId) ||
    typeof input.label !== 'string' || typeof input.workspaceName !== 'string' ||
    input.excerpt !== undefined && typeof input.excerpt !== 'string' ||
    input.excerptTruncated !== undefined && typeof input.excerptTruncated !== 'boolean' || !finiteBounds(input.bounds)) return null
  return { key: agentBookmarkKey(input.hostId, input.agentSessionId), hostId: input.hostId, agentSessionId: input.agentSessionId,
    presentationId: input.presentationId, ...boundedSnapshot(input),
    bounds: { x: input.bounds.x, y: input.bounds.y, width: input.bounds.width, height: input.bounds.height } }
}
function readBookmarks(bytes: string | null): { bookmarks: AgentBookmark[]; complete: boolean } {
  if (bytes === null) return { bookmarks: [], complete: true }
  const value: unknown = JSON.parse(bytes)
  if (!record(value) || value.version !== 1 || !Array.isArray(value.bookmarks)) throw new Error('Saved bookmark format is unconfirmed.')
  const bookmarks: AgentBookmark[] = [], keys = new Set<string>()
  let complete = true
  for (const candidate of value.bookmarks) {
    if (!record(candidate)) { complete = false; continue }
    const item = bookmark(candidate as unknown as BookmarkInput)
    if (!item || candidate.key !== item.key || keys.has(item.key) ||
      candidate.label !== item.label || candidate.workspaceName !== item.workspaceName || candidate.excerpt !== item.excerpt) { complete = false; continue }
    keys.add(item.key); bookmarks.push(item)
  }
  return { bookmarks, complete }
}

/** Independent presentation preferences only: no Session directory, control, reader or Runtime owner. */
export function createAgentBookmarks(options: { storage: BookmarkStorage; flush(): Promise<void> }) {
  let state: AgentBookmarkState | undefined, readConfirmed = false, dirty = false, revision = 0, request = 0
  let lastWritten: string | undefined, timer: ReturnType<typeof setTimeout> | undefined, inFlight: Promise<void> | undefined
  const listeners = new Set<() => void>()
  // Only edits made while original saved bytes are unreadable need an overlay on a successful retry.
  const unreadEdits = new Map<string, AgentBookmark | null>()
  const readIssue = () => ({ phase: 'read' as const, message: 'Saved Agent bookmarks could not be fully read. Original storage is kept; current bookmarks remain available. Retry saved bookmarks.' })
  function publish(next: AgentBookmarkState) { state = next; for (const listener of listeners) listener() }
  function get(): AgentBookmarkState {
    if (state) return state
    try {
      const restored = readBookmarks(options.storage.getItem(AGENT_BOOKMARK_STORAGE_KEY))
      readConfirmed = restored.complete
      state = { bookmarks: restored.bookmarks, persistenceIssue: restored.complete ? null : readIssue() }
    } catch { state = { bookmarks: [], persistenceIssue: readIssue() } }
    return state
  }
  function issue(phase: 'write' | 'flush', cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    publish({ ...get(), persistenceIssue: { phase, message: phase === 'write'
      ? `Agent bookmarks could not be saved. This window keeps them; retry saving. ${detail}`
      : `Agent bookmarks were written locally, but the storage flush request is unconfirmed. Retry saving. ${detail}` } })
  }
  function clearTimer() { clearTimeout(timer); timer = undefined }
  async function flush(): Promise<void> {
    clearTimer()
    const current = get()
    if (!readConfirmed) return
    if (!dirty && !current.persistenceIssue) { await inFlight; return }
    const ownRevision = revision, ownRequest = ++request
    try {
      const bytes = JSON.stringify({ version: 1, bookmarks: current.bookmarks })
      if (bytes !== lastWritten) { options.storage.setItem(AGENT_BOOKMARK_STORAGE_KEY, bytes); lastWritten = bytes }
      dirty = false
    } catch (cause) { if (ownRequest === request && ownRevision === revision) issue('write', cause); return }
    const work = (async () => {
      try {
        // This acknowledges a request to Chromium, never a disk/fsync receipt.
        await options.flush()
        if (ownRequest === request && ownRevision === revision && !dirty && get().persistenceIssue) publish({ ...get(), persistenceIssue: null })
      } catch (cause) { if (ownRequest === request && ownRevision === revision) issue('flush', cause) }
    })()
    inFlight = work
    await work
    if (inFlight === work) inFlight = undefined
  }
  function changed(bookmarks: readonly AgentBookmark[], edits: readonly [string, AgentBookmark | null][]) {
    const current = get()
    if (JSON.stringify(current.bookmarks) === JSON.stringify(bookmarks)) return
    revision++; dirty = true
    if (!readConfirmed) for (const [key, value] of edits) unreadEdits.set(key, value)
    publish({ ...current, bookmarks })
    clearTimer()
    if (readConfirmed) timer = setTimeout(() => { void flush() }, 200)
  }
  function replace(key: string, next: AgentBookmark | null, front = false) {
    const entries = get().bookmarks, index = entries.findIndex(item => item.key === key)
    if (index < 0 && !next) {
      if (!readConfirmed) unreadEdits.set(key, null)
      return
    }
    const bookmarks = entries.filter(item => item.key !== key)
    if (next) bookmarks.splice(front || index < 0 ? bookmarks.length : index, 0, next)
    changed(bookmarks, [[key, next]])
  }
  async function retry(): Promise<void> {
    if (!readConfirmed) {
      try {
        const restored = readBookmarks(options.storage.getItem(AGENT_BOOKMARK_STORAGE_KEY))
        const bookmarks = restored.bookmarks.filter(item => !unreadEdits.has(item.key))
        for (const item of unreadEdits.values()) if (item) bookmarks.push(item)
        if (!restored.complete) { publish({ bookmarks, persistenceIssue: readIssue() }); return }
        readConfirmed = true; unreadEdits.clear(); revision++; dirty = true
        publish({ bookmarks, persistenceIssue: null })
      } catch { publish({ ...get(), persistenceIssue: readIssue() }); return }
    }
    await flush()
  }
  let lifecycle: { host: Window; dispose(): void } | undefined
  const owner = {
    get,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    pin(input: BookmarkInput): string | null {
      const next = bookmark(input)
      if (!next) return null
      // A second presentation only raises the existing bookmark; it cannot replace protected reading.
      const previous = get().bookmarks.find(item => item.key === next.key)
      replace(next.key, previous ?? next, true)
      return next.key
    },
    remove(key: string) { replace(key, null) },
    setBounds(key: string, bounds: AgentBookmarkBounds) {
      if (!finiteBounds(bounds)) return
      const previous = get().bookmarks.find(item => item.key === key)
      if (previous) replace(key, { ...previous, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } })
    },
    bringToFront(key: string) { const previous = get().bookmarks.find(item => item.key === key); if (previous) replace(key, previous, true) },
    updateSnapshot(key: string, input: AgentBookmarkSnapshot) {
      const previous = get().bookmarks.find(item => item.key === key)
      if (!previous || typeof input.label !== 'string' || typeof input.workspaceName !== 'string' || input.excerpt !== undefined && typeof input.excerpt !== 'string') return
      const { label: _label, workspaceName: _workspace, excerpt: _excerpt, excerptTruncated: _truncated, ...identity } = previous
      replace(key, { ...identity, ...boundedSnapshot(input) })
    },
    retry,
    flush,
    startLifecycle(host: Window = window): () => void {
      if (lifecycle?.host === host) return lifecycle.dispose
      lifecycle?.dispose(); get()
      const onUnload = () => { void flush() }
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        host.removeEventListener('pagehide', onUnload); host.removeEventListener('beforeunload', onUnload)
        if (lifecycle?.dispose === dispose) lifecycle = undefined
        clearTimer(); void flush()
      }
      host.addEventListener('pagehide', onUnload); host.addEventListener('beforeunload', onUnload)
      lifecycle = { host, dispose }; return dispose
    },
    stopLifecycle() { if (lifecycle) lifecycle.dispose(); else { clearTimer(); void flush() } }
  }
  return owner
}

export const agentBookmarks = createAgentBookmarks({
  storage: { getItem: key => typeof window === 'undefined' ? null : window.localStorage.getItem(key),
    setItem: (key, value) => { window.localStorage.setItem(key, value) } },
  flush: () => api.ui.requestStorageFlush()
})
