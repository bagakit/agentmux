import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { addTabOccurrence, createWorkspaceLayout, moveTab, moveTabToNewGroup } from '@agentmux/layout'
import { parseAgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial, DesktopSpatialPersistence, SAVE_STALL_AFTER_MS } from '../src/renderer/src/lib/desktop-spatial-state'
import { reconcileSpatialGraphs } from '../src/renderer/src/lib/spatial-merge'
import { attachLauncherAgentPosition } from '../src/main/goal-discussion-handoff'
import { workfaceSaveRecorder } from '../src/renderer/src/lib/workface-save-diagnostics'
import type { AgentMuxClientIncidentReport } from '@agentmux/core/client-incident'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { AppConfig } from '../src/shared/contracts'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const config: AppConfig = { version: 9, hosts: [{ id: 'host', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [{ id: 'project', name: 'Project', hostId: 'host', path: fixturePath('save-integrity/project'), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const fileTab = (id: string) => createWorkbenchTab(id, { regionId: id + '-region', kind: 'file', workspaceId: 'project', path: id + '.md' })

/** The Renderer's own derivation of a workbench with these Tabs, in one display Group unless a layout is given. */
function derive(ids: string[], titles: Record<string, string> = {}, layout = createWorkspaceLayout('group', ids)) {
  const tabs = Object.fromEntries(ids.map(id => [id, { ...fileTab(id), ...(titles[id] ? { title: titles[id] } : {}) }]))
  return desktopSpatialGraph({ config, sessions: [], tabs, layouts: { project: layout }, spaceZoneBindings: {}, spatialRequests: {} } as never, [])
}
/** Tabs no display Group of the merged graph shows: they would exist but appear nowhere. */
const unshown = (graph: AgentMuxSpatialGraph) => {
  const shown = new Set(Object.values(graph.layouts).flatMap(layout => layout.groups.flatMap(group => group.tabOrder)))
  return graph.tabs.map(tab => tab.tabId).filter(id => !shown.has(id))
}

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function owner() {
  const directory = await mkdtemp(join(tmpdir(), 'amux-save-integrity-'))
  directories.push(directory)
  return new AgentMuxSpatialStateStore(join(directory, 'state.json'))
}
function client(store: AgentMuxSpatialStateStore, warnings: unknown[] = []) {
  return new DesktopSpatialPersistence({ read: () => store.read(), commit: input => store.commit(input), onChange: listener => store.subscribe(listener) },
    error => warnings.push(error))
}
/** Another writer changes one existing resource while the Renderer holds an older baseline. */
async function writeElsewhere(store: AgentMuxSpatialStateStore, edit: (graph: AgentMuxSpatialGraph) => void) {
  const current = (await store.read())!
  const graph = structuredClone(current.graph)
  edit(graph)
  await store.commit({ expectedRevision: current.revision, graph })
}

describe('one conflicting entity never stalls unrelated workface saves', () => {
  it('commits a new Tab while another writer holds a different value for one existing resource', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const warnings: unknown[] = [], persistence = client(store, warnings)
    await persistence.read()
    // Core accepts another writer's edit to Tab a. The Renderer has not observed it yet.
    await writeElsewhere(store, graph => { graph.resources['tab:a'] = { ...graph.resources['tab:a'] as object, title: 'Elsewhere' } })
    // The user retitles a and opens a new Tab b in the same Group.
    persistence.stage(derive(['a', 'b'], { a: 'Local' }))
    await persistence.flush().catch(() => undefined)
    const saved = (await store.read())!.graph
    expect(saved.tabs.map(tab => tab.tabId)).toContain('b')
    expect(saved.layouts.project!.groups[0]!.tabOrder).toEqual(['a', 'b'])
    // The conflicting key keeps the confirmed remote value and is reported by name.
    expect(saved.resources['tab:a']).toMatchObject({ title: 'Elsewhere' })
    expect(persistence.conflicts.map(conflict => conflict.key)).toEqual(['resources:tab:a'])
    expect(warnings.at(-1)).toMatchObject({ code: 'SPATIAL_ENTITY_CONFLICT' })
  })

  it('names a later local edit to an item another writer changed while this save was in flight', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const warnings: unknown[] = []
    let raced = false
    const persistence: DesktopSpatialPersistence = new DesktopSpatialPersistence({ read: () => store.read(), onChange: listener => store.subscribe(listener),
      commit: async input => {
        if (!raced) {
          raced = true
          // Another writer retitles a, and the user retitles it here from the value still on screen.
          await writeElsewhere(store, graph => { graph.resources['tab:a'] = { ...graph.resources['tab:a'] as object, title: 'Elsewhere' } })
          persistence.stage(derive(['a', 'b'], { a: 'Local' }))
        }
        return store.commit(input)
      } }, error => warnings.push(error))
    await persistence.read()
    persistence.stage(derive(['a', 'b']))
    await persistence.flush().catch(() => undefined)
    const saved = (await store.read())!.graph
    expect(saved.tabs.map(tab => tab.tabId)).toEqual(['a', 'b'])
    expect(saved.resources['tab:a']).toMatchObject({ title: 'Elsewhere' })
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'SPATIAL_ENTITY_CONFLICT', conflicts: [expect.objectContaining({ key: 'resources:tab:a' })] }))
  })

  it('names a later local edit to an item a failed attempt had already taken from another writer', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const warnings: unknown[] = []
    let offline = true
    const persistence = new DesktopSpatialPersistence({ read: () => store.read(), onChange: listener => store.subscribe(listener),
      commit: input => offline ? Promise.reject(Object.assign(new Error('Disk unavailable'), { code: 'EIO' })) : store.commit(input) }, error => warnings.push(error))
    await persistence.read()
    await writeElsewhere(store, graph => { graph.resources['tab:a'] = { ...graph.resources['tab:a'] as object, title: 'Elsewhere' } })
    persistence.stage(derive(['a', 'b']))
    await persistence.flush().catch(() => undefined)
    offline = false
    persistence.stage(derive(['a', 'b'], { a: 'Local' }))
    await persistence.flush()
    expect((await store.read())!.graph.resources['tab:a']).toMatchObject({ title: 'Elsewhere' })
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'SPATIAL_ENTITY_CONFLICT', conflicts: [expect.objectContaining({ key: 'resources:tab:a' })] }))
  })

  it('keeps saving later unrelated work after a conflict, without any user resolution', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const persistence = client(store)
    await persistence.read()
    await writeElsewhere(store, graph => { graph.resources['tab:a'] = { ...graph.resources['tab:a'] as object, title: 'Elsewhere' } })
    persistence.stage(derive(['a'], { a: 'Local' }))
    await persistence.flush().catch(() => undefined)
    // Hours of later work: each new Tab must reach Core as it is made.
    for (const id of ['b', 'c', 'd']) {
      persistence.stage(derive(['a', ...['b', 'c', 'd'].slice(0, ['b', 'c', 'd'].indexOf(id) + 1)], { a: 'Local' }))
      await persistence.flush().catch(() => undefined)
      expect((await store.read())!.graph.tabs.map(tab => tab.tabId)).toContain(id)
    }
    expect(persistence.pendingChanges).toBe(false)
  })

  it('applies another process’s later commit while a conflict is retained', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const applied: number[] = [], persistence = client(store)
    await persistence.read()
    const dispose = persistence.connect(state => applied.push(state.revision))
    await writeElsewhere(store, graph => { graph.resources['tab:a'] = { ...graph.resources['tab:a'] as object, title: 'Elsewhere' } })
    persistence.stage(derive(['a'], { a: 'Local' }))
    await persistence.flush().catch(() => undefined)
    await writeElsewhere(store, graph => { graph.resources.separate = { from: 'cli' } })
    const latest = (await store.read())!.revision
    await expect.poll(() => applied.at(-1)).toBe(latest)
    dispose()
  })
})

