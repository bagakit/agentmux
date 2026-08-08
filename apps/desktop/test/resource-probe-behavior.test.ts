import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DESKTOP_SESSION_ATTRIBUTE, desktopActionSelector } from '../src/shared/desktop-actions.js'

/**
 * Behavioural guards for `runDesktopResourceProbe`.
 *
 * WHY THIS FILE EXISTS. `resource-probe-contract.test.ts` next to it reads the probe's SOURCE
 * TEXT and asserts names/strings are present. That shape cannot observe three properties it was
 * believed to hold — all three were confirmed by mutation on 2026-09-07, each leaving that suite
 * at `8 passed (8)`:
 *   1. swapping two entries of the report's `phaseOrder` literal,
 *   2. making `diagnosticWorkingSet` throw instead of returning an `exceeded` observation,
 *   3. inserting an early `throw error` at the top of the `catch` block, so the session cleanup
 *      and the error receipt never run.
 * A text scan cannot see any of these, because it never EXECUTES the probe: an early return is
 * invisible to `toContain`, and a hand-written literal is "present" whatever order it is in.
 *
 * These three seeded the file; each guard was then hardened against the adjacent one-line
 * regressions a careless edit could make and that the first draft still let through (all confirmed
 * by mutation): dropping OR substituting a `phaseOrder` entry (not just swapping two), a release-
 * family reduction taking the wrong operand (`released`→`idle`, `Math.max`→`Math.min`), a limit
 * constant relaxed or cross-wired to a neighbour, a fresh diagnostics gate on a release-family
 * limit (not just the two original message strings the contract test blocklists), and a `.catch`
 * dropped from either cleanup stop so a rejecting teardown aborts the rest. Where a property is
 * deliberately left unguarded, the test that would own it says so at its site.
 *
 * MECHANISM. Six of the seven tests drive the real exported `runDesktopResourceProbe` end to end
 * against fakes (Electron, the renderer's `executeJavaScript` surface, and a `RuntimeController`
 * state machine), then assert on the artefact the probe actually produced — the report it wrote and
 * the `stopSession` calls the runtime actually received. The one exception is the
 * `diagnosticWorkingSet` boundary test, which says so at its own site: it calls the exported
 * `diagnosticWorkingSet` directly to pin the boundary the end-to-end plans never land on (equal
 * operands). Both shapes EXECUTE production code; neither is a source-text scan.
 *
 * KNOWN BLIND SPOTS, stated so nobody reads more into these tests than they check:
 *   - The fake renderer answers `executeJavaScript` by matching substrings of the injected source.
 *     It therefore pins the probe's OBSERVABLE SEQUENCE and BOOKKEEPING, not that any selector
 *     matches real AgentMux DOM. A renderer-side rename that keeps the probe's own strings intact
 *     stays green here; only `pnpm test:resources` (the real Electron run) covers that.
 *   - Working-set numbers here are fixture-planned, not measured, so nothing in this file says
 *     anything about real memory. The plans are chosen only to make the probe's arithmetic and
 *     branch selection observable, which is why some plans are deliberately non-physical (the
 *     terminal sample dips back down at the monaco sample in one; a single release cycle spikes to
 *     1.1 GiB in another).
 *   - The harness's own filesystem cleanup (`measure-desktop-resources.mjs`) is out of scope: it
 *     is a separate process and is still only text-scanned by the sibling contract test. In
 *     particular its `assertProbePathsRemoved()` is guarded only by a name-presence `toContain` in
 *     that contract test, so an early return there (leaked temp dirs) is not observable from this
 *     file and would need an execution-based test in that harness — a known open gap, not covered
 *     here.
 *   - The fake `getAppMetrics` returns a single `type: 'Browser'` process, so `sample()`'s
 *     per-process bucketing (`processWorkingSetKiB` main/renderer/gpu/utility/other) is only ever
 *     exercised on the `main` bucket. Nothing here asserts that split is attributed correctly; a
 *     `totalWorkingSetKiB` that is driven end-to-end must not be over-read as "attribution is
 *     validated". Only the real Electron run has multiple process types to attribute.
 *   - The renderer heap/GC branch is not exercised: the fake answers the heap probe with
 *     `supported:false`, so `rendererMemory()`'s expose-gc path is never taken here.
 *   - `resourceIdentity()`'s env-var parsing is not exercised: the fixture leaves
 *     `AGENTMUX_DESKTOP_RESOURCE_IDENTITY` unset, so only the null-identity shape is observed.
 */

