import { useEffect, useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { AgentSessionHistoryPage, AgentSessionUserMessage, AgentSessionHistoryObservationHandle, AgentSessionHistorySource } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { AgentConversationRecordSource } from '@agentmux/core/conversation'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from './api'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { nativeBindingKey } from '../../../shared/agent-native-source'
import { sessionPresentationById } from './session-presentation'

export type AgentSessionControlInput = AgentSessionControl

const MAX_NATIVE_ACTIVITY_RECORDS = 90
const MAX_NATIVE_MESSAGES = 200
const MAX_NATIVE_BYTES = 12 * 1024 * 1024
const MAX_REVALIDATION_PAGES = 3
type ReadMode = 'initial' | 'earlier' | 'revalidate' | 'replace' | 'reveal'

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
  windowIncomplete: boolean
  refreshTimer: ReturnType<typeof setTimeout> | null
}

const sessionRegistry = new Map<string, SessionEntry>()

function encodeSegment(s: string): string {
  return s.replace(/%/g, '%25').replace(/:/g, '%3A')
}

function makeSessionControlKey(control: AgentSessionControlInput): string {
  return `${encodeSegment(control.hostId)}:${encodeSegment(control.agentSessionId)}:${encodeSegment(control.run.runId)}`
}

function getOrCreateEntry(control: AgentSessionControlInput, key: string): SessionEntry {
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
      windowIncomplete: false,
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

function messageFactPage(entry: SessionEntry): AgentSessionHistoryPage | null {
  return entry.historyPage ? { ...entry.historyPage, items: entry.items, nextCursor: entry.nextCursor } : null
}

function sameSource(a: AgentSessionHistoryPage['source'], b: AgentSessionHistoryPage['source']): boolean {
  return a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId
}

function changedSourceError(message: string): Error {
  return Object.assign(new Error(message), { code: 'native-source-changed' })
}

function sourceChanged(entry: SessionEntry | undefined): boolean {
  return [entry?.error, entry?.observationError].some(error => (error as (Error & { code?: string }) | null)?.code === 'native-source-changed')
}

function withinWindow(items: AgentSessionHistoryPage['items']): boolean {
  const activities = items.filter(item => item.kind === 'activity').length
  if (activities > MAX_NATIVE_ACTIVITY_RECORDS || items.length - activities > MAX_NATIVE_MESSAGES) return false
  let bytes = 0
  for (const item of items) {
    bytes += new TextEncoder().encode(JSON.stringify(item)).byteLength
    if (bytes > MAX_NATIVE_BYTES) return false
  }
  return true
}

/** Keep conversation and process retention independent, within the same source window. */
function retainReadingWindow(items: AgentSessionHistoryPage['items']): AgentSessionHistoryPage['items'] {
  let messages = 0, activities = 0
  // Select the latest records in source order; tool bursts cannot evict speech.
  const retained = [...items].reverse().filter(item => item.kind === 'activity'
    ? ++activities <= MAX_NATIVE_ACTIVITY_RECORDS : ++messages <= MAX_NATIVE_MESSAGES).reverse()
  const sizes = retained.map(item => new TextEncoder().encode(JSON.stringify(item)).byteLength)
  if (sizes.at(-1)! > MAX_NATIVE_BYTES) throw new Error('The latest native record exceeds the reading budget. Existing messages are kept; History remains available.')
  let bytes = sizes.reduce((sum, size) => sum + size, 0)
  while (bytes > MAX_NATIVE_BYTES) {
    const activity = retained.findIndex(item => item.kind === 'activity')
    const index = activity < 0 ? 0 : activity
    bytes -= sizes[index]!
    sizes.splice(index, 1)
    retained.splice(index, 1)
  }
  return retained
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
        if (!current() || observation.agentSessionId !== entry.agentSessionId || sourceChanged(entry)) return
        if (observation.kind === 'unavailable') {
          const changed = observation.code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
          entry.observationError = changed ? changedSourceError(observation.message)
            : Object.assign(new Error(observation.message), { code: observation.code })
          if (changed) {
            entry.observationHandle?.dispose()
            entry.observationHandle = null
          }
          notifySubscribers(entry)
          return
        }
        const source = entry.observationHandle?.source
        if (source && !sameSource(source, observation.source)) {
          entry.observationError = changedSourceError('Native source changed. The current window is kept; refresh its source.')
          entry.observationHandle?.dispose()
          entry.observationHandle = null
          notifySubscribers(entry)
          return
        }
        if (entry.observationError) {
          entry.observationError = null
          notifySubscribers(entry)
        }
        scheduleRevalidation(control, entry)
      }, { signal: controller.signal })
      if (!current()) { handle.dispose(); return }
      if (!replacing && entry.historyPage && !sameSource(entry.historyPage.source, handle.source)) {
        handle.dispose()
        entry.observationError = changedSourceError('Native source changed. The current window is kept; refresh its source.')
      } else if (sourceChanged(entry)) handle.dispose()
      else entry.observationHandle = handle
    } catch (error) {
      if (current() && !sourceChanged(entry)) entry.observationError = error instanceof Error ? error : new Error(String(error))
    } finally {
      if (current()) notifySubscribers(entry)
    }
  })()
  entry.observationReady = acquiring
  return acquiring
}

