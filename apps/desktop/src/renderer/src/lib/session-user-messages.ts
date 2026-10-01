import { useEffect, useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { AgentSessionHistoryPage, AgentSessionUserMessage, AgentSessionHistoryObservationHandle } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from './api'
import { useAppStore } from '../store'

export type AgentSessionControlInput = AgentSessionControl

const MAX_NATIVE_RECORDS = 90
const MAX_NATIVE_BYTES = 12 * 1024 * 1024
const MAX_REVALIDATION_PAGES = 3
type ReadMode = 'initial' | 'earlier' | 'revalidate' | 'replace'

type SessionEntry = {
  key: string
  hostId: string
  agentSessionId: string
  runId: string
  consumerCount: number
  subscribers: Set<() => void>
  historyPage: AgentSessionHistoryPage | null
  items: AgentSessionHistoryPage['items']
  nextCursor: string | null
  loading: boolean
  error: Error | null
  inFlight: Promise<AgentSessionHistoryPage | null> | null
  version: number
  consumerLifetimeId: number
  queuedRefresh: ReadMode | null
  observationController: AbortController | null
  observationHandle: AgentSessionHistoryObservationHandle | null
  observationReady: Promise<void> | null
  observationError: Error | null
  windowFrozen: boolean
  refreshTimer: ReturnType<typeof setTimeout> | null
}

const sessionRegistry = new Map<string, SessionEntry>()

function encodeSegment(s: string): string {
  return s.replace(/%/g, '%25').replace(/:/g, '%3A')
}

function makeSessionControlKey(control: AgentSessionControlInput): string {
  return `${encodeSegment(control.hostId)}:${encodeSegment(control.agentSessionId)}:${encodeSegment(control.run.runId)}`
}

function getOrCreateEntry(control: AgentSessionControlInput): SessionEntry {
  const key = makeSessionControlKey(control)
  let entry = sessionRegistry.get(key)
  if (!entry) {
    entry = {
      key,
      hostId: control.hostId,
      agentSessionId: control.agentSessionId,
      runId: control.run.runId,
      consumerCount: 0,
      subscribers: new Set(),
      historyPage: null,
      items: [],
      nextCursor: null,
      loading: false,
      error: null,
      inFlight: null,
      version: 0,
      consumerLifetimeId: 0,
      queuedRefresh: null,
      observationController: null,
      observationHandle: null,
      observationReady: null,
      observationError: null,
      windowFrozen: false,
      refreshTimer: null
    }
    sessionRegistry.set(key, entry)
  }
  return entry
}

function notifySubscribers(entry: SessionEntry) {
  entry.version++
  for (const listener of entry.subscribers) {
    listener()
  }
}

function sameSource(a: AgentSessionHistoryPage['source'], b: AgentSessionHistoryPage['source']): boolean {
  return a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId
}

function withinWindow(items: AgentSessionHistoryPage['items']): boolean {
  if (items.length > MAX_NATIVE_RECORDS) return false
  let bytes = 0
  for (const item of items) {
    bytes += new TextEncoder().encode(JSON.stringify(item)).byteLength
    if (bytes > MAX_NATIVE_BYTES) return false
  }
  return true
}

function pauseEntry(entry: SessionEntry): void {
  entry.consumerLifetimeId++
  entry.observationController?.abort()
  entry.observationHandle?.dispose()
  entry.observationController = null
  entry.observationHandle = null
  entry.observationReady = null
  if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
  entry.refreshTimer = null
  entry.queuedRefresh = null
  entry.inFlight = null
  entry.loading = false
}

function scheduleRevalidation(control: AgentSessionControlInput, entry: SessionEntry): void {
  if (entry.windowFrozen || !entry.subscribers.size || entry.refreshTimer) return
  // One short burst timer per actual observed source, never a poll.
  entry.refreshTimer = setTimeout(() => {
    entry.refreshTimer = null
    if (!entry.subscribers.size || entry.windowFrozen) return
    void fetchSessionHistoryPage(control, entry, 'revalidate')
  }, 50)
}

function observeEntry(control: AgentSessionControlInput, entry: SessionEntry, replacing = false): Promise<void> {
  if (entry.observationReady) return entry.observationReady
  const controller = new AbortController()
  const lifetime = entry.consumerLifetimeId
  entry.observationController = controller
  entry.observationError = null
  const current = (): boolean => !controller.signal.aborted && entry.observationController === controller &&
    entry.consumerLifetimeId === lifetime && entry.subscribers.size > 0
  const acquiring = (async () => {
    try {
      const handle = await api.sessions.observeHistory(control, observation => {
        if (!current() || observation.agentSessionId !== entry.agentSessionId) return
        if (observation.kind === 'unavailable') {
          entry.observationError = Object.assign(new Error(observation.message), { code: observation.code })
          entry.observationHandle?.dispose()
          entry.observationHandle = null
          notifySubscribers(entry)
          return
        }
        const source = entry.observationHandle?.source
        if (source && !sameSource(source, observation.source)) {
          entry.observationError = new Error('Native source changed. The current window is kept; refresh its source.')
          notifySubscribers(entry)
          return
        }
        scheduleRevalidation(control, entry)
      }, { signal: controller.signal })
      if (!current()) { handle.dispose(); return }
      if (!replacing && entry.historyPage && !sameSource(entry.historyPage.source, handle.source)) {
        handle.dispose()
        entry.observationError = new Error('Native source changed. The current window is kept; refresh its source.')
      } else if (entry.observationError) handle.dispose()
      else entry.observationHandle = handle
    } catch (error) {
      if (current()) entry.observationError = error instanceof Error ? error : new Error(String(error))
    } finally {
      if (current()) notifySubscribers(entry)
    }
  })()
  entry.observationReady = acquiring
  return acquiring
}

async function fetchSessionHistoryPage(
  control: AgentSessionControlInput,
  entry: SessionEntry,
  mode: ReadMode = 'initial'
): Promise<AgentSessionHistoryPage | null> {
  if (entry.inFlight) {
    if (mode === 'replace' || mode === 'revalidate') {
      if (entry.queuedRefresh !== 'replace') entry.queuedRefresh = mode
    }
    return entry.inFlight
  }
  if (!entry.subscribers.size || (mode !== 'replace' && entry.windowFrozen)) return entry.historyPage
  const lifetime = entry.consumerLifetimeId
  const current = (): boolean => entry.subscribers.size > 0 && lifetime === entry.consumerLifetimeId
  entry.loading = true
  entry.error = null
  notifySubscribers(entry)
  const promise = (async () => {
    try {
      // Establish the source watch (or its explicit degraded result) before the
      // first read, so append between acquisition and read cannot be lost.
      await observeEntry(control, entry, mode === 'replace')
      if (!current()) return null
      const read = async (cursor?: string): Promise<AgentSessionHistoryPage> => {
        const page = await api.sessions.historyPage(control, { limit: 30, ...(cursor ? { cursor } : {}) })
        if (page.agentSessionId !== entry.agentSessionId) throw new Error('Native page belongs to another Session.')
        if (entry.observationHandle && !sameSource(entry.observationHandle.source, page.source)) {
          throw new Error('Native source changed after observation was established. Refresh its source.')
        }
        if (entry.historyPage && mode !== 'replace' && !sameSource(entry.historyPage.source, page.source)) {
          throw new Error('Native source changed. The current window is kept; refresh its source.')
        }
        return page
      }
      let page = await read(mode === 'earlier' ? entry.nextCursor ?? undefined : undefined)
      if (!current()) return null
      let items = page.items
      let nextCursor = page.nextCursor
      let windowLimitError: Error | null = null
      if (mode === 'initial' || mode === 'replace') {
        if (!withinWindow(items)) throw new Error('The native page exceeds the reading window budget. Earlier records remain available in History.')
        // Find input context only when opening a window. Process records can
        // occupy the latest page; keep every accepted page and its real cursor.
        for (let pages = 1; nextCursor && pages < MAX_REVALIDATION_PAGES &&
          !items.some(item => item.kind === 'user-message'); pages++) {
          const earlier = await read(nextCursor)
          if (!current()) return null
          if (!sameSource(page.source, earlier.source)) throw new Error('Native source changed while opening the reading window.')
          const combined = [...earlier.items, ...items]
          if (!withinWindow(combined)) {
            const error = new Error('The native reading window reached its record or byte limit. The unread page remains available in History.')
            if (entry.historyPage || !items.length) {
              entry.windowFrozen = true
              throw error
            }
            windowLimitError = error
            break
          }
          items = combined
          nextCursor = earlier.nextCursor
        }
      } else if (mode === 'earlier') {
        const existing = new Set(entry.items.map(item => item.id))
        items = [...page.items.filter(item => !existing.has(item.id)), ...entry.items]
      } else if (mode === 'revalidate' && entry.items.length) {
        const boundary = entry.items[entry.items.length - 1]!.id
        let incoming = [...page.items]
        let index = incoming.findIndex(item => item.id === boundary)
        for (let pages = 1; index < 0 && nextCursor && pages < MAX_REVALIDATION_PAGES; pages++) {
          if (!withinWindow(incoming)) break
          const earlier = await read(nextCursor)
          if (!current()) return null
          if (!sameSource(page.source, earlier.source)) throw new Error('Native source changed during revalidation.')
          incoming = [...earlier.items, ...incoming]
          nextCursor = earlier.nextCursor
          index = incoming.findIndex(item => item.id === boundary)
        }
        if (index < 0) {
          entry.windowFrozen = true
          return entry.historyPage
        }
        // Retain old raw IDs and their objects. Only newly observed records are
        // appended; reread overlap updates a record only when its facts changed.
        const refreshed = new Map(incoming.map(item => [item.id, item]))
        const existing = new Set(entry.items.map(item => item.id))
        items = [...entry.items.map(item => {
          const latest = refreshed.get(item.id)
          return latest && JSON.stringify(latest) !== JSON.stringify(item) ? latest : item
        }), ...incoming.slice(index + 1).filter(item => !existing.has(item.id))]
        nextCursor = entry.nextCursor
      }
      if (!withinWindow(items)) {
        entry.windowFrozen = true
        return entry.historyPage
      }
      entry.items = items
      entry.nextCursor = nextCursor
      entry.historyPage = { ...page, items, nextCursor }
      entry.error = windowLimitError
      if (mode === 'initial' || mode === 'replace') entry.windowFrozen = windowLimitError !== null
      return entry.historyPage
    } catch (error) {
      if (current()) entry.error = error instanceof Error ? error : new Error(String(error))
      return entry.historyPage
    } finally {
      if (current()) {
        entry.inFlight = null
        entry.loading = false
        notifySubscribers(entry)
        const queued = entry.queuedRefresh
        entry.queuedRefresh = null
        if (queued) void fetchSessionHistoryPage(control, entry, queued)
      }
    }
  })()
  entry.inFlight = promise
  return promise
}

export function useSessionUserMessages(
  control?: AgentSessionControlInput | undefined,
  options?: { enabled?: boolean }
): {
  messages: AgentSessionUserMessage[]
  /** The same bounded Provider page, observed by this consumer's current control. */
  nativeHistoryPage: AgentSessionHistoryPage | null
  nextCursor: string | null
  hasMore: boolean
  loading: boolean
  error: Error | null
  observationError: Error | null
  windowFrozen: boolean
  loadEarlier: () => Promise<void>
  refresh: () => Promise<void>
} {
  const enabled = options?.enabled ?? true
  const isAgent = control?.kind === 'agent'
  const sessionKey = isAgent && control ? makeSessionControlKey(control) : ''
  const active = Boolean(enabled && sessionKey)

  const timeline = useAppStore((state) =>
    active && control ? state.timelines[control.agentSessionId] : undefined
  )

  const committedSnapshotRef = useRef<{
    key: string
    messages: AgentSessionUserMessage[]
    nativeHistoryPage: AgentSessionHistoryPage | null
  }>({ key: '', messages: [], nativeHistoryPage: null })

  useEffect(() => {
    if (!sessionKey || !control) return
    const entry = getOrCreateEntry(control)
    entry.consumerCount++

    return () => {
      entry.consumerCount--
      if (entry.consumerCount <= 0) {
        // When all consumers leave, release entry and cache so future consumers read fresh source
        pauseEntry(entry)
        entry.historyPage = null
        entry.items = []
        entry.nextCursor = null
        entry.error = null
        entry.queuedRefresh = null
        sessionRegistry.delete(sessionKey)
      }
    }
  }, [sessionKey])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!active || !control) return () => {}
      const entry = getOrCreateEntry(control)
      entry.subscribers.add(onStoreChange)

      return () => {
        entry.subscribers.delete(onStoreChange)
        if (!entry.subscribers.size) pauseEntry(entry)
      }
    },
    [active, sessionKey]
  )

  const getSnapshot = useCallback(() => {
    if (!sessionKey) return 0
    return sessionRegistry.get(sessionKey)?.version ?? 0
  }, [sessionKey])

  useSyncExternalStore(subscribe, getSnapshot, () => 0)

  useEffect(() => {
    if (!active || !control) return
    const entry = sessionRegistry.get(sessionKey)
    if (entry && !entry.observationReady && !entry.inFlight && !entry.loading) {
      void fetchSessionHistoryPage(control, entry, entry.historyPage ? 'revalidate' : 'initial')
    }
  }, [active, sessionKey])

  const refresh = useCallback(async () => {
    if (!active || !control) return
    const entry = sessionRegistry.get(sessionKey)
    if (!entry) return
    if (!entry.inFlight) {
      entry.observationController?.abort()
      entry.observationHandle?.dispose()
      entry.observationController = null
      entry.observationHandle = null
      entry.observationReady = null
    }
    await fetchSessionHistoryPage(control, entry, 'replace')
  }, [active, sessionKey])

  const loadEarlier = useCallback(async () => {
    if (!active || !control) return
    const entry = sessionRegistry.get(sessionKey)
    if (!entry || !entry.nextCursor || entry.loading || entry.items.length >= MAX_NATIVE_RECORDS) return
    await fetchSessionHistoryPage(control, entry, 'earlier')
  }, [active, sessionKey])

  // Non-speculative read during render: do not create entry on uncommitted/aborted renders
  const entry = sessionKey ? sessionRegistry.get(sessionKey) : undefined
  const committed = committedSnapshotRef.current.key === sessionKey ? committedSnapshotRef.current : null
  // Pause observation, not the already presented record. Keep the last same-control
  // page through a pending/failed revalidation; another identity never inherits it.
  const nativeHistoryPage = !isAgent || !control || !sessionKey ? null
    : active ? entry?.historyPage ?? committed?.nativeHistoryPage ?? null
    : committed?.nativeHistoryPage ?? null

  let messages: AgentSessionUserMessage[] = []

  if (!isAgent || !control || !sessionKey) {
    messages = []
  } else if (active) {
    // Pure derivation in render:
    // If historyPage or timeline is present, project it directly.
    // If timeline already exists before subscription, project real captured fact immediately without falling back to [].
    if (entry?.historyPage || timeline) {
      messages = projectSessionUserMessages({
        agentSessionId: control.agentSessionId,
        historyPage: entry?.historyPage ?? undefined,
        timeline
      })
    } else if (entry?.loading && committedSnapshotRef.current.key === sessionKey) {
      // Return pending revalidation: retain committed snapshot for this sessionKey until new source arrives
      messages = committedSnapshotRef.current.messages
    } else {
      messages = []
    }
  } else {
    // Paused / hidden: read committed snapshot for THIS sessionKey.
    // An aborted render of another key never committed, so committedSnapshotRef is untouched.
    messages = committedSnapshotRef.current.key === sessionKey ? committedSnapshotRef.current.messages : []
  }

  // Commit phase only: save committed presentation snapshot
  useLayoutEffect(() => {
    if (active && sessionKey) {
      committedSnapshotRef.current = {
        key: sessionKey,
        messages,
        nativeHistoryPage
      }
    }
  }, [active, sessionKey, messages, nativeHistoryPage])

  return {
    messages,
    nativeHistoryPage,
    nextCursor: entry?.nextCursor ?? null,
    hasMore: Boolean(entry?.nextCursor),
    loading: active ? (entry?.loading ?? false) : false,
    error: entry?.error ?? null,
    observationError: entry?.observationError ?? null,
    windowFrozen: entry?.windowFrozen ?? false,
    loadEarlier,
    refresh
  }
}
