import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { shallow } from 'zustand/shallow'
import { sessionPresentationById } from './session-presentation'
import type { SessionSnapshot } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { surfaceNavigationVisibility } from './surface-navigation-visibility'
import type { WorkspaceLayout } from '@agentmux/layout'
import {
  nextTerminalColdParkDelayMs,
  selectColdParkedTerminalRegions,
  type TerminalColdParkCandidate
} from './terminal-cold-parking-policy'
import type { WorkbenchTab } from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'
import { workbenchNavigationTabs } from './workbench-navigation-catalog'

type Layouts = Readonly<Record<string, WorkspaceLayout>>
type Tabs = Readonly<Record<string, WorkbenchTab>>

// Store hydration and lightweight/static renderers can expose the coordinator before the
// persisted workbench slices exist. Keep one stable empty value per slice so the selector boundary
// remains total without allocating a new object on every render (which would also churn the
// deadline scheduler's dependencies).
const EMPTY_TABS: Tabs = Object.freeze({})
const EMPTY_LAYOUTS: Layouts = Object.freeze({})
const EMPTY_SESSIONS: readonly TerminalParkingSessionFacts[] = Object.freeze([])

type TerminalParkingSessionFacts = { id: string; kind: SessionSnapshot['kind']; hostId: string; runId: string; canRebuild: boolean; hasPendingInteraction: boolean }

/** Only these facts grant parking; no output/status timestamp or whole Session identity does. */
export function terminalParkingSessionFacts(session: Pick<SessionSnapshot, 'id' | 'kind' | 'control' | 'processState' | 'status'> & { pendingInteraction?: unknown }): TerminalParkingSessionFacts {
  return { id: session.id, kind: session.kind, hostId: session.control.hostId, runId: session.control.run.runId, canRebuild: session.processState === 'running' &&
    session.status.state !== 'error' && session.status.state !== 'exited' && session.status.state !== 'disconnected',
    hasPendingInteraction: Boolean(session.kind === 'agent' && session.pendingInteraction) }
}

/** One coordinator-owned projection, bounded by its current topology, not Session lifetime. */
export function createTerminalParkingSessionSelector(sessionIds: readonly string[]) {
  let value: readonly TerminalParkingSessionFacts[] = EMPTY_SESSIONS
  let previousSessions: readonly SessionSnapshot[] | undefined
  const previous = new Map<string, TerminalParkingSessionFacts>()
  return (state: { sessions: readonly SessionSnapshot[] }): readonly TerminalParkingSessionFacts[] => {
    if (sessionIds.length === 0) return EMPTY_SESSIONS
    if (state.sessions === previousSessions) return value
    previousSessions = state.sessions
    const byId = sessionPresentationById(state.sessions)
    const next: TerminalParkingSessionFacts[] = []
    for (const id of sessionIds) {
      const session = byId.get(id)
      if (!session) { previous.delete(id); continue }
      const facts = terminalParkingSessionFacts(session)
      const known = previous.get(id)
      const item = known && known.kind === facts.kind && known.hostId === facts.hostId && known.runId === facts.runId && known.canRebuild === facts.canRebuild && known.hasPendingInteraction === facts.hasPendingInteraction ? known : facts
      previous.set(id, item)
      next.push(item)
    }
    if (shallow(value, next)) return value
    value = next
    return value
  }
}

export type TerminalParkingCollectionInput = {
  tabs: Tabs
  layouts: Layouts
  sessions: readonly TerminalParkingSessionFacts[]
  activeWorkspaceId: string | null
  workbenchVisible: boolean
  projectedVisibleTabIds?: ReadonlySet<string> | undefined
  projectedVisibleRegionIds?: ReadonlySet<string> | undefined
}

/**
 * Build one candidate list for the whole window.  A Region is the unit here, not a Session: one
 * Session may be projected into several Regions, and parking one projection must never silently
 * park or detach its siblings.
 */
export function collectTerminalColdParkCandidates(
  input: TerminalParkingCollectionInput
): TerminalColdParkCandidate[] {
  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]))
  const candidates: TerminalColdParkCandidate[] = []

  for (const tab of Object.values(input.tabs)) {
    const layout = input.layouts[tab.workspaceId]
    if (!layout) continue
    for (const surface of Object.values(tab.regions)) {
      if (!isSessionSurface(surface)) continue
      const { navigationContextActive, tabVisible } = surfaceNavigationVisibility(tab, layout, input.tabs, input, surface.regionId)
      const session = sessionsById.get(surface.sessionId)
      candidates.push({
        id: surface.regionId,
        visible: tabVisible,
        navigationContextActive,
        hiddenSinceMs: null,
        lastActivatedSeq: 0,
        phase: surface.phase,
        // Unknown, ended or failed Runs stay rendered; related interaction remains available.
        canRebuild: session?.canRebuild ?? false,
        hasPendingInteraction: session?.hasPendingInteraction ?? false
      })
    }
  }
  return candidates
}