/** One typed read boundary for recent facts and each presentation's original-sequence window. */
export async function readSessionConversationPage(
  reference: SessionHistoryReference,
  options: { cursor?: string; source?: AgentSessionHistorySource; limit?: number; nativeSource?: 'previous' } = {}
): Promise<AgentSessionHistoryPage> {
  const page = await api.sessions.historyPage(reference, { limit: options.limit ?? 30,
    ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.nativeSource ? { nativeSource: options.nativeSource } : {}) })
  if (page.agentSessionId !== reference.agentSessionId) throw new Error('Native page belongs to another Session.')
  if (options.source && !sameSource(options.source, page.source)) {
    throw changedSourceError('Native source changed. The current window is kept; refresh its source.')
  }
  if (options.cursor && page.nextCursor === options.cursor) throw new Error('The conversation cursor did not advance. Retry the read.')
  return page
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
        const source = entry.observationHandle?.source ?? (mode !== 'replace' ? entry.historyPage?.source : undefined)
        const page = await readSessionConversationPage(control, { ...(cursor ? { cursor } : {}), ...(source ? { source } : {}) })
        return page
      }
      let page = await read(mode === 'earlier' ? entry.nextCursor ?? undefined : undefined)
      if (!current()) return null
      let items = page.items
      let nextCursor = page.nextCursor
      let originalPage = page
      let windowIncomplete = mode === 'initial' || mode === 'replace' ? false : entry.windowIncomplete
      if (mode === 'initial' || mode === 'replace') {
        if (!withinWindow(items)) throw new Error('The native page exceeds the reading window budget. Earlier records remain readable in this conversation.')
        originalPage = page
        // Find input context only when opening a window. Process records can
        // occupy the latest page; keep every accepted page and its real cursor.
        for (let pages = 1; nextCursor && pages < MAX_REVALIDATION_PAGES &&
          !items.some(item => item.kind === 'user-message'); pages++) {
          const earlier = await read(nextCursor)
          if (!current()) return null
          if (!sameSource(page.source, earlier.source)) throw new Error('Native source changed while opening the reading window.')
          const combined = [...earlier.items, ...items]
          if (!withinWindow(combined)) {
            items = retainReadingWindow(combined)
            nextCursor = earlier.nextCursor
            windowIncomplete = true
            break
          }
          items = combined
          nextCursor = earlier.nextCursor
          originalPage = { ...page, items, nextCursor }
        }
      } else if (mode === 'earlier') {
        originalPage = entry.historyPage ?? page
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
        if (index < 0) windowIncomplete = true
        // The raw reading window stays continuous. Its cursor belongs to an actual
        // accepted page boundary; the independent message projection may be sparse.
        const previous = entry.historyPage
        const refreshedOriginal = new Map(incoming.map(item => [item.id, item]))
        const originalItems = previous && index >= 0 && previous.items.at(-1)?.id === boundary
          ? [...previous.items.map(item => {
            const latest = refreshedOriginal.get(item.id)
            return latest && JSON.stringify(latest) !== JSON.stringify(item) ? latest : item
          }), ...incoming.slice(index + 1)] : incoming
        originalPage = previous && index >= 0 && previous.items.at(-1)?.id === boundary && withinWindow(originalItems)
          ? { ...page, items: originalItems, nextCursor: previous.nextCursor }
          : { ...page, items: incoming, nextCursor }
        // Retain old raw IDs and their objects. Only newly observed records are
        // appended; reread overlap updates a record only when its facts changed.
        const refreshed = new Map(incoming.map(item => [item.id, item]))
        const existing = new Set(entry.items.map(item => item.id))
        items = [...entry.items.map(item => {
          const latest = refreshed.get(item.id)
          return latest && JSON.stringify(latest) !== JSON.stringify(item) ? latest : item
        }), ...incoming.slice(index < 0 ? 0 : index + 1).filter(item => !existing.has(item.id))]
        nextCursor = entry.nextCursor
      }
      if (!withinWindow(items)) {
        items = retainReadingWindow(items)
        windowIncomplete = true
      }
      entry.items = items
      entry.nextCursor = nextCursor
      entry.historyPage = originalPage
      entry.windowIncomplete = windowIncomplete
      if (mode === 'initial' || mode === 'replace') entry.windowFrozen = false
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
  /** Continuous original records and their real Provider page boundary. */
  nativeHistoryPage: AgentSessionHistoryPage | null
  /** Retained context facts; process clipping can make this projection non-contiguous. */
  nativeContextItems: AgentSessionHistoryPage['items']
  nextCursor: string | null
  hasMore: boolean
  loading: boolean
  error: Error | null
  observationError: Error | null
  windowFrozen: boolean
  windowIncomplete: boolean
  sourceChanged: boolean
  loadEarlier: () => Promise<void>
  refresh: () => Promise<void>
  /** Join an existing read or read one page; navigation never queues a refresh or scans history. */
  readForReveal: (source: AgentConversationRecordSource) => Promise<{ page: AgentSessionHistoryPage | null; error: Error | null; windowFrozen: boolean; sourceChanged: boolean }>
} {
  const enabled = options?.enabled ?? true
  const isAgent = control?.kind === 'agent'
  const bindingKey = useAppStore(state => {
    const session = control ? sessionPresentationById(state.sessions).get(control.agentSessionId) : undefined
    return session?.kind === 'agent' && session.control.hostId === control?.hostId && session.control.run.runId === control?.run.runId
      ? nativeBindingKey(session) : ''
  })
  const sessionKey = isAgent && control ? `${makeSessionControlKey(control)}:${bindingKey}` : ''
  const active = Boolean(enabled && sessionKey)

  const timeline = useAppStore((state) =>
    active && control ? state.timelines[control.agentSessionId] : undefined
  )

  const committedSnapshotRef = useRef<{
    key: string
    messages: AgentSessionUserMessage[]
    nativeHistoryPage: AgentSessionHistoryPage | null
    nativeContextItems: AgentSessionHistoryPage['items']
  }>({ key: '', messages: [], nativeHistoryPage: null, nativeContextItems: [] })

  useEffect(() => {
    if (!sessionKey || !control) return
    const entry = getOrCreateEntry(control, sessionKey)
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
      const entry = getOrCreateEntry(control, sessionKey)
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
    if (!entry || !entry.nextCursor || entry.loading || entry.items.length >= MAX_NATIVE_ACTIVITY_RECORDS + MAX_NATIVE_MESSAGES) return
    await fetchSessionHistoryPage(control, entry, 'earlier')
  }, [active, sessionKey])

  const readForReveal = useCallback(async (source: AgentConversationRecordSource) => {
    const entry = sessionKey ? sessionRegistry.get(sessionKey) : undefined
    if (!entry || !control || source.kind !== 'native') return { page: null, error: null, windowFrozen: false, sourceChanged: false }
    const currentPage = messageFactPage(entry)
    const matchesSource = currentPage && sameSource(currentPage.source, source)
    const loaded = matchesSource && currentPage.items.some(item => item.id === source.recordId)
    if (entry.inFlight) await entry.inFlight
    else if (!loaded && !entry.windowFrozen && !sourceChanged(entry) && (!currentPage || matchesSource)) {
      // Unlike refresh(), this does not queue behind an in-flight read. The existing bounded
      // operation is the one allowance; otherwise only one earlier/latest page is requested.
      if (entry.subscribers.size && (!currentPage || entry.nextCursor) && entry.items.length < MAX_NATIVE_ACTIVITY_RECORDS + MAX_NATIVE_MESSAGES) {
        await fetchSessionHistoryPage(control, entry, currentPage ? 'earlier' : 'reveal')
      }
    }
    return { page: messageFactPage(entry), error: entry.error, windowFrozen: entry.windowFrozen, sourceChanged: sourceChanged(entry) }
  }, [sessionKey])

  // Non-speculative read during render: do not create entry on uncommitted/aborted renders
  const entry = sessionKey ? sessionRegistry.get(sessionKey) : undefined
  const committed = committedSnapshotRef.current.key === sessionKey ? committedSnapshotRef.current : null
  // Pause observation, not the already presented record. Keep the last same-control
  // page through a pending/failed revalidation; another identity never inherits it.
  const nativeHistoryPage = !isAgent || !control || !sessionKey ? null
    : active ? entry?.historyPage ?? committed?.nativeHistoryPage ?? null
    : committed?.nativeHistoryPage ?? null
  const nativeContextItems = active ? entry?.items ?? committed?.nativeContextItems ?? []
    : committed?.nativeContextItems ?? []

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
        historyPage: entry ? messageFactPage(entry) ?? undefined : undefined,
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
        nativeHistoryPage,
        nativeContextItems
      }
    }
  }, [active, sessionKey, messages, nativeHistoryPage, nativeContextItems])

  return {
    messages,
    nativeHistoryPage,
    nativeContextItems,
    nextCursor: entry?.nextCursor ?? null,
    hasMore: Boolean(entry?.nextCursor),
    loading: active ? (entry?.loading ?? false) : false,
    error: entry?.error ?? null,
    observationError: entry?.observationError ?? null,
    windowFrozen: entry?.windowFrozen ?? false,
    windowIncomplete: entry?.windowIncomplete ?? false,
    sourceChanged: sourceChanged(entry),
    loadEarlier,
    refresh,
    readForReveal
  }
}