// The fakes are installed by `vi.mock`, which is hoisted above the imports, so the per-test world
// is reached through a mutable holder rather than captured directly.
const hoisted = vi.hoisted(() => {
  const holder: { world: null | { getAppMetrics: () => unknown[]; browserWebContentsCount: () => number; fileWatchers: () => number } } = {
    world: null
  }
  const active = () => {
    if (!holder.world) throw new Error('Resource-probe fake world was not installed for this test.')
    return holder.world
  }
  return {
    holder,
    getAppMetrics: () => active().getAppMetrics(),
    // The probe filters its own webContents out of this list, so the fake returns that many
    // foreign entries and nothing resembling `window.webContents`.
    getAllWebContents: () => Array.from({ length: active().browserWebContentsCount() }, (_, index) => ({ id: index })),
    fileWatchers: () => active().fileWatchers()
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppMetrics: hoisted.getAppMetrics },
  webContents: { getAllWebContents: hoisted.getAllWebContents }
}))
// `resource-probe.ts` imports these only for their types, but the module graph still loads them and
// both touch Electron at module scope. Stubbing the classes keeps this test about the probe.
vi.mock('../src/main/config-store.js', () => ({ ConfigStore: class {} }))
vi.mock('../src/main/runtime-controller.js', () => ({ RuntimeController: class {} }))
vi.mock('../src/main/workspace-files.js', () => ({
  workspaceFileObserverCount: () => hoisted.fileWatchers()
}))

const { runDesktopResourceProbe, diagnosticWorkingSet } = await import('../src/main/resource-probe.js')

const openBrowserSelector = desktopActionSelector('openBrowser')

const temporaryRoots: string[] = []
afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

type WorkspaceKey = 'a' | 'b' | 'c'

const WORKSPACES: Record<WorkspaceKey, { id: string; hostId: string; path: string }> = {
  a: { id: 'resource-workspace-a', hostId: 'local', path: '/tmp/agentmux-resource/a' },
  b: { id: 'resource-workspace-b', hostId: 'local', path: '/tmp/agentmux-resource/b' },
  c: { id: 'resource-workspace-c', hostId: 'local', path: '/tmp/agentmux-resource/c' }
}

/** Owner counts the probe demands of a clean, ready reusable-Terminal launcher. */
const READY_LAUNCHER_OWNERS = {
  browserWebContents: 0,
  monacoEditors: 0,
  monacoModels: 0,
  documents: 0,
  fileWatchers: 0,
  runtimeSubscriptions: 4,
  terminalViews: 1,
  terminalAddons: 3,
  terminalListeners: 7,
  sessionAttachmentOwners: 1,
  sessionAttachmentLeases: 1
}

/** One mounted Terminal view's worth of owners, added on navigation / new Tab, removed on release. */
const TERMINAL_VIEW_BUNDLE = {
  terminalViews: 1,
  terminalAddons: 3,
  terminalListeners: 7,
  sessionAttachmentOwners: 1,
  sessionAttachmentLeases: 1
}

/** `sample()` calls `app.getAppMetrics()` exactly this many times and averages the results. */
const METRICS_CALLS_PER_SAMPLE = 5

/**
 * Number of `sample()` calls on the probe's happy path. Asserted (not assumed) by every drive, so
 * that a change to the probe's sampling shape fails loudly here instead of silently invalidating a
 * working-set plan indexed by sample number.
 */
const EXPECTED_SAMPLE_COUNT = 15

type FailurePoint = 'none' | 'terminal-write'