describe('display layouts merge per Group', () => {
  it('keeps both Tabs when two writers add different Tabs to one display Workspace', () => {
    const base = derive(['a'])
    const local = derive(['a', 'b'])
    const remote = structuredClone(base)
    remote.tabs.push({ ...remote.tabs[0]!, tabId: 'c', regionIds: ['c-region'] })
    remote.layouts.project = addTabOccurrence(remote.layouts.project!, 'group', 'c')!
    const merged = reconcileSpatialGraphs(base, local, remote)
    expect(merged.graph.layouts.project!.groups[0]!.tabOrder).toEqual(['a', 'c', 'b'])
    expect(merged.conflicts).toEqual([])
  })

  it('keeps a reorder made on one side while the other side opens a Tab or changes the selection', () => {
    const base = derive(['a', 'b', 'c'])
    const local = structuredClone(base)
    local.layouts.project = moveTab(local.layouts.project!, 'c', 'group', 'group', 0)
    const opened = derive(['a', 'b', 'c', 'd'])
    expect(reconcileSpatialGraphs(base, local, opened).graph.layouts.project!.groups[0]!.tabOrder).toEqual(['c', 'a', 'b', 'd'])
    const selected = structuredClone(base)
    selected.layouts.project!.groups[0]!.activeTabId = 'b'
    const merged = reconcileSpatialGraphs(base, local, selected)
    expect(merged.graph.layouts.project!.groups[0]).toMatchObject({ tabOrder: ['c', 'a', 'b'], activeTabId: 'b' })
  })

  it('closes a Tab one side closed while the other side reordered the Group', () => {
    const base = derive(['a', 'b', 'c'])
    const local = derive(['a', 'c'])
    const remote = structuredClone(base)
    remote.layouts.project = moveTab(remote.layouts.project!, 'c', 'group', 'group', 0)
    expect(reconcileSpatialGraphs(base, local, remote).graph.layouts.project!.groups[0]!.tabOrder).toEqual(['c', 'a'])
    const reordered = structuredClone(base), closed = structuredClone(base)
    reordered.layouts.project = moveTab(reordered.layouts.project!, 'c', 'group', 'group', 0)
    closed.layouts.project!.groups[0]!.tabOrder = ['a', 'c']
    expect(reconcileSpatialGraphs(base, reordered, closed).graph.layouts.project!.groups[0]!.tabOrder).toEqual(['c', 'a'])
  })

  it('names the order when both sides moved the same Tabs differently, keeping every Tab', () => {
    const base = derive(['a', 'b', 'c'])
    const local = structuredClone(base), remote = derive(['a', 'b', 'c', 'd'])
    local.layouts.project = moveTab(local.layouts.project!, 'c', 'group', 'group', 0)
    remote.layouts.project = moveTab(remote.layouts.project!, 'a', 'group', 'group', 2)
    const merged = reconcileSpatialGraphs(base, local, remote)
    expect(merged.conflicts.map(conflict => conflict.key)).toEqual(['layout:project:group:order'])
    expect(merged.graph.layouts.project!.groups[0]!.tabOrder).toEqual(remote.layouts.project!.groups[0]!.tabOrder)
  })

  it('keeps the remote selection and both occurrences when only the selection conflicts', () => {
    const base = derive(['a', 'b'])
    const local = structuredClone(base), remote = structuredClone(base)
    local.layouts.project!.groups[0]!.activeTabId = 'b'
    remote.layouts.project!.groups[0]!.activeTabId = 'a'
    remote.layouts.project!.groups[0]!.recentTabIds = ['a']
    base.layouts.project!.groups[0]!.activeTabId = null
    const merged = reconcileSpatialGraphs(base, local, remote)
    expect(merged.graph.layouts.project!.groups[0]).toMatchObject({ activeTabId: 'a', tabOrder: ['a', 'b'] })
    expect(merged.conflicts.map(conflict => conflict.key)).toEqual(['layout:project:group:selection'])
  })
})