type TerminalParkingCoordinatorOptions = {
  workbenchVisible: boolean
  projectedVisibleTabIds?: ReadonlySet<string> | undefined
  projectedVisibleRegionIds?: ReadonlySet<string> | undefined
  /** Resource probes own their measurement window and must observe the unparked baseline. */
  measurementActive?: boolean
  parkingEnabled?: boolean
}

const EMPTY_REGION_IDS: ReadonlySet<string> = new Set()
const TerminalParkingContext = createContext<ReadonlySet<string>>(EMPTY_REGION_IDS)

export function TerminalParkingProvider({
  parkedRegionIds,
  children
}: {
  parkedRegionIds: ReadonlySet<string>
  children: ReactNode
}) {
  const previousRegionIds = useRef(parkedRegionIds)
  if (!shallow(previousRegionIds.current, parkedRegionIds)) previousRegionIds.current = parkedRegionIds
  return (
    <TerminalParkingContext.Provider value={previousRegionIds.current}>
      {children}
    </TerminalParkingContext.Provider>
  )
}

export function useTerminalRegionParked(regionId: string): boolean {
  return useContext(TerminalParkingContext).has(regionId)
}

/**
 * Window-level lifecycle coordinator.  It uses one deadline timer rather than a polling loop, and
 * keeps hidden-time/activation order in refs so those bookkeeping facts never become persisted
 * application state or a second Session/Run truth source.
 */
