import type { SessionSnapshot } from '../../../shared/contracts'
import { surfaceNavigationVisibility } from './surface-navigation-visibility'
import type { WorkspaceLayout } from './workbench-layout'
import { documentKey, type WorkbenchSurface, type WorkbenchTab } from './workbench-tabs'
import { assertUnreachableSurface } from './workbench-surface-kinds'
import type { SurfaceMemoryCandidate } from './surface-memory-budget'

type Layouts = Readonly<Record<string, WorkspaceLayout>>
type Tabs = Readonly<Record<string, WorkbenchTab>>
type Documents = Readonly<Record<string, unknown>>

export type SurfaceMemoryCollectionInput = {
  tabs: Tabs
  layouts: Layouts
  sessions: readonly SessionSnapshot[]
  documents: Documents
  dirtyDocuments: Readonly<Record<string, boolean>>
  savingDocuments: Readonly<Record<string, boolean>>
  activeWorkspaceId: string | null
  workbenchVisible: boolean
}

function candidateForSurface(
  tab: WorkbenchTab,
  surface: WorkbenchSurface,
  input: SurfaceMemoryCollectionInput,
  sessionsById: ReadonlyMap<string, SessionSnapshot>,
  navigation: { navigationContextActive: boolean; tabVisible: boolean }
): SurfaceMemoryCandidate | null {
  const visible = navigation.tabVisible
  // Which kinds this independent budget can reclaim, decided in ONE exhaustive place. This used to be
  // `if (kind !== 'file' && kind !== 'browser') return null`, and that early-return was a silent leak:
  // a new heavyweight kind (a future embedded view, say) would fall straight through it, never become
  // a candidate, and so stay resident forever with nothing going red. The switch is exhaustive via
  // `assertUnreachableSurface`, so a 6th kind cannot compile until someone decides here whether it is
  // reclaimable — a `null` return is now a deliberate "not budgeted", not an accident of omission.
  // (Not a `Record<kind, …>`: file and browser build DIFFERENT candidate shapes, not a shared value.)
  switch (surface.kind) {
    case 'agent':
    case 'terminal':
    case 'launcher':
      // Terminal has its own replay/attachment contract (see surface-memory-budget.ts); agent/launcher
      // carry no releasable native owner in this budget. All three are intentionally not candidates.
      return null
    case 'file': {
      const key = documentKey(surface.workspaceId, surface.path)
      const documentPresent = Object.hasOwn(input.documents, key)
      return {
        id: surface.regionId,
        kind: 'monaco',
        visible,
        navigationContextActive: navigation.navigationContextActive,
        hiddenSinceMs: null,
        lastActivatedSeq: 0,
        ownerPresent: documentPresent,
        canRebuild: documentPresent,
        // The in-memory document is the rebuild source, but never release a dirty or actively
        // saving buffer: this keeps the budget from becoming an accidental data-loss path.
        protected: Boolean(input.dirtyDocuments[key] || input.savingDocuments[key])
      }
    }
    case 'browser': {
      const session = sessionsById.get(surface.browserId)
      // A Browser has no Core Session; the snapshot itself plus URL/Profile is the Main-owned rebuild
      // proof. `session` is intentionally unused, but reading the map here documents that Browser ids
      // are not Session ids and prevents a future implementation from borrowing terminal state.
      void session
      return {
        id: surface.regionId,
        kind: 'browser',
        visible,
        navigationContextActive: navigation.navigationContextActive,
        hiddenSinceMs: null,
        lastActivatedSeq: 0,
        ownerPresent: Boolean(surface.browserId),
        // URL, profile and viewport are the complete retained Browser projection needed by Main's
        // restore contract. Keep the viewport in this proof as well: restoring with a default viewport
        // would be a visible identity change even though the native owner could technically be rebuilt.
        canRebuild: Boolean(surface.browserId && surface.url && surface.profileId && surface.viewport),
        // Navigation in flight is not safe to discard: restoring it would change the page identity.
        protected: surface.loading
      }
    }
    default:
      return assertUnreachableSurface(surface)
  }
}

/** Build independent Browser/Monaco candidates from the Renderer projection. */
export function collectSurfaceMemoryCandidates(
  input: SurfaceMemoryCollectionInput
): SurfaceMemoryCandidate[] {
  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]))
  const candidates: SurfaceMemoryCandidate[] = []
  for (const tab of Object.values(input.tabs)) {
    const layout = input.layouts[tab.workspaceId]
    if (!layout) continue
    const navigation = surfaceNavigationVisibility(tab, layout, input.tabs, input)
    for (const surface of Object.values(tab.regions)) {
      const candidate = candidateForSurface(tab, surface, input, sessionsById, navigation)
      if (candidate) candidates.push(candidate)
    }
  }
  return candidates
}
