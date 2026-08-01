import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { surfaceNavigationVisibility } from './surface-navigation-visibility'
import type { WorkspaceLayout } from './workbench-layout'
import {
  nextTerminalColdParkDelayMs,
  selectColdParkedTerminalRegions,
  type TerminalColdParkCandidate
} from './terminal-cold-parking-policy'
import type { WorkbenchTab } from './workbench-tabs'

type Layouts = Readonly<Record<string, WorkspaceLayout>>
type Tabs = Readonly<Record<string, WorkbenchTab>>

// Store hydration and lightweight/static renderers can expose the coordinator before the
// persisted workbench slices exist. Keep one stable empty value per slice so the selector boundary
// remains total without allocating a new object on every render (which would also churn the
// deadline scheduler's dependencies).
const EMPTY_TABS: Tabs = Object.freeze({})
const EMPTY_LAYOUTS: Layouts = Object.freeze({})
const EMPTY_SESSIONS: readonly SessionSnapshot[] = Object.freeze([])

export type TerminalParkingCollectionInput = {
  tabs: Tabs
  layouts: Layouts
  sessions: readonly SessionSnapshot[]
  activeWorkspaceId: string | null
  workbenchVisible: boolean
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
    const { navigationContextActive, tabVisible } = surfaceNavigationVisibility(
      tab,
      layout,
      input.tabs,
      input
    )

    for (const surface of Object.values(tab.regions)) {
      if (surface.kind !== 'agent' && surface.kind !== 'terminal') continue
      const session = sessionsById.get(surface.sessionId)
      candidates.push({
        id: surface.regionId,
        visible: tabVisible,
        navigationContextActive,
        hiddenSinceMs: null,
        lastActivatedSeq: 0,
        phase: surface.phase,
        // Only a currently running Run has an attach/replay contract. Interrupted, exited, errored,
        // or continuity-unavailable Sessions remain rendered so recovery stays visible.
        //
        // A continuity failure is covered by `state !== 'error'` and needs no clause of its own —
        // a `status.continuity === undefined` clause here was measured to be dead code. Both writers
        // of that field go through one producer (`continuityStatusFields` in store.ts, shared by the
        // startup candidate projection and the user-pressed recovery path) which hardcodes
        // `state: 'error'`; and every later status event replaces the whole `status` object
        // (`session-state.ts`, agent-status and process-state), so the field cannot survive into a
        // non-error state. Deleting such a clause reddened only a fixture hand-built to hold
        // `state: 'running'` alongside it — a combination production never produces.
        canRebuild: Boolean(
          session &&
          session.processState === 'running' &&
          session.status.state !== 'error' &&
          session.status.state !== 'exited' &&
          session.status.state !== 'disconnected'
        ),
        hasPendingInteraction: Boolean(
          session?.kind === 'agent' && session.pendingInteraction
        )
      })
    }
  }
  return candidates
}

type TerminalParkingCoordinatorOptions = {
  workbenchVisible: boolean
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
  return (
    <TerminalParkingContext.Provider value={parkedRegionIds}>
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
  measurementActive = false,
  parkingEnabled = true
}: TerminalParkingCoordinatorOptions): ReadonlySet<string> {
  // These defaults are deliberately at the store-selector boundary. During hydration (and in
  // static/resource-probe renders) a partial store is a valid transient state; parking should
  // observe an empty workbench rather than make the entire App render fail closed.
  const tabs = useAppStore((state) => state?.tabs) ?? EMPTY_TABS
  const layouts = useAppStore((state) => state?.layouts) ?? EMPTY_LAYOUTS
  const sessions = useAppStore((state) => state?.sessions) ?? EMPTY_SESSIONS
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const candidates = useMemo(
    () => collectTerminalColdParkCandidates({
      tabs,
      layouts,
      sessions,
      activeWorkspaceId,
      workbenchVisible
    }),
    [activeWorkspaceId, layouts, sessions, tabs, workbenchVisible]
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
    for (const id of hiddenSinceByRegionRef.current.keys()) {
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