function createWorld(options: { plan: readonly number[]; failAt: FailurePoint; rejectStopIds?: readonly string[] }) {
  const owners: Record<string, number> = { ...READY_LAUNCHER_OWNERS }
  const launcher: Record<WorkspaceKey, string | null> = { a: null, b: null, c: null }
  const running = new Map<string, Record<string, unknown>>()
  const xterm: Record<WorkspaceKey, boolean> = { a: false, b: false, c: false }
  const monaco: Record<WorkspaceKey, boolean> = { a: false, b: false, c: false }
  const stoppedRunIds: string[] = []
  let visible: WorkspaceKey = 'a'
  let metricsCalls = 0
  let sessionCounter = 0
  let stopCount = 0

  const adjust = (delta: Record<string, number>, sign: 1 | -1) => {
    for (const [name, value] of Object.entries(delta)) owners[name] = (owners[name] ?? 0) + sign * value
  }

  const spawnLauncher = (key: WorkspaceKey): string => {
    sessionCounter += 1
    const id = `session-${sessionCounter}`
    const workspace = WORKSPACES[key]
    launcher[key] = id
    running.set(id, {
      id,
      kind: 'terminal',
      providerId: null,
      processState: 'running',
      hostId: workspace.hostId,
      workspacePath: workspace.path,
      label: id,
      createdAt: 0,
      updatedAt: 0,
      status: { state: 'idle', source: 'process', observedAt: 0 },
      latestOutputBytes: 0,
      control: { kind: 'terminal', hostId: workspace.hostId, runId: id, run: { runId: id } }
    })
    return id
  }

  // Selectors reach the fake JSON-escaped (`data-workspace-id=\"…\"`), so every textual probe below
  // matches against an unescaped copy.
  const plain = (source: string) => source.replace(/\\"/g, '"')

  const workspaceOf = (source: string): WorkspaceKey => {
    const match = plain(source).match(/data-workspace-id="([^"]+)"/)
    if (match) {
      for (const key of ['a', 'b', 'c'] as const) if (WORKSPACES[key].id === match[1]) return key
    }
    return 'c'
  }

  const handleClick = (rawSource: string) => {
    const source = plain(rawSource)
    const key = workspaceOf(rawSource)
    // Claiming promotes the ready launcher into the measured Terminal. Owner-neutral by design:
    // `claimLauncherTerminal` waits for the counts to equal its `expectedOwners`.
    if (source.includes(`getAttribute("${DESKTOP_SESSION_ATTRIBUTE}") ===`)) {
      xterm[key] = true
      launcher[key] = null
      return
    }
    if (source.includes(openBrowserSelector)) {
      adjust(TERMINAL_VIEW_BUNDLE, -1)
      owners.browserWebContents += 1
      return
    }
    if (source.includes('button[title="New tab"]')) {
      spawnLauncher(key)
      adjust(TERMINAL_VIEW_BUNDLE, 1)
      return
    }
    if (source.includes('aria-label="Close resource-probe.ts"')) {
      monaco[key] = false
      adjust({ monacoEditors: 1, monacoModels: 1, documents: 1, fileWatchers: 1 }, -1)
      return
    }
    if (source.includes('aria-label="Close New Tab"')) {
      adjust(TERMINAL_VIEW_BUNDLE, 1)
      owners.browserWebContents -= 1
      return
    }
    if (source.includes('project-rail-row')) {
      visible = key
      spawnLauncher(key)
      adjust(TERMINAL_VIEW_BUNDLE, 1)
      return
    }
    if (source.includes('data-tree-path')) {
      monaco[key] = true
      adjust({ monacoEditors: 1, monacoModels: 1, documents: 1, fileWatchers: 1 }, 1)
    }
  }

  const executeJavaScript = async (source: string): Promise<unknown> => {
    // The probe's own inline script strips `observed` before returning, so the fake answers with
    // the already-stripped shape. Including `observed` here makes the probe reject it as an
    // invalid owner count.
    if (source.includes('resource-owner-counts')) {
      return {
        monacoEditors: owners.monacoEditors,
        monacoModels: owners.monacoModels,
        documents: owners.documents,
        runtimeSubscriptions: owners.runtimeSubscriptions,
        terminalViews: owners.terminalViews,
        terminalAddons: owners.terminalAddons,
        terminalListeners: owners.terminalListeners
      }
    }
    if (source.includes('usedJSHeapSize')) {
      return {
        supported: false,
        gcAvailable: false,
        heapUsedBeforeKiB: null,
        heapUsedAfterGcKiB: null,
        heapTotalKiB: null,
        note: 'fixture renderer exposes no heap metrics'
      }
    }
    if (source.includes('hiddenWorkspaceCount')) {
      return {
        workspaceSlots: [
          { id: WORKSPACES.a.id, visible: false, tabs: 1, terminalTabs: 1 },
          { id: WORKSPACES.b.id, visible: false, tabs: 1, terminalTabs: 1 },
          { id: WORKSPACES.c.id, visible: true, tabs: 2, terminalTabs: 2 }
        ],
        hiddenWorkspaceCount: 2
      }
    }
    if (source.includes('activeWorkspaceRows')) return {}
    if (source.includes('?? null')) return launcher[workspaceOf(source)]
    if (source.includes('target?.click()')) {
      handleClick(source)
      return true
    }
    if (source.startsWith('Boolean(')) {
      const key = workspaceOf(source)
      const plainSource = plain(source)
      if (plainSource.includes('.xterm')) return xterm[key]
      if (plainSource.includes('.monaco-editor')) return monaco[key]
      if (plainSource.includes('data-visible=')) return visible === key
      if (plainSource.includes('data-workbench-tab-id=') && plainSource.includes('file:')) return monaco[key]
      if (plainSource.includes('data-tree-path')) return true
      if (plainSource.includes(DESKTOP_SESSION_ATTRIBUTE)) {
        const match = plainSource.match(new RegExp(`${DESKTOP_SESSION_ATTRIBUTE}="([^"]+)"`))
        return match ? running.has(match[1]!) : false
      }
      return false
    }
    return null
  }

  const world = {
    getAppMetrics: () => {
      const index = Math.floor(metricsCalls / METRICS_CALLS_PER_SAMPLE)
      metricsCalls += 1
      const workingSetSize = options.plan[index] ?? options.plan.at(-1) ?? 0
      // One process keeps `totalWorkingSetKiB` equal to the planned number for this sample: the
      // probe averages the five reads per sample, and all five are identical.
      return [{ pid: 1, type: 'Browser', memory: { workingSetSize, privateBytes: 0 } }]
    },
    browserWebContentsCount: () => owners.browserWebContents,
    fileWatchers: () => owners.fileWatchers,
    sampleCount: () => Math.floor(metricsCalls / METRICS_CALLS_PER_SAMPLE),
    stoppedRunIds,
    window: { webContents: { executeJavaScript } },
    runtime: {
      resourceOwnerCounts: () => ({
        sessionAttachmentOwners: owners.sessionAttachmentOwners,
        sessionAttachmentLeases: owners.sessionAttachmentLeases
      }),
      snapshot: async () => ({ sessions: [...running.values()], timelines: {}, recoveryCandidates: [] }),
      write: async (control: { runId: string }) => {
        if (options.failAt === 'terminal-write') throw new Error(FAILURE_MESSAGE)
        const session = running.get(control.runId)
        if (session) session.latestOutputBytes = 300_000
      },
      stopSession: async (control: { runId: string }) => {
        // A stop the fixture is told to reject models a runtime whose teardown fails. The probe's
        // cleanup wraps each stop in `.catch(() => {})`, so a rejection here must NOT abort the rest
        // of cleanup nor replace the original failure — the rejecting-stop test asserts exactly that.
        // Throwing before any bookkeeping keeps the rejected id out of `stoppedRunIds`, so "the
        // others were still stopped" is observable.
        if (options.rejectStopIds?.includes(control.runId)) {
          throw new Error(`fixture forced stopSession to reject for ${control.runId}`)
        }
        stoppedRunIds.push(control.runId)
        running.delete(control.runId)
        stopCount += 1
        // The probe's first stop retires the hidden Workspace-C Tab, leaving one fewer mounted
        // view. Later stops release the measured Terminal, which the surface immediately replaces
        // with a fresh ready launcher, so those are owner-neutral.
        if (stopCount === 1) adjust(TERMINAL_VIEW_BUNDLE, -1)
        else spawnLauncher('c')
      }
    },
    seed: () => spawnLauncher('a')
  }
  return world
}