describe('a merge never hides a Tab or produces a graph Core rejects', () => {
  it('keeps a Tab this window moved into a new Group when another writer changed the split tree', () => {
    const base = derive(['a', 'b'])
    const local = structuredClone(base)
    local.layouts.project = moveTabToNewGroup(local.layouts.project!, 'b', 'group', 'group', 'right', 'mine')
    const remote = derive(['a', 'b', 'c'], {}, moveTabToNewGroup(createWorkspaceLayout('group', ['a', 'b', 'c']), 'c', 'group', 'group', 'down', 'theirs'))
    const merged = reconcileSpatialGraphs(base, local, remote)
    // The tree conflict keeps the remote tree, which has no Group for b; b stays shown in a remaining Group.
    expect(merged.conflicts.map(conflict => conflict.key)).toEqual(['layout:project:tree'])
    expect(unshown(merged.graph)).toEqual([])
    expect(() => parseAgentMuxSpatialGraph(merged.graph)).not.toThrow()
  })

  it('keeps a Tab this window added to a Group another writer closed', () => {
    const split = derive(['a', 'b'], {}, moveTabToNewGroup(createWorkspaceLayout('group', ['a', 'b']), 'b', 'group', 'group', 'right', 'side'))
    const local = derive(['a', 'b', 'c'], {}, structuredClone(split.layouts.project!))
    local.layouts.project!.groups.find(group => group.id === 'side')!.tabOrder.push('c')
    const remote = structuredClone(split)
    remote.layouts.project = moveTab(remote.layouts.project!, 'b', 'side', 'group', 1)
    const merged = reconcileSpatialGraphs(split, local, remote)
    expect(merged.graph.layouts.project!.groups.map(group => [group.id, group.tabOrder])).toEqual([['group', ['a', 'b', 'c']]])
    expect(unshown(merged.graph)).toEqual([])
  })

  it('still closes a Tab that one side closed', () => {
    const base = derive(['a', 'b'])
    const local = derive(['a'])
    const remote = structuredClone(base)
    remote.layouts.project!.groups[0]!.activeTabId = 'b'
    const merged = reconcileSpatialGraphs(base, local, remote)
    expect(merged.graph.tabs.map(tab => tab.tabId)).toEqual(['a'])
    expect(merged.graph.layouts.project!.groups[0]!.tabOrder).toEqual(['a'])
  })

  it('keeps an intentionally removed display occurrence removed while the Tab itself stays', () => {
    const base = derive(['a', 'b'])
    // This window unbinds b from the display; the Tab entity remains, shown nowhere on purpose.
    const local = derive(['a', 'b'], {}, createWorkspaceLayout('group', ['a']))
    const remote = structuredClone(base)
    remote.layouts.project!.groups[0]!.activeTabId = 'b'
    remote.layouts.project!.groups[0]!.recentTabIds = ['b']
    const merged = reconcileSpatialGraphs(base, local, remote)
    expect(merged.graph.tabs.map(tab => tab.tabId)).toEqual(['a', 'b'])
    expect(merged.graph.layouts.project!.groups[0]!.tabOrder).toEqual(['a'])
  })

  it('keeps a Tab’s Regions equal to its merged split tree when another writer changed the Tab itself', () => {
    const base = derive(['a'])
    const tab = addWorkbenchRegion(fileTab('a'), 'a-region', 'right', { regionId: 'a-notes', kind: 'file', workspaceId: 'project', path: 'notes.md' })
    const local = desktopSpatialGraph({ config, sessions: [], tabs: { a: tab }, layouts: { project: createWorkspaceLayout('group', ['a']) },
      spaceZoneBindings: {}, spatialRequests: {} } as never, [])
    const remote = structuredClone(base)
    remote.tabs[0]!.zoneId = null
    const merged = reconcileSpatialGraphs(base, local, remote)
    // The split lands and the remote Zone change is kept; Core accepts the graph instead of refusing every later save.
    expect(merged.conflicts).toEqual([])
    expect(merged.graph.tabs[0]).toMatchObject({ zoneId: null, regionIds: ['a-region', 'a-notes'] })
    expect(() => parseAgentMuxSpatialGraph(merged.graph)).not.toThrow()
    expect(Object.keys(desktopWorkbenchFromSpatial(merged.graph).tabs.a!.regions)).toEqual(['a-region', 'a-notes'])
  })

  it('keeps a Region this window closed while another writer’s winning split tree still shows it', () => {
    const tab = addWorkbenchRegion(fileTab('a'), 'a-region', 'right', { regionId: 'a-notes', kind: 'file', workspaceId: 'project', path: 'notes.md' })
    const base = desktopSpatialGraph({ config, sessions: [], tabs: { a: tab }, layouts: { project: createWorkspaceLayout('group', ['a']) },
      spaceZoneBindings: {}, spatialRequests: {} } as never, [])
    const local = derive(['a'])
    const remote = structuredClone(base), root = remote.tabLayouts.a!.root
    if (root.type !== 'split') throw new Error('The fixture Tab must be split')
    root.ratio = 0.8
    const merged = reconcileSpatialGraphs(base, local, remote)
    expect(merged.conflicts.map(conflict => conflict.key)).toEqual(['tabLayout:a:tree'])
    expect(() => parseAgentMuxSpatialGraph(merged.graph)).not.toThrow()
    expect(Object.keys(desktopWorkbenchFromSpatial(merged.graph).tabs.a!.regions)).toEqual(['a-region', 'a-notes'])
  })
})

