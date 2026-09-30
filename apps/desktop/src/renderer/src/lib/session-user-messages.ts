import { useEffect, useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { AgentSessionHistoryPage, AgentSessionUserMessage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from './api'
import { useAppStore } from '../store'

export type AgentSessionControlInput = AgentSessionControl

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
  latestRequestedId: number
  latestAppliedId: number
  consumerLifetimeId: number
  queuedRefresh: boolean
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
      latestRequestedId: 0,
      latestAppliedId: 0,
      consumerLifetimeId: 0,
      queuedRefresh: false
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

async function fetchSessionHistoryPage(
  control: AgentSessionControlInput,
  entry: SessionEntry,
  cursor?: string,
  isExplicitRefresh?: boolean
): Promise<AgentSessionHistoryPage | null> {
  // If an in-flight request is already active for this session:
  if (entry.inFlight) {
    if (isExplicitRefresh) {
      entry.queuedRefresh = true
    }
    return entry.inFlight
  }

  entry.loading = true
  entry.error = null
  notifySubscribers(entry)

  const requestId = ++entry.latestRequestedId
  const requestLifetimeId = entry.consumerLifetimeId

  const promise = (async () => {
    try {
      const page = await api.sessions.historyPage(control, { limit: 30, ...(cursor ? { cursor } : {}) })

      // Check if consumers left or consumer lifetime changed while in flight
      if (entry.subscribers.size === 0 || requestLifetimeId !== entry.consumerLifetimeId) {
        return null
      }

      // Generation check: discard older request if a newer request already applied
      if (requestId < entry.latestAppliedId) {
        return entry.historyPage
      }

      if (page && page.agentSessionId === control.agentSessionId) {
        entry.latestAppliedId = requestId
        if (cursor) {
          // Prepend earlier items so canonical chronological order (0..30) is preserved!
          const combinedItems = [...page.items, ...entry.items]
          entry.items = combinedItems
          entry.nextCursor = page.nextCursor
          entry.historyPage = { ...page, items: combinedItems }
        } else {
          entry.items = page.items
          entry.nextCursor = page.nextCursor
          entry.historyPage = page
        }
        entry.error = null
      }
      return entry.historyPage
    } catch (err) {
      if (entry.subscribers.size > 0 && requestLifetimeId === entry.consumerLifetimeId) {
        entry.error = err instanceof Error ? err : new Error(String(err))
      }
      // Preserve existing observed items across transport failures
      return entry.historyPage
    } finally {
      if (requestLifetimeId === entry.consumerLifetimeId) {
        entry.inFlight = null
        if (!entry.queuedRefresh && requestId === entry.latestRequestedId) {
          entry.loading = false
        }
      }
      notifySubscribers(entry)

      // If an explicit refresh was queued while this request was in flight, execute it now
      if (entry.queuedRefresh && entry.subscribers.size > 0 && requestLifetimeId === entry.consumerLifetimeId) {
        entry.queuedRefresh = false
        void fetchSessionHistoryPage(control, entry, undefined, false)
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
        entry.consumerLifetimeId++
        entry.inFlight = null
        entry.loading = false
        entry.historyPage = null
        entry.items = []
        entry.nextCursor = null
        entry.error = null
        entry.queuedRefresh = false
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
    if (entry && !entry.historyPage && !entry.inFlight && !entry.loading) {
      void fetchSessionHistoryPage(control, entry)
    }
  }, [active, sessionKey])

  const refresh = useCallback(async () => {
    if (!active || !control) return
    const entry = sessionRegistry.get(sessionKey)
    if (!entry) return
    await fetchSessionHistoryPage(control, entry, undefined, true /* isExplicitRefresh */)
  }, [active, sessionKey])

  const loadEarlier = useCallback(async () => {
    if (!active || !control) return
    const entry = sessionRegistry.get(sessionKey)
    if (!entry || !entry.nextCursor || entry.loading) return
    await fetchSessionHistoryPage(control, entry, entry.nextCursor)
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
    loadEarlier,
    refresh
  }
}