export function useTerminalColdParking({
  workbenchVisible,
  projectedVisibleTabIds,
  projectedVisibleRegionIds,
  measurementActive = false,
  parkingEnabled = true
}: TerminalParkingCoordinatorOptions): ReadonlySet<string> {
  // These defaults are deliberately at the store-selector boundary. During hydration (and in
  // static/resource-probe renders) a partial store is a valid transient state; parking should
  // observe an empty workbench rather than make the entire App render fail closed.
  const tabs = useAppStore((state) => workbenchNavigationTabs(state?.tabs ?? EMPTY_TABS)) ?? EMPTY_TABS
  const layouts = useAppStore((state) => state?.layouts) ?? EMPTY_LAYOUTS
  const sessionIds = useMemo(() => [...new Set(Object.values(tabs).flatMap((tab) => (
    Object.values(tab.regions).flatMap((surface) => isSessionSurface(surface) ? [surface.sessionId] : [])
  )))], [tabs])
  const sessionSelector = useMemo(() => createTerminalParkingSessionSelector(sessionIds), [sessionIds])
  const sessions = useAppStore(sessionSelector) ?? EMPTY_SESSIONS
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const candidates = useMemo(
    () => collectTerminalColdParkCandidates({
      tabs,
      layouts,
      sessions,
      activeWorkspaceId,
      workbenchVisible,
      projectedVisibleTabIds, projectedVisibleRegionIds
    }),
    [activeWorkspaceId, layouts, sessions, tabs, workbenchVisible, projectedVisibleTabIds, projectedVisibleRegionIds]
  )
  const candidateKey = useMemo(
    () => candidates.map((candidate) => [
      candidate.id,
      candidate.visible ? 'visible' : 'hidden',
      candidate.phase,
      candidate.canRebuild ? 'rebuildable' : 'not-rebuildable',
      candidate.hasPendingInteraction ? 'pending' : 'clear',
      candidate.navigationContextActive ? 'context-active' : 'context-hidden'
    ].join(':')).join('|'),
    [candidates]
  )
  const hiddenSinceByRegionRef = useRef(new Map<string, number>())
  const activationOrderByRegionRef = useRef(new Map<string, number>())
  const navigationContextByRegionRef = useRef(new Map<string, boolean>())
  const visibleRegionIdsRef = useRef(new Set<string>())
  const activationSequenceRef = useRef(0)
  const wasMeasuringRef = useRef(false)
  const parkCooldownUntilRef = useRef<number | null>(null)
  const [bookkeepingRevision, setBookkeepingRevision] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const nowMs = Date.now()
    const currentIds = new Set(candidates.map((candidate) => candidate.id))
    let changed = false
    for (const id of new Set([...hiddenSinceByRegionRef.current.keys(), ...activationOrderByRegionRef.current.keys(), ...navigationContextByRegionRef.current.keys()])) {
      if (!currentIds.has(id)) {
        hiddenSinceByRegionRef.current.delete(id)
        activationOrderByRegionRef.current.delete(id)
        navigationContextByRegionRef.current.delete(id)
        changed = true
      }
    }

    const visibleNow = new Set<string>()
    for (const candidate of candidates) {
      const wasNavigationContextActive = navigationContextByRegionRef.current.get(candidate.id)
      navigationContextByRegionRef.current.set(candidate.id, candidate.navigationContextActive)
      // Re-entering a Project/Topic is a fresh navigation context.  Reset the hidden clock even when
      // the Region was not the active Tab, so a long stay in another context cannot park it on the very
      // first frame after the user returns.
      if (
        candidate.navigationContextActive &&
        wasNavigationContextActive === false &&
        !candidate.visible
      ) {
        hiddenSinceByRegionRef.current.set(candidate.id, nowMs)
        changed = true
      }
      if (candidate.visible) {
        visibleNow.add(candidate.id)
        hiddenSinceByRegionRef.current.delete(candidate.id)
        if (!visibleRegionIdsRef.current.has(candidate.id)) {
          activationSequenceRef.current += 1
          activationOrderByRegionRef.current.set(candidate.id, activationSequenceRef.current)
          changed = true
        }
      } else if (!hiddenSinceByRegionRef.current.has(candidate.id)) {
        hiddenSinceByRegionRef.current.set(candidate.id, nowMs)
        changed = true
      }
    }
    visibleRegionIdsRef.current = visibleNow

    if (measurementActive) {
      wasMeasuringRef.current = true
    } else if (wasMeasuringRef.current) {
      parkCooldownUntilRef.current = nowMs + 30_000
      wasMeasuringRef.current = false
      changed = true
    }
    if (workbenchVisible && !measurementActive) parkCooldownUntilRef.current = null
    if (changed) setBookkeepingRevision((revision) => revision + 1)
  }, [candidateKey, candidates, measurementActive, workbenchVisible])

  const stampedCandidates = useMemo(
    () => candidates.map((candidate) => ({
      ...candidate,
      hiddenSinceMs: candidate.visible
        ? null
        : hiddenSinceByRegionRef.current.get(candidate.id) ?? null,
      lastActivatedSeq: activationOrderByRegionRef.current.get(candidate.id) ?? 0
    })),
    // The revision is bumped only after the ref bookkeeping commit, so policy never observes a
    // half-updated hidden clock.  `deadlineRevision` wakes the same pure calculation at TTLs.
    [bookkeepingRevision, candidateKey, candidates, nowMs]
  )
  const parkCooldownUntilMs = parkCooldownUntilRef.current
  const policy = useMemo(() => ({
    nowMs,
    parkingEnabled,
    measurementActive,
    parkCooldownUntilMs
  }), [measurementActive, nowMs, parkingEnabled, parkCooldownUntilMs])
  const parkedRegionIds = useMemo(
    () => selectColdParkedTerminalRegions(stampedCandidates, policy),
    [policy, stampedCandidates]
  )

  const parkingDeadlineKey = useMemo(
    () => stampedCandidates.map((candidate) => [
      candidate.id,
      candidate.hiddenSinceMs ?? 'none',
      candidate.visible ? 'visible' : 'hidden',
      candidate.phase,
      candidate.canRebuild ? 'rebuildable' : 'not-rebuildable',
      candidate.hasPendingInteraction ? 'pending' : 'clear',
      candidate.navigationContextActive ? 'context-active' : 'context-hidden'
    ].join(':')).join('|'),
    [stampedCandidates]
  )
  useEffect(() => {
    const delayMs = nextTerminalColdParkDelayMs(stampedCandidates, policy)
    if (delayMs === null) return
    const timer = window.setTimeout(() => {
      setNowMs(Date.now())
    }, delayMs)
    return () => window.clearTimeout(timer)
  // Depend on the semantic deadline key rather than the candidate object identity. High-frequency
  // Session output updates must not keep clearing and restarting a timer that is already counting
  // down toward the same hidden Region deadline.
  }, [parkingDeadlineKey, policy])

  return parkedRegionIds
}