/** A controllable clock: timers fire only when the test advances time. */
function testClock(start = 1_000_000) {
  let now = start, next = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => now,
    setTimeout: (run: () => void, delay: number) => { const id = ++next; timers.set(id, { at: now + delay, run }); return id },
    clearTimeout: (id: unknown) => { timers.delete(id as number) },
    pending: () => timers.size,
    /** Fire every timer due by the new time, including ones armed while firing. */
    async advance(ms: number) {
      now += ms
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) return
        timers.delete(due[0]); due[1].run()
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
  }
}

describe('a stalled or failing background save is visible while the user works', () => {
  it('announces a save that never answers within the bound, without any further edit', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const clock = testClock(), warnings: unknown[] = []
    const persistence = new DesktopSpatialPersistence({ read: () => store.read(), commit: () => new Promise(() => {}),
      onChange: listener => store.subscribe(listener) }, error => warnings.push(error), clock)
    await persistence.read()
    persistence.stage(derive(['a', 'b']))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warnings).toEqual([])
    await clock.advance(SAVE_STALL_AFTER_MS)
    expect(warnings).toEqual([expect.objectContaining({ code: 'SPATIAL_SAVE_STALLED' })])
    expect(persistence.saveObservation).toMatchObject({ stalled: true, pendingSince: 1_000_000 })
    // Repeated checks do not repeat the same announcement.
    await clock.advance(SAVE_STALL_AFTER_MS * 2)
    expect(warnings).toHaveLength(1)
    persistence.dispose()
  })

  it('retries a failed save in the background and reports recovery once it is confirmed', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const clock = testClock(), warnings: unknown[] = []
    let offline = true, recovered = 0
    const persistence = new DesktopSpatialPersistence({ read: () => store.read(),
      commit: input => offline ? Promise.reject(Object.assign(new Error('Disk unavailable'), { code: 'EIO' })) : store.commit(input),
      onChange: listener => store.subscribe(listener) }, error => warnings.push(error), clock)
    persistence.onRecovered = () => { recovered++ }
    await persistence.read()
    persistence.stage(derive(['a', 'b']))
    // Wait for the first save to fail, not for a fixed tick, so a loaded runner cannot reorder them.
    await expect.poll(() => persistence.saveObservation.lastFailureCode).toBe('EIO')
    expect((await store.read())!.graph.tabs.map(tab => tab.tabId)).toEqual(['a'])
    await clock.advance(SAVE_STALL_AFTER_MS)
    await expect.poll(() => warnings).toContainEqual(expect.objectContaining({ code: 'SPATIAL_SAVE_STALLED', lastFailureCode: 'EIO' }))
    // Storage comes back. No user edit happens; the background retry saves the Tab.
    offline = false
    // Reach the first backoff retry only, then let the real file write settle in real time.
    await clock.advance(SAVE_STALL_AFTER_MS * 8)
    await expect.poll(async () => (await store.read())!.graph.tabs.map(tab => tab.tabId)).toEqual(['a', 'b'])
    // Recovery is confirmed once the save's own reply settles, just after the file holds the Tab.
    await expect.poll(() => recovered).toBe(1)
    expect(persistence.saveObservation).toMatchObject({ stalled: false, pendingSince: null, lastFailureCode: null })
    expect(clock.pending()).toBe(0)
    persistence.dispose()
  })

  it('stops waiting for a reply that never comes and saves through the next attempt', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const clock = testClock(), warnings: unknown[] = []
    let commits = 0
    const persistence = new DesktopSpatialPersistence({ read: () => store.read(), onChange: listener => store.subscribe(listener),
      commit: input => ++commits === 1 ? new Promise(() => {}) : store.commit(input) }, error => warnings.push(error), clock)
    await persistence.read()
    persistence.stage(derive(['a', 'b']))
    await expect.poll(() => commits).toBe(1)
    // The bound announces the stall and gives up on the silent reply; the next check saves for real.
    await clock.advance(SAVE_STALL_AFTER_MS)
    await clock.advance(SAVE_STALL_AFTER_MS * 2)
    // Wait for the retry the watchdog started, not for a time budget a loaded runner can exceed.
    await persistence.flush()
    expect((await store.read())!.graph.tabs.map(tab => tab.tabId)).toEqual(['a', 'b'])
    expect(persistence.pendingChanges).toBe(false)
    expect(warnings.map(warning => (warning as { code?: string }).code)).toEqual(['SPATIAL_SAVE_STALLED'])
    persistence.dispose()
  })

  it('recognises a silent write that did land as agreement, not as a conflict', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const clock = testClock(), warnings: unknown[] = []
    let commits = 0
    const persistence = new DesktopSpatialPersistence({ read: () => store.read(), onChange: listener => store.subscribe(listener),
      commit: async input => { if (++commits > 1) return store.commit(input); await store.commit(input); return new Promise(() => {}) } },
    error => warnings.push(error), clock)
    await persistence.read()
    persistence.stage(derive(['a', 'b']))
    await expect.poll(async () => (await store.read())!.graph.tabs.map(tab => tab.tabId)).toEqual(['a', 'b'])
    await clock.advance(SAVE_STALL_AFTER_MS)
    await clock.advance(SAVE_STALL_AFTER_MS * 2)
    await persistence.flush()
    expect(persistence.pendingChanges).toBe(false)
    expect(warnings.map(warning => (warning as { code?: string }).code)).toEqual(['SPATIAL_SAVE_STALLED'])
    expect(persistence.conflicts).toEqual([])
    persistence.dispose()
  })

  it('adds no timer or save work for a stage that repeats the confirmed graph', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const clock = testClock(), persistence = new DesktopSpatialPersistence({ read: () => store.read(),
      commit: input => store.commit(input), onChange: listener => store.subscribe(listener) }, () => {}, clock)
    await persistence.read()
    persistence.stage(derive(['a']))
    expect(clock.pending()).toBe(0)
    expect(persistence.pendingChanges).toBe(false)
  })
})

