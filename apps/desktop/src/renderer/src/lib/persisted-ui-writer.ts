import type { StateStorage } from 'zustand/middleware'

// A layout drag (dock resize, split-ratio, tab reorder) fires many state changes per second, and the
// old storage wrote localStorage synchronously on every one. Coalesce them: the newest value per key
// lands once, this long after activity settles. The window it opens — a change living only in memory —
// is closed by `flush`, which an unload handler calls so a hard shutdown mid-drag still keeps it.
const DEFAULT_DEBOUNCE_MS = 400

type FlushablePersistentStorage = {
  storage: StateStorage
  /** Write any debounced value to the base storage now. A no-op when nothing is pending. */
  flush: () => void
}

/**
 * Wrap a base StateStorage so writes are trailing-debounced instead of synchronous per change. Reads
 * and removes pass straight through — only writes are deferred, because only writes are the frequent,
 * coalescable operation. The base is still the authority on whether a write actually lands (the write
 * fence lives there); this layer only decides *when* the base is asked.
 */
export function createDebouncedPersistentStorage(
  base: StateStorage,
  delayMs: number = DEFAULT_DEBOUNCE_MS
): FlushablePersistentStorage {
  // Keyed by storage name: a later setItem for a key overwrites its pending value rather than queuing
  // a second write, and a removeItem drops any pending value so it cannot resurrect after deletion.
  const pending = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const writePending = (): void => {
    timer = null
    for (const [name, value] of pending) base.setItem(name, value)
    pending.clear()
  }

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    writePending()
  }

  const storage: StateStorage = {
    getItem: (name) => base.getItem(name),
    setItem: (name, value) => {
      pending.set(name, value)
      // Trailing debounce: reset the clock on each change so the write lands after the gesture ends,
      // not once per frame during it.
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(writePending, delayMs)
    },
    removeItem: (name) => {
      pending.delete(name)
      base.removeItem(name)
    }
  }

  return { storage, flush }
}

/**
 * Register the unload trailing flush. `pagehide` is the reliable modern signal — it fires on tab
 * close, navigation, and app quit, including the bfcache path where `beforeunload` may not — and
 * `beforeunload` is kept as a fallback for environments that skip it. Returns a disposer; a call in a
 * non-DOM environment is a no-op so the store module can import this unconditionally.
 */
export function registerUnloadFlush(flush: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onUnload = (): void => flush()
  window.addEventListener('pagehide', onUnload)
  window.addEventListener('beforeunload', onUnload)
  return () => {
    window.removeEventListener('pagehide', onUnload)
    window.removeEventListener('beforeunload', onUnload)
  }
}