const FAILURE_MESSAGE = 'fixture forced the measured Terminal write to fail'

const CONFIG = {
  workspaces: [
    { id: WORKSPACES.a.id, name: 'A', hostId: WORKSPACES.a.hostId, path: WORKSPACES.a.path, kind: 'folder' },
    { id: WORKSPACES.b.id, name: 'B', hostId: WORKSPACES.b.hostId, path: WORKSPACES.b.path, kind: 'folder' },
    { id: WORKSPACES.c.id, name: 'C', hostId: WORKSPACES.c.hostId, path: WORKSPACES.c.path, kind: 'folder' },
    { id: '__scratch__', name: 'Scratch', hostId: 'local', path: '/tmp/agentmux-resource/scratch', kind: 'folder' }
  ]
}

type Drive = {
  resolved: boolean
  error: unknown
  report: Record<string, any> | null
  stoppedRunIds: readonly string[]
  sampleCount: number
}

async function driveProbe(options: {
  plan: readonly number[]
  failAt?: FailurePoint
  rejectStopIds?: readonly string[]
}): Promise<Drive> {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-resource-probe-behavior-'))
  temporaryRoots.push(directory)
  const reportPath = join(directory, 'report.json')
  const previousReportPath = process.env.AGENTMUX_DESKTOP_RESOURCE_REPORT
  process.env.AGENTMUX_DESKTOP_RESOURCE_REPORT = reportPath

  const world = createWorld({
    plan: options.plan,
    failAt: options.failAt ?? 'none',
    rejectStopIds: options.rejectStopIds
  })
  hoisted.holder.world = world
  world.seed()

  let resolved = false
  let error: unknown = null
  let settled = false

  vi.useFakeTimers()
  try {
    const run = runDesktopResourceProbe({
      window: world.window as never,
      runtime: world.runtime as never,
      configStore: { get: async () => CONFIG } as never,
      startup: { spawnedAtMs: 0, appReadyAtMs: 0, windowCreationStartedAtMs: 0, rendererLoadedAtMs: 0 }
    }).then(
      (value) => {
        resolved = value
        settled = true
      },
      (reason) => {
        error = reason
        settled = true
      }
    )
    // The probe sleeps on real `setTimeout` and measures deadlines with `Date.now()`; advancing the
    // fake clock in slices drives all seven release cycles in milliseconds of wall time. The cap
    // makes a genuine hang fail the test instead of spinning forever.
    for (let tick = 0; tick < 40_000 && !settled; tick += 1) await vi.advanceTimersByTimeAsync(200)
    await run
  } finally {
    vi.useRealTimers()
    hoisted.holder.world = null
    if (previousReportPath === undefined) delete process.env.AGENTMUX_DESKTOP_RESOURCE_REPORT
    else process.env.AGENTMUX_DESKTOP_RESOURCE_REPORT = previousReportPath
  }

  expect(settled, 'probe never settled inside the fake-clock budget').toBe(true)
  // Read the report defensively: a mutation that skips the receipt write leaves no file, and an
  // ENOENT thrown here would surface as a harness crash rather than as a failed assertion at the
  // test that expected a receipt. `null` lets the test's own `report.*` assertion be the thing that
  // goes red.
  let report: Record<string, any> | null = null
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, any>
  } catch {
    report = null
  }
  return {
    resolved,
    error,
    report,
    stoppedRunIds: world.stoppedRunIds,
    sampleCount: world.sampleCount()
  }
}

/** Strictly increasing plan: each sample's total is unique and ordered, so sampling ORDER is readable. */
const ASCENDING_PLAN = Array.from({ length: EXPECTED_SAMPLE_COUNT }, (_, index) => 400_000 + index * 10_000)