describe('a Launcher Agent position is recorded by Core at creation', () => {
  const launcherTab = () => createWorkbenchTab('launch-tab', { regionId: 'launch-region', kind: 'launcher', workspaceId: 'project' } as never)
  const launcherGraph = () => desktopSpatialGraph({ config, sessions: [], tabs: { 'launch-tab': launcherTab() },
    layouts: { project: createWorkspaceLayout('group', ['launch-tab']) }, spaceZoneBindings: {}, spatialRequests: {} } as never, [])
  const launch = { launcher: { tabId: 'launch-tab', regionId: 'launch-region' }, executionWorkspaceId: 'project', executorId: 'codex',
    hostId: 'host', workspacePath: config.workspaces[0]!.path, prompt: 'Original first instruction', agentSessionId: 'created-agent',
    createOperationId: 'original-creation' } as never
  const result = (runId = 'created-run', workspacePath = config.workspaces[0]!.path) => ({ created: { kind: 'agent', agentSessionId: 'created-agent', hostId: 'host',
    workspacePath, creation: { createOperationId: 'original-creation', createdRun: { runId } } }, projectionFailures: [] }) as never

  it('attaches the exact Launcher Region with no Renderer save, and a repeat is settled without a new revision', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: launcherGraph() })
    expect(await attachLauncherAgentPosition(launch, result(), null, config.workspaces, store)).toBeUndefined()
    const saved = (await store.read())!
    expect(saved.graph.regions.find(region => region.regionId === 'launch-region')).toEqual({ tabId: 'launch-tab', regionId: 'launch-region',
      kind: 'agent', agentSessionId: 'created-agent', runId: 'created-run', execution: { hostId: 'host', cwd: config.workspaces[0]!.path } })
    expect(desktopWorkbenchFromSpatial(saved.graph).tabs['launch-tab']!.regions['launch-region']).toMatchObject({ kind: 'agent', sessionId: 'created-agent', phase: 'attached' })
    expect(await attachLauncherAgentPosition(launch, result(), null, config.workspaces, store)).toBeUndefined()
    expect((await store.read())!.revision).toBe(saved.revision)
  })

  it('reports a placement issue for a Region that is gone or holds another Agent, and leaves Core unchanged', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: launcherGraph() })
    await attachLauncherAgentPosition(launch, result(), null, config.workspaces, store)
    const before = (await store.read())!
    const other = { ...(launch as object), agentSessionId: 'another-agent' } as never
    const otherResult = { created: { kind: 'agent', agentSessionId: 'another-agent', hostId: 'host', workspacePath: config.workspaces[0]!.path,
      creation: { createOperationId: 'original-creation', createdRun: { runId: 'another-run' } } }, projectionFailures: [] } as never
    expect(await attachLauncherAgentPosition(other, otherResult, null, config.workspaces, store)).toMatch(/Launcher position is not yet recorded/)
    const gone = { ...(launch as object), launcher: { tabId: 'launch-tab', regionId: 'missing-region' } } as never
    expect(await attachLauncherAgentPosition(gone, result(), null, config.workspaces, store)).toMatch(/not in the spatial document/)
    expect((await store.read())!).toEqual(before)
  })

  it('records the directory the created Session runs in, such as its scratch Topic folder', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: launcherGraph() })
    const topic = fixturePath('save-integrity/project/topics/first-topic')
    expect(await attachLauncherAgentPosition(launch, result('created-run', topic), null, config.workspaces, store)).toBeUndefined()
    expect((await store.read())!.graph.regions.find(region => region.regionId === 'launch-region')!.execution).toEqual({ hostId: 'host', cwd: topic })
  })

  it('leaves a Goal discussion Launcher to its own owned binding commit', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: launcherGraph() })
    const before = (await store.read())!
    const goal = { originals: [], workspaceId: 'project', hostId: 'host', agentSessionId: 'created-agent', createOperationId: 'original-creation' } as never
    expect(await attachLauncherAgentPosition(launch, result(), goal, config.workspaces, store)).toBeUndefined()
    expect((await store.read())!).toEqual(before)
  })

  it('still records an ordinary Launcher position when the Goal discussion check could not read its document', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: launcherGraph() })
    expect(await attachLauncherAgentPosition(launch, result(), { metadataIssue: 'The original Launcher placement could not be read.' }, config.workspaces, store)).toBeUndefined()
    expect((await store.read())!.graph.regions.find(region => region.regionId === 'launch-region')).toMatchObject({ kind: 'agent', agentSessionId: 'created-agent' })
  })
})

