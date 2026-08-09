import { describe, expect, it } from 'vitest'
import { collectSurfaceMemoryCandidates } from '../src/renderer/src/lib/surface-memory-budget-candidates'
import { selectSurfaceMemoryReleases } from '../src/renderer/src/lib/surface-memory-budget'
import { projectPersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import {
  WORKBENCH_SURFACE_KINDS,
  isSessionSurface,
  surfaceCloseObligations
} from '../src/renderer/src/lib/workbench-surface-kinds'
import { addressableAgentSessionId } from '../src/renderer/src/lib/tab-control-handoff'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  initialWorkbenchRegionId,
  workbenchSurfaces,
  type WorkbenchSurface
} from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'

// The two REAL failure modes #491 is about, pinned as observable behavior (not source text).
//
// Both consumers used to decide "which surface kinds do I act on" with a hand-copied list. A kind
// missing from the list did NOT error — it fell through silently, and the consequence differed by
// consumer:
//   - the memory budget: a missing kind never became a reclamation candidate, so its native owner
//     stayed resident forever (a silent memory LEAK);
//   - persistence: a missing kind was silently dropped from the projected workbench, so that pane was
//     gone after restart (silent DATA LOSS).
// Both now route through an exhaustive switch whose `default` calls `assertUnreachableSurface`, so a
// kind the consumer does not handle can no longer slip through quietly — it is a loud, immediate
// failure. These tests exercise the real exported functions and assert that:
//   1. an ENROLLED heavyweight/persisted kind is observably reclaimed / observably survives — the
//      exact observable a de-enrolling regression (dropping the kind back out of the switch) flips;
//   2. a kind the consumer did NOT enrol cannot be handled silently — it is observably loud.
// Assertion 2 is what makes the leak/loss impossible to reintroduce by omission: the day a 6th kind is
// added and a maintainer forgets one of these consumers, this fails instead of leaking or losing data.

// A `WorkbenchSurface` whose `kind` is not one this build knows — the shape a future 6th kind takes
// before a maintainer wires it into every consumer. Cast is deliberate: the whole point is to model a
// kind the consumer's switch was never taught, which by construction is not in the static union.
function forgottenKindSurface(regionId: string): WorkbenchSurface {
  return { regionId, kind: 'diagram', workspaceId: 'ws', path: 'forgotten.ts' } as unknown as WorkbenchSurface
}

function browserTab(id: string): ReturnType<typeof createWorkbenchTab> {
  return createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'browser',
    workspaceId: 'ws',
    browserId: `br-${id}`,
    navigationId: `nav-${id}`,
    profileId: 'default',
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: 'responsive',
    error: null
  })
}

describe('the SSOT predicate itself: no kind may get a silent verdict', () => {
  // `isSessionSurface` is the predicate five consumers ask "is this a session" (session teardown,
  // on-screen visibility, cross-worktree move, the move-view menu, persisted-tab projection). Its
  // exhaustive switch is the thing that makes a 6th session-bearing kind a compile error rather than a
  // silent "no". Collapsing it to `default: return false` was measured to keep every other test in
  // both #491 suites green — tsc stays silent too (`noImplicitReturns` is off, and a `default` clause
  // means `surface` is never narrowed to `never`), and the persistence case below only asserts the
  // message text, which a downstream backstop also produces. So this predicate needs its own two
  // assertions: every known kind gets an explicit verdict, and an unknown kind is loud HERE.

  it('every kind in the union gets an explicit verdict — none falls through', () => {
    // Reading the verdict per kind is what a collapsed `default` cannot satisfy: with one catch-all
    // arm, 'agent' and 'terminal' answer false. Driven off WORKBENCH_SURFACE_KINDS so a 6th kind added
    // to the union arrives here automatically instead of being silently outside the loop.
    const verdicts = new Map<string, boolean>()
    for (const kind of WORKBENCH_SURFACE_KINDS) {
      verdicts.set(kind, isSessionSurface({ kind, regionId: 'r', workspaceId: 'ws' } as never))
    }
    expect([...verdicts.entries()].sort()).toEqual([
      ['agent', true],
      ['browser', false],
      ['file', false],
      ['launcher', false],
      ['terminal', true]
    ])
  })

  it('a kind outside the union is loud here, not quietly non-session', () => {
    // The failure mode the exhaustive default exists for. A catch-all `return false` would answer
    // "not a session" for a future session-bearing kind, and every one of the five consumers would
    // then tear down / hide / skip it without a word.
    expect(() => isSessionSurface(forgottenKindSurface('r'))).toThrow(
      /Unhandled workbench surface kind/
    )
  })
})