describe('desktop resource probe behaviour', () => {
  it('reports phaseOrder in the order the phases were actually sampled', async () => {
    const drive = await driveProbe({ plan: ASCENDING_PLAN })

    expect(drive.error).toBeNull()
    expect(drive.resolved).toBe(true)
    // Guards the plan's indexing: if the probe's sampling shape changes, fail here rather than
    // silently comparing against a mis-aligned plan.
    expect(drive.sampleCount).toBe(EXPECTED_SAMPLE_COUNT)

    const declared = drive.report.phaseOrder as string[]

    // IDENTITY + COMPLETENESS. The receipt must name exactly these six stages, in this order.
    // Asserting the whole sequence (not just "length > 1" plus a one-directional subset check) is
    // what makes a DROPPED entry red (five entries !== six) and a SUBSTITUTED one red (a real label
    // like 'terminal-baseline' swapped in for 'browser' — both are sampled, so the ascending check
    // below cannot tell them apart, but this equality can). The literal is duplicated from the
    // probe's own `phaseOrder` on purpose: it is an external anchor, so a change to the production
    // literal must be mirrored here deliberately rather than tracked automatically.
    expect(declared).toEqual([
      'idle',
      'single-hidden-workspace',
      'multiple-hidden-workspaces-tabs',
      'terminal',
      'monaco',
      'browser'
    ])

    // Each sample carries its own `label`, so the declared stage names are resolved against the
    // sampled phases without a hand-copied kebab->camel map that could drift on its own.
    const sampledByLabel = new Map<string, { label: string; totalWorkingSetKiB: number }>()
    for (const phase of Object.values(drive.report.phases) as Array<{ label: string; totalWorkingSetKiB: number }>) {
      sampledByLabel.set(phase.label, phase)
    }

    // A stage the receipt names but never sampled would make the ordering check vacuous.
    expect(declared.filter((name) => !sampledByLabel.has(name))).toEqual([])

    // THE ORDERING CRITERION (now that identity is pinned above, this guards ORDER specifically).
    // Under an ascending plan a later sample always has a larger working set, so the sequence of
    // working sets along `phaseOrder` reveals the true sampling order. Requiring it to increase
    // STRICTLY ties the declared order to the observed one: reordering the underlying `sample()`
    // calls inverts a pair here. A degenerate fixture cannot satisfy this either, since equal totals
    // fail strict increase — so these two lines double as the non-vacuity self-check for the
    // identity assertion above.
    const declaredTotals = declared.map((name) => sampledByLabel.get(name)!.totalWorkingSetKiB)
    const ascending = [...declaredTotals].sort((left, right) => left - right)
    expect(declaredTotals).toEqual(ascending)
    expect(new Set(declaredTotals).size).toBe(declaredTotals.length)
  })

  it('reports an exceeded working-set limit as an observation and still completes', async () => {
    /**
     * Mixed plan: some diagnostics land over their reference limit and some under, so neither
     * "always exceeded" nor "never exceeded" can satisfy the per-entry check below. The dip at the
     * monaco sample is deliberately non-physical — it exists to put `terminalIncrement` over its
     * limit while `editorIncrement` stays under, which a monotonic plan cannot do.
     */
    const plan = [...ASCENDING_PLAN]
    plan[3] = 500_000 // terminal-baseline
    plan[4] = 800_000 // terminal          -> increment 300_000 > 262_144, exceeds
    plan[5] = 600_000 // monaco            -> increment 100_000 < 524_288, within
    plan[6] = 500_000 // released-panes
    for (let cycle = 7; cycle <= 12; cycle += 1) plan[cycle] = 500_000 // steady release cycles: zero drift
    plan[13] = 900_000 // browser          -> increment 400_000 > 262_144, exceeds
    plan[14] = 520_000 // browser-released -> increment  20_000 < 262_144, within

    const drive = await driveProbe({ plan })

    // A diagnostics path that throws instead of reporting fails right here.
    expect(drive.error).toBeNull()
    expect(drive.resolved).toBe(true)

    const observations = drive.report.diagnostics.workingSet as Record<
      string,
      { actualKiB: number; limitKiB: number; exceeded: boolean }
    >
    const reportedNames = drive.report.diagnostics.exceededWorkingSetDiagnostics as string[]

    // Self-check: the exceeded branch must actually be exercised, and the within-limit branch too,
    // or the agreement checks below would hold vacuously.
    const over = Object.entries(observations).filter(([, entry]) => entry.actualKiB > entry.limitKiB)
    const under = Object.entries(observations).filter(([, entry]) => entry.actualKiB <= entry.limitKiB)
    expect(over.length).toBeGreaterThan(0)
    expect(under.length).toBeGreaterThan(0)

    // OPERAND PINS. The flag-agreement and summary checks below both read the reported `actualKiB`,
    // so they cannot see WHICH sample-minus-baseline produced it: a call site that subtracted the
    // wrong baseline (e.g. `terminalSample - idle` instead of `- terminalBaseline`), or reduced with
    // `Math.min` instead of `Math.max`, would report a different number that still classifies the
    // same way and would survive every other assertion here. Pinning the observations to literals
    // hand-computed from this plan closes that: the values are derived from the fixture (idle
    // 400_000, terminal-baseline 500_000, terminal 800_000, monaco 600_000, released 500_000 with
    // every steady release cycle also 500_000, browser 900_000, browser-released 520_000), NOT
    // recomputed from production output, so they stay fixed when an operand is mutated. This is the
    // thing the isolated `diagnosticWorkingSet` unit test cannot cover, since it never sees the call
    // sites' operands.
    //
    // `diagnosticWorkingSet` has SEVEN call sites; these pins cover SIX of them. The lone exception
    // is `releaseDrift`: this plan forces the steady release cycles to a constant, so drift is
    // identically 0 and a wrong reduction operand cannot be distinguished from a right one at that
    // value. Making it observable would need a different fixture; it is named here rather than left
    // to look covered.
    expect(observations.terminalIncrement.actualKiB).toBe(300_000) // 800_000 − terminalBaseline 500_000
    expect(observations.editorIncrement.actualKiB).toBe(100_000) // 600_000 − terminalBaseline 500_000
    expect(observations.browserIncrement.actualKiB).toBe(400_000) // 900_000 − released 500_000
    expect(observations.browserReleasedIncrement.actualKiB).toBe(20_000) // 520_000 − released 500_000
    // Release-family reductions. `maxReleasedTotal` is the PEAK working set across the release cycles
    // and the browser-released sample (here 520_000, the browser-released value); `maxReleasedIncrement`
    // is that peak minus the first released-panes sample (520_000 − 500_000). Pinning both closes the
    // reduction-operand axis: `released`→`idle` in the increment baseline, or `Math.max`→`Math.min`
    // in the peak, changes these numbers while leaving every flag self-consistent.
    expect(observations.maxReleasedTotal.actualKiB).toBe(520_000) // max(release cycles 500_000, browser-released 520_000)
    expect(observations.maxReleasedIncrement.actualKiB).toBe(20_000) // 520_000 − released 500_000

    // LIMIT PINS. The flag-agreement check below recomputes `actual > limit` from the REPORTED
    // `limitKiB`, so BOTH sides of that comparison move together when a limit constant is relaxed or
    // cross-wired — it proves the observation is internally consistent, not that it was measured
    // against the RIGHT limit. Pinning each increment's `limitKiB` to its intended constant closes
    // both axes at once: relaxing MAX_TERMINAL_INCREMENT_KIB (magnitude) and measuring
    // terminalIncrement against MAX_EDITOR_INCREMENT_KIB (identity) each fail here. The expected
    // values are the design constants, not reads of production, so they do not drift with the
    // mutation. This covers the four increment limits only; the three release-family limits are left
    // unpinned on the limit axis and said so rather than implied closed.
    expect(observations.terminalIncrement.limitKiB).toBe(262_144) // MAX_TERMINAL_INCREMENT_KIB = 256 * 1024
    expect(observations.editorIncrement.limitKiB).toBe(524_288) // MAX_EDITOR_INCREMENT_KIB = 512 * 1024
    expect(observations.browserIncrement.limitKiB).toBe(262_144) // MAX_BROWSER_INCREMENT_KIB = 256 * 1024
    expect(observations.browserReleasedIncrement.limitKiB).toBe(262_144) // MAX_BROWSER_RELEASED_INCREMENT_KIB = 256 * 1024

    // THE CRITERION, two halves. Every observation's flag must agree with its own numbers (so a
    // constant `true` or `false` is caught by whichever half it contradicts), and the summary list
    // must name exactly the flagged ones (so an inverted or dropped filter is caught).
    for (const [name, entry] of Object.entries(observations)) {
      expect(entry.exceeded, `${name} flag disagrees with its own actual/limit`).toBe(entry.actualKiB > entry.limitKiB)
    }
    expect([...reportedNames].sort()).toEqual(over.map(([name]) => name).sort())

    // The receipt must keep saying these limits are diagnostic, since that is what licenses
    // completing with an exceedance rather than failing.
    expect(drive.report.budgets.mode).toBe('diagnostic-only')
  })

  it('keeps every working-set limit an observation when nothing exceeds', async () => {
    // The other side of the branch: an all-within-limits run must report an empty exceeded list
    // rather than inventing one.
    const drive = await driveProbe({ plan: ASCENDING_PLAN })

    expect(drive.resolved).toBe(true)
    const observations = drive.report.diagnostics.workingSet as Record<
      string,
      { actualKiB: number; limitKiB: number; exceeded: boolean }
    >
    expect(Object.keys(observations).length).toBeGreaterThan(0)
    for (const [name, entry] of Object.entries(observations)) {
      expect(entry.exceeded, `${name} should be within its reference limit under the ascending plan`).toBe(false)
    }
    expect(drive.report.diagnostics.exceededWorkingSetDiagnostics).toEqual([])
  })

  /**
   * The diagnostics primitive on its own. The end-to-end drives above reach this function only at
   * the seven call sites the probe happens to have, with whatever operands the fixture plan
   * produces; this pins the function's own contract at the boundary those drives never land on.
   *
   * THE CRITERION is two-part, because either half alone is weak. First, an over-limit input must
   * RETURN rather than throw. The `expect(...).not.toThrow()` line states that property by name; it
   * is not the ONLY thing that catches a throwing implementation, because the `toEqual` assertion
   * that follows evaluates `diagnosticWorkingSet(...)` in argument position and so propagates a
   * throw before the matcher is entered. The line is kept as an explicit, self-documenting statement
   * of the "reports, does not gate" contract, not because it is uniquely necessary. Second, `exceeded`
   * is asserted against hand-written literals rather than against a recomputed `actual > limit`: a
   * recomputed expectation would drift along with the operator under mutation and be vacuously
   * true. The equal-operands case is listed explicitly because it is the boundary that separates
   * `>` from `>=`, and it is unreachable from the fixture plans above.
   */
  it('reports an over-limit working set instead of throwing, and puts the boundary at strictly greater', () => {
    // Over limit: the value this whole diagnostics path exists to report without aborting. Stated as
    // its own assertion (see the doc comment: the `toEqual` below would also catch a throw).
    expect(() => diagnosticWorkingSet(900_000, 500_000)).not.toThrow()
    expect(diagnosticWorkingSet(900_000, 500_000)).toEqual({
      actualKiB: 900_000,
      limitKiB: 500_000,
      exceeded: true
    })

    // Equal operands are NOT an exceedance. Nothing in the drives above reaches this case, so
    // turning `>` into `>=` would otherwise be a free mutation.
    expect(diagnosticWorkingSet(500_000, 500_000)).toEqual({
      actualKiB: 500_000,
      limitKiB: 500_000,
      exceeded: false
    })

    // Under limit, for the other side of the flag.
    expect(diagnosticWorkingSet(400_000, 500_000)).toEqual({
      actualKiB: 400_000,
      limitKiB: 500_000,
      exceeded: false
    })
  })

  it('stops every Terminal it still owns when a phase fails, and writes the error receipt', async () => {
    const drive = await driveProbe({ plan: ASCENDING_PLAN, failAt: 'terminal-write' })

    // The probe must re-throw after cleaning up: swallowing the failure would make the harness
    // treat a broken measurement as a good one.
    expect(drive.error).toBeInstanceOf(Error)
    expect((drive.error as Error).message).toBe(FAILURE_MESSAGE)
    expect(drive.resolved).toBe(false)

    /**
     * THE CRITERION. The fixture records every `stopSession` the runtime receives, in call order.
     * The asserted four-element sequence is ONE pre-failure stop plus THREE cleanup stops, and the
     * split is the point:
     *   - `session-3` (Workspace C's first Tab) is stopped by the probe's OWN happy path before the
     *     failure — it retires the primary C Tab so a single measured Terminal remains. It is not
     *     part of cleanup; it is here only because it genuinely precedes the failure in call order,
     *     and dropping it from the expectation would hide a real change to that pre-failure step.
     *   - The remaining three are what the `catch` block owes once the `terminal`-phase write throws
     *     while the probe still owns three Terminals: the current measured Terminal `session-4`
     *     first (the `terminalControl` stop), then the two still-live hidden ones `session-1`
     *     (Workspace A) and `session-2` (Workspace B) via the loop over `activeTerminalControls`.
     * The ids come from the fixture's own spawn order, never from the probe, and the exact order was
     * confirmed by instrumenting the fake (SPAWN 1/2/3/4 → STOP 3 → WRITE-THROW on 4 → STOP 4/1/2).
     *
     * Asserting the exact sequence — not merely "stopSession was called" — is what makes an early
     * return at the top of the catch block red: it drops the cleanup tail, leaving only `session-3`.
     * It also pins each half of the cleanup separately: removing the single `terminalControl` stop
     * drops `session-4`, and removing the loop over `activeTerminalControls` drops `session-1`/
     * `session-2` — each a distinct, independently-detected regression (verified by mutation).
     */
    expect(drive.stoppedRunIds).toEqual(['session-3', 'session-4', 'session-1', 'session-2'])

    // Third thing the cleanup owes: an error receipt naming the failure, so a failed run is not
    // mistaken for a missing one.
    expect(drive.report.error).toBe(FAILURE_MESSAGE)
    expect(drive.report.schema).toBe('agentmux.t001-desktop-resources.v2')
  })

  it('finishes cleanup and still re-throws the original failure when a Terminal stop itself rejects', async () => {
    /**
     * Cleanup wraps every `stopSession` in `.catch(() => {})`. There are TWO such sites in the catch
     * block — the single `terminalControl` stop, then the loop over `activeTerminalControls` — and a
     * dropped `.catch` on either is a real hazard: in production a rejecting teardown would abort the
     * rest of cleanup, skip the error-receipt write, and REPLACE the original failure with the stop's
     * own error. The sibling test above cannot see this because its fixture `stopSession` never
     * rejects, so both sites are exercised here by telling the fixture to reject one specific stop.
     * The two drives target the two sites separately, so each `.catch` is independently observable.
     */
    // DRIVE A — the FIRST cleanup stop rejects (the measured `terminalControl`, session-4, at the
    // `.catch` guarding the single stop). With the guard in place the rejection is swallowed and the
    // remaining hidden Terminals are still stopped; session-4 is absent from the record because the
    // fixture throws before recording it.
    const rejectedTerminalControl = await driveProbe({
      plan: ASCENDING_PLAN,
      failAt: 'terminal-write',
      rejectStopIds: ['session-4']
    })
    expect(rejectedTerminalControl.error).toBeInstanceOf(Error)
    expect((rejectedTerminalControl.error as Error).message).toBe(FAILURE_MESSAGE) // the ORIGINAL failure, not the stop's
    expect(rejectedTerminalControl.resolved).toBe(false)
    expect(rejectedTerminalControl.stoppedRunIds).toEqual(['session-3', 'session-1', 'session-2'])
    expect(rejectedTerminalControl.report?.error).toBe(FAILURE_MESSAGE) // receipt still written despite the rejecting stop

    // DRIVE B — a stop INSIDE the `activeTerminalControls` loop rejects (session-1, Workspace A). With
    // the loop's own `.catch` in place, session-4 (terminalControl) is stopped first, session-1 is
    // swallowed, and session-2 is still stopped after it.
    const rejectedLoopStop = await driveProbe({
      plan: ASCENDING_PLAN,
      failAt: 'terminal-write',
      rejectStopIds: ['session-1']
    })
    expect(rejectedLoopStop.error).toBeInstanceOf(Error)
    expect((rejectedLoopStop.error as Error).message).toBe(FAILURE_MESSAGE)
    expect(rejectedLoopStop.resolved).toBe(false)
    expect(rejectedLoopStop.stoppedRunIds).toEqual(['session-3', 'session-4', 'session-2'])
    expect(rejectedLoopStop.report?.error).toBe(FAILURE_MESSAGE)
  })

  it('reports a release-family working-set exceedance as an observation and still completes', async () => {
    /**
     * The exceedance test above drives only the INCREMENT-family diagnostics over their limits
     * (terminal/browser); its steady release cycles are held constant, so the three release-family
     * diagnostics (`maxReleasedTotal`, `maxReleasedIncrement`, `releaseDrift`) are never over their
     * limits there. That leaves the "diagnostics report, they do not gate" property observable for
     * only two of the seven diagnostics. This drive pushes the release family over instead: a single
     * release cycle spikes to 1_100_000 KiB, which the probe's own reductions turn into all three
     * release-family exceedances at once. A gate reinstated on ANY release reduction (e.g.
     * `if (maxReleasedWorkingSetKiB > MAX_RELEASED_TOTAL_KIB) throw`) would abort the probe, so
     * `resolved === true` here is what keeps that gate out.
     */
    const plan = [...ASCENDING_PLAN]
    plan[3] = 500_000 // terminal-baseline
    plan[4] = 520_000 // terminal          -> increment  20_000 < 262_144, within
    plan[5] = 510_000 // monaco            -> increment  10_000 < 524_288, within
    plan[6] = 500_000 // released-panes (the increment baseline for the release family)
    plan[7] = 500_000 // released-panes-2 (warmup cycle)
    plan[8] = 500_000 // released-panes-3 (first steady cycle, the drift baseline)
    plan[9] = 500_000 // released-panes-4
    plan[10] = 500_000 // released-panes-5
    plan[11] = 500_000 // released-panes-6
    plan[12] = 1_100_000 // released-panes-7: peak release working set, a steady cycle
    plan[13] = 700_000 // browser          -> increment 200_000 < 262_144, within
    plan[14] = 520_000 // browser-released -> increment  20_000 < 262_144, within

    const drive = await driveProbe({ plan })

    // A reinstated release-family gate throws inside the probe and fails right here.
    expect(drive.error).toBeNull()
    expect(drive.resolved).toBe(true)

    const observations = drive.report.diagnostics.workingSet as Record<
      string,
      { actualKiB: number; limitKiB: number; exceeded: boolean }
    >
    const reportedNames = drive.report.diagnostics.exceededWorkingSetDiagnostics as string[]

    // The three release-family reductions all land over their reference limits under this plan:
    //   maxReleasedTotal     = 1_100_000                       > 1_048_576  (MAX_RELEASED_TOTAL_KIB)
    //   maxReleasedIncrement = 1_100_000 − released 500_000    >   589_824  (MAX_RELEASED_INCREMENT_KIB)
    //   releaseDrift         = 1_100_000 − steady[0] 500_000   >   131_072  (MAX_RELEASE_DRIFT_KIB)
    // Pinning the operands keeps the exceedances from being an accident of some other arithmetic.
    expect(observations.maxReleasedTotal.actualKiB).toBe(1_100_000)
    expect(observations.maxReleasedIncrement.actualKiB).toBe(600_000)
    expect(observations.releaseDrift.actualKiB).toBe(600_000)
    expect(observations.maxReleasedTotal.exceeded).toBe(true)
    expect(observations.maxReleasedIncrement.exceeded).toBe(true)
    expect(observations.releaseDrift.exceeded).toBe(true)

    // Contrast: the increment family stays within, so this run genuinely isolates the release family
    // rather than tripping everything. The exceeded summary must name exactly the three that exceed.
    expect(observations.terminalIncrement.exceeded).toBe(false)
    expect(observations.browserIncrement.exceeded).toBe(false)
    expect([...reportedNames].sort()).toEqual(['maxReleasedIncrement', 'maxReleasedTotal', 'releaseDrift'])

    // Same license as the other exceedance test: completing with an exceedance is only allowed while
    // these limits are declared diagnostic.
    expect(drive.report.budgets.mode).toBe('diagnostic-only')
  })
})