describe('a stalled workface save leaves a bounded record that survives restart', () => {
  it('files one record per stall and one recovery, readable by a fresh archive owner, with no workface text', async () => {
    const { ClientIncidentArchive } = await import('../../host/src/client-incident-archive')
    const directory = await mkdtemp(join(tmpdir(), 'amux-save-incidents-')); directories.push(directory)
    const archive = new ClientIncidentArchive(directory)
    await archive.flush()
    const producer = { kind: 'renderer' as const, appInstanceId: 'application', producerInstanceId: 'window-document', windowId: '1', documentGeneration: '1', buildId: null }
    const sent: unknown[] = []
    const recorder = workfaceSaveRecorder('local', report => { sent.push(report); expect(archive.enqueue(report, producer).accepted).toBe(true) })
    const stalled = { pendingSince: 1_000, lastConfirmedAt: null, stalled: true, lastFailureCode: 'SPATIAL_STATE_BUSY', conflicts: 2 }
    recorder.stalled(stalled, 41, 31_000)
    recorder.stalled(stalled, 41, 61_000)
    recorder.recovered({ ...stalled, pendingSince: null, stalled: false, lastFailureCode: null }, 42, 90_000)
    expect(sent).toHaveLength(2)
    await archive.flush()
    // A second process reads the same durable namespace after restart.
    const reopened = new ClientIncidentArchive(directory)
    await reopened.flush()
    const page = (await reopened.read({ domain: 'client.incident', hostId: 'local', recent: {} }, { signal: new AbortController().signal, maxBytes: 256 * 1024 })).data as { items: { kind: string; code: string | null; logId?: string; recordRef: { logId: string } }[] }
    expect(page.items.map(item => [item.kind, item.code])).toEqual(expect.arrayContaining([['workface-save-failed', 'SPATIAL_STATE_BUSY'], ['workface-save-recovered', null]]))
    const failed = page.items.find(item => item.kind === 'workface-save-failed')!
    const record = (await reopened.read({ domain: 'client.incident', hostId: 'local', logId: failed.recordRef.logId }, { signal: new AbortController().signal, maxBytes: 256 * 1024 })).data as { report: AgentMuxClientIncidentReport }
    expect(record.report).toMatchObject({ stage: 'save-stalled', metadata: { spatialRevision: 41, unsavedForMs: 30_000, spatialConflicts: 2 } })
    // Only bounded facts: no Region, Agent or Run identity and no free text travels with the record.
    expect(record.report).toMatchObject({ regionId: null, agentSessionId: null, runId: null, references: [] })
    expect(Object.keys(record.report.metadata).sort()).toEqual(['spatialConflicts', 'spatialRevision', 'unsavedForMs'])
  })
})

describe('a replaced spatial owner stays quiet', () => {
  it('never retries or reports after dispose, even when its in-flight save fails afterwards', async () => {
    const store = await owner()
    await store.commit({ expectedRevision: 0, graph: derive(['a']) })
    const clock = testClock(), warnings: unknown[] = []
    let fail!: (error: Error) => void, commits = 0
    const persistence = new DesktopSpatialPersistence({ read: () => store.read(),
      commit: () => { commits++; return new Promise((_, reject) => { fail = reject }) }, onChange: listener => store.subscribe(listener) },
    error => warnings.push(error), clock)
    await persistence.read()
    persistence.stage(derive(['a', 'b']))
    await expect.poll(() => commits).toBe(1)
    persistence.dispose()
    fail(Object.assign(new Error('Disk unavailable'), { code: 'EIO' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    await clock.advance(SAVE_STALL_AFTER_MS * 64)
    expect(clock.pending()).toBe(0)
    expect(commits).toBe(1)
    // Not the late failure of its own save either: nobody owns that outcome any more.
    expect(warnings).toEqual([])
  })
})