describe('close obligations: what a Region releases must be decided per kind, not fall through', () => {
  // `surfaceCloseObligations` replaced two independent single-kind questions at `closeRegion`'s call
  // site (`kind === 'browser'` → destroy the Main-side view, `kind === 'file'` → reconcile the shared
  // document projection). Measured before these assertions existed: flipping `file`'s
  // `releasesDocument` to false kept the whole desktop suite green — `closeRegion`'s two tests both
  // close an agent Region, so neither obligation is ever true in them. A wrong answer here is a
  // resource that is never released: an orphaned BrowserView, or a document owner that outlives its
  // last pane.

  it('every kind in the union gets an explicit obligation — none falls through', () => {
    // Per-kind, driven off WORKBENCH_SURFACE_KINDS so a 6th kind arrives here automatically. The
    // browser arm carries the surface's own id rather than a boolean, so the table pins the id too:
    // returning a null id for a browser would leave the native view alive with nothing pointing at it.
    const obligations = new Map<string, { browserViewId: string | null; releasesDocument: boolean }>()
    for (const kind of WORKBENCH_SURFACE_KINDS) {
      obligations.set(
        kind,
        surfaceCloseObligations({
          kind,
          regionId: 'r',
          workspaceId: 'ws',
          browserId: 'br-1'
        } as never)
      )
    }
    expect(Object.fromEntries(obligations)).toEqual({
      agent: { browserViewId: null, releasesDocument: false },
      terminal: { browserViewId: null, releasesDocument: false },
      file: { browserViewId: null, releasesDocument: true },
      launcher: { browserViewId: null, releasesDocument: false },
      browser: { browserViewId: 'br-1', releasesDocument: false }
    })
  })

  it('a kind outside the union is loud here, not quietly obligation-free', () => {
    // The silent-leak shape: a catch-all arm answers "nothing to release" for a future kind that owns
    // an OS-level resource, and `closeRegion` drops the pane while the resource stays alive.
    expect(() => surfaceCloseObligations(forgottenKindSurface('r'))).toThrow(
      /Unhandled workbench surface kind/
    )
  })
})

describe('Agent addressability: which Region can be named as an Agent', () => {
  // Deliberately NOT `isSessionSurface`: a Terminal has a `sessionId` but is not an Agent, and the
  // addresses this feeds (`agentmux send --to-session=…`) only resolve for an Agent. So the two
  // questions differ, and the terminal row below is what states that difference.

  it('only the Agent kind yields an address; every other kind explicitly yields none', () => {
    const verdicts = new Map<string, string | null>()
    for (const kind of WORKBENCH_SURFACE_KINDS) {
      verdicts.set(
        kind,
        addressableAgentSessionId({
          kind,
          regionId: 'r',
          workspaceId: 'ws',
          sessionId: 'session-1'
        } as never)
      )
    }
    expect(Object.fromEntries(verdicts)).toEqual({
      agent: 'session-1',
      // A Session, but not an Agent — this is the row that separates this decision from isSessionSurface.
      terminal: null,
      file: null,
      launcher: null,
      browser: null
    })
  })

  it('a kind outside the union is loud here, not quietly unaddressable', () => {
    // Silently answering null would make the Region's copy-address entries vanish for a future
    // Agent-bearing kind, with no compile error and nothing to see at runtime.
    expect(() => addressableAgentSessionId(forgottenKindSurface('r'))).toThrow(
      /Unhandled workbench surface kind/
    )
  })
})

