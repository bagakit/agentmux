import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { addTabOccurrence, createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph, DesktopSpatialPersistence, reconcileSpatialGraphs } from '../src/renderer/src/lib/desktop-spatial-state'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { AppConfig } from '../src/shared/contracts'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const config: AppConfig = { version: 9, hosts: [{ id: 'host', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [{ id: 'project', name: 'Project', hostId: 'host', path: fixturePath('save-integrity/project'), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const fileTab = (id: string) => createWorkbenchTab(id, { regionId: id + '-region', kind: 'file', workspaceId: 'project', path: id + '.md' })

/** The Renderer's own derivation of a workbench with these Tabs in one display Group. */
function derive(ids: string[], titles: Record<string, string> = {}) {
  const tabs = Object.fromEntries(ids.map(id => [id, { ...fileTab(id), ...(titles[id] ? { title: titles[id] } : {}) }]))
  return desktopSpatialGraph({ config, sessions: [], tabs, layouts: { project: createWorkspaceLayout('group', ids) },
    spaceZoneBindings: {}, spatialRequests: {} } as never, [])
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
