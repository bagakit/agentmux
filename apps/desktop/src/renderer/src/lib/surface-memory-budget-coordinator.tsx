import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { useAppStore } from '../store'
import {
  collectSurfaceMemoryCandidates,
  type SurfaceMemoryCollectionInput
} from './surface-memory-budget-candidates'
import {
  nextSurfaceMemoryDeadlineMs,
  selectSurfaceMemoryReleases
} from './surface-memory-budget'

type Tabs = SurfaceMemoryCollectionInput['tabs']
type Layouts = SurfaceMemoryCollectionInput['layouts']
type Documents = SurfaceMemoryCollectionInput['documents']

const EMPTY_TABS: Tabs = Object.freeze({})
const EMPTY_LAYOUTS: Layouts = Object.freeze({})
const EMPTY_SESSIONS: readonly SessionSnapshot[] = Object.freeze([])
const EMPTY_DOCUMENTS: Documents = Object.freeze({})
const EMPTY_FLAGS: Readonly<Record<string, boolean>> = Object.freeze({})
const EMPTY_REGION_IDS: ReadonlySet<string> = new Set()

export type SurfaceMemoryBudgetState = {
  monacoRegionIds: ReadonlySet<string>
  browserRegionIds: ReadonlySet<string>
}

const SurfaceMemoryBudgetContext = createContext<SurfaceMemoryBudgetState>({
  monacoRegionIds: EMPTY_REGION_IDS,
  browserRegionIds: EMPTY_REGION_IDS
})

export function SurfaceMemoryBudgetProvider({
  state,
  children
}: {
  state: SurfaceMemoryBudgetState
  children: ReactNode
}) {
  return (
    <SurfaceMemoryBudgetContext.Provider value={state}>
      {children}
    </SurfaceMemoryBudgetContext.Provider>
  )
}

export function useMonacoSurfaceReleased(regionId: string): boolean {
  return useContext(SurfaceMemoryBudgetContext).monacoRegionIds.has(regionId)
}

export function useBrowserSurfaceReleased(regionId: string): boolean {
  return useContext(SurfaceMemoryBudgetContext).browserRegionIds.has(regionId)
}

type CoordinatorOptions = {
  workbenchVisible: boolean
  measurementActive?: boolean
  parkingEnabled?: boolean
}

/** Window-level scheduler for Browser and Monaco owners. */
export function useSurfaceMemoryBudget({
  workbenchVisible,
  measurementActive = false,
  parkingEnabled = true
}: CoordinatorOptions): SurfaceMemoryBudgetState {
  const tabs = useAppStore((state) => state?.tabs) ?? EMPTY_TABS
  const layouts = useAppStore((state) => state?.layouts) ?? EMPTY_LAYOUTS
  const sessions = useAppStore((state) => state?.sessions) ?? EMPTY_SESSIONS
  const documents = useAppStore((state) => state?.documents) ?? EMPTY_DOCUMENTS
  const dirtyDocuments = useAppStore((state) => state?.dirtyDocuments) ?? EMPTY_FLAGS
  const savingDocuments = useAppStore((state) => state?.savingDocuments) ?? EMPTY_FLAGS
  const activeWorkspaceId = useAppStore((state) => state?.activeWorkspaceId) ?? null
  const candidates = useMemo(
    () => collectSurfaceMemoryCandidates({
      tabs,
      layouts,
      sessions,
      documents,
      dirtyDocuments,
      savingDocuments,
      activeWorkspaceId,
      workbenchVisible
    }),
    [activeWorkspaceId, dirtyDocuments, documents, layouts, savingDocuments, sessions, tabs, workbenchVisible]
  )
  const candidateKey = useMemo(
    () => candidates.map((candidate) => [
      candidate.id,
      candidate.kind,
      candidate.visible ? 'visible' : 'hidden',
      candidate.ownerPresent ? 'owned' : 'unowned',
      candidate.canRebuild ? 'rebuildable' : 'not-rebuildable',
      candidate.protected ? 'protected' : 'clear',
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
  const releaseCooldownUntilRef = useRef<number | null>(null)
  const [bookkeepingRevision, setBookkeepingRevision] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const now = Date.now()
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
      const wasContextActive = navigationContextByRegionRef.current.get(candidate.id)
      navigationContextByRegionRef.current.set(candidate.id, candidate.navigationContextActive)
      if (candidate.navigationContextActive && wasContextActive === false && !candidate.visible) {
        hiddenSinceByRegionRef.current.set(candidate.id, now)
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
        hiddenSinceByRegionRef.current.set(candidate.id, now)
        changed = true
      }
    }
    visibleRegionIdsRef.current = visibleNow
    if (measurementActive) {
      wasMeasuringRef.current = true
    } else if (wasMeasuringRef.current) {
      releaseCooldownUntilRef.current = now + 30_000
      wasMeasuringRef.current = false
      changed = true
    }
    if (workbenchVisible && !measurementActive) releaseCooldownUntilRef.current = null
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
    [bookkeepingRevision, candidateKey, candidates, nowMs]
  )
  const releaseCooldownUntilMs = releaseCooldownUntilRef.current
  const policy = useMemo(() => ({
    nowMs,
    parkingEnabled,
    measurementActive,
    releaseCooldownUntilMs
  }), [measurementActive, nowMs, parkingEnabled, releaseCooldownUntilMs])
  const released = useMemo(
    () => selectSurfaceMemoryReleases(stampedCandidates, policy),
    [policy, stampedCandidates]
  )
  const deadlineKey = useMemo(
    () => stampedCandidates.map((candidate) => [
      candidate.id,
      candidate.kind,
      candidate.hiddenSinceMs ?? 'none',
      candidate.visible ? 'visible' : 'hidden',
      candidate.ownerPresent ? 'owned' : 'unowned',
      candidate.canRebuild ? 'rebuildable' : 'not-rebuildable',
      candidate.protected ? 'protected' : 'clear',
      candidate.navigationContextActive ? 'context-active' : 'context-hidden'
    ].join(':')).join('|'),
    [stampedCandidates]
  )
  useEffect(() => {
    const delayMs = nextSurfaceMemoryDeadlineMs(stampedCandidates, policy)
    if (delayMs === null) return
    const timer = window.setTimeout(() => setNowMs(Date.now()), delayMs)
    return () => window.clearTimeout(timer)
  }, [deadlineKey, policy, stampedCandidates])

  return useMemo(() => ({
    monacoRegionIds: new Set(
      [...released].filter((id) => stampedCandidates.some((candidate) => candidate.id === id && candidate.kind === 'monaco'))
    ),
    browserRegionIds: new Set(
      [...released].filter((id) => stampedCandidates.some((candidate) => candidate.id === id && candidate.kind === 'browser'))
    )
  }), [released, stampedCandidates])
}