describe('memory-budget consumer: a forgotten kind must not silently leak', () => {
  it('an off-screen Browser it DOES enrol is observably reclaimed (released)', () => {
    // Active file tab (on-screen) plus a background Browser in the same, active workspace. The Browser
    // is off-screen but its navigation context is still active, its native owner is present, and it is
    // rebuildable — the exact conditions under which the budget is allowed to release it.
    const activeTabId = 'file:ws:active.ts'
    const active = createWorkbenchTab(activeTabId, {
      regionId: initialWorkbenchRegionId(activeTabId),
      kind: 'file',
      workspaceId: 'ws',
      path: 'active.ts'
    })
    const background = browserTab('bg')
    const layout = createWorkspaceLayout('group', [activeTabId, 'bg'])

    const candidates = collectSurfaceMemoryCandidates({
      tabs: { [activeTabId]: active, bg: background },
      layouts: { ws: layout },
      sessions: [],
      documents: {},
      dirtyDocuments: {},
      savingDocuments: {},
      activeWorkspaceId: 'ws',
      workbenchVisible: true
    })

    // The Browser is a candidate; make it eligible by giving it a hidden timestamp, then release.
    const eligible = candidates.map((candidate) =>
      candidate.id === 'region:bg' ? { ...candidate, hiddenSinceMs: 0 } : candidate
    )
    const released = selectSurfaceMemoryReleases(eligible, {
      nowMs: 1_000_000,
      releaseDelayMs: 1,
      hotRetainMs: 1,
      hotRetainLimit: 0
    })

    // The observable: the enrolled Browser is reclaimable. If someone dropped `browser` back out of the
    // budget's switch (the pre-#491 shape), it would never be a candidate and this set would be empty —
    // the surface would be retained forever. That is the leak, expressed as a released-vs-retained fact.
    expect(released.has('region:bg')).toBe(true)
  })

  it('a kind it did NOT enrol cannot be silently skipped — it fails loudly instead of leaking', () => {
    // A tab holding a surface whose kind the budget's switch was never taught. Before #491 this fell
    // through `kind !== 'file' && kind !== 'browser'` and returned null — no candidate, no release, a
    // silent leak. Now the exhaustive default makes the omission observable: it throws rather than
    // quietly declaring the surface non-reclaimable.
    const tabId = 'view:forgotten'
    const tab = createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'file',
      workspaceId: 'ws',
      path: 'seed.ts'
    })
    tab.regions[initialWorkbenchRegionId(tabId)] = forgottenKindSurface(initialWorkbenchRegionId(tabId))
    const layout = createWorkspaceLayout('group', [tabId])

    expect(() =>
      collectSurfaceMemoryCandidates({
        tabs: { [tabId]: tab },
        layouts: { ws: layout },
        sessions: [],
        documents: {},
        dirtyDocuments: {},
        savingDocuments: {},
        activeWorkspaceId: 'other',
        workbenchVisible: true
      })
    ).toThrow(/Unhandled workbench surface kind/)
  })
})

describe('persistence consumer: a forgotten kind must not silently vanish', () => {
  it('a File pane it DOES enrol observably survives the persistence projection', () => {
    // A solo file tab. File panes are the half of the reported "restart lost my tabs" bug that must be
    // kept: the projection retains the tab with its file surface intact.
    const fileTabId = 'file:ws:kept.ts'
    const fileTab = createWorkbenchTab(fileTabId, {
      regionId: initialWorkbenchRegionId(fileTabId),
      kind: 'file',
      workspaceId: 'ws',
      path: 'kept.ts'
    })
    const layout = createWorkspaceLayout('group', [fileTabId])

    const projected = projectPersistedWorkbench({
      tabs: { [fileTabId]: fileTab },
      layouts: { ws: layout }
    })

    const kept = projected.tabs[fileTabId]
    expect(kept).toBeDefined()
    // The observable: the file surface is still there. If `file` were dropped back out of the survive
    // decision, the region would be stripped and the tab would collapse to nothing — data loss.
    expect(workbenchSurfaces(kept!).map((surface) => surface.kind)).toEqual(['file'])
  })

  it('a kind it did NOT enrol cannot be silently dropped — it fails loudly instead of losing the pane', () => {
    // An agent+unknown split. Before #491 the unknown region fell through the keep-list and was
    // silently removed (its pane lost across restart) while the agent survived — the loss was invisible.
    // Now the projection is exhaustive end to end: the unknown region is classified through the SSOT
    // (`isSessionSurface`, then `persistedSurfaceSurvives`), whose defaults call
    // `assertUnreachableSurface`, so an unhandled kind throws here rather than being quietly discarded.
    // (The positive test above is what pins `persistedSurfaceSurvives`'s own file-survives decision; the
    // first surface reached in this fixture trips the shared `isSessionSurface` backstop, which is the
    // guarantee this case exists to state — no surface reaches persistence without an exhaustive verdict.)
    const viewId = 'view:agent-forgotten'
    const left = initialWorkbenchRegionId(viewId)
    let tab = createWorkbenchTab(viewId, {
      regionId: left,
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'ws',
      sessionId: 'agent-1'
    })
    tab = addWorkbenchRegion(tab, left, 'right', {
      regionId: 'forgotten-region',
      kind: 'file',
      workspaceId: 'ws',
      path: 'placeholder.ts'
    })
    tab.regions['forgotten-region'] = forgottenKindSurface('forgotten-region')
    const layout = createWorkspaceLayout('group', [viewId])

    expect(() =>
      projectPersistedWorkbench({ tabs: { [viewId]: tab }, layouts: { ws: layout } })
    ).toThrow(/Unhandled workbench surface kind/)
  })
})
