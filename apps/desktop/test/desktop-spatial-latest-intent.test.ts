import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { DesktopSpatialPersistence, desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import type { AppConfig } from '../src/shared/contracts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function originalWorkface(events: boolean, remoteChange = false, unknownWrites: boolean[] = [], holdReply = false) {
  const directory = await mkdtemp(join(tmpdir(), 'amx-spatial-intent-')); directories.push(directory)
  const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
    workspaces: [{ id: 'project', hostId: 'local', name: 'Original project', path: fixturePath('spatial-intent'), kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const tab = addWorkbenchRegion(createWorkbenchTab('original-tab', { kind: 'file', workspaceId: 'project', path: 'a.md', regionId: 'A' }), 'A', 'right',
    { kind: 'file', workspaceId: 'project', path: 'b.md', regionId: 'B' })
  tab.layout.activeRegionId = 'A'
  const graphA = desktopSpatialGraph({ config, sessions: [], tabs: { [tab.id]: tab }, layouts: { project: createWorkspaceLayout('group', [tab.id]) }, spaceZoneBindings: {} }, [])
  await owner.commit({ expectedRevision: 0, graph: graphA })
  let entered!: () => void, release!: () => void, commits = 0
  const started = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  const applied: string[] = [], appliedNames: (string | null)[] = [], warnings: unknown[] = []
  const client = new DesktopSpatialPersistence({ read: () => owner.readForLayout(), commit: async input => {
    if (++commits === 1) {
      if (holdReply) { const saved = await owner.commit(input); entered(); await waiting; return saved }
      entered(); await waiting
    }
    if (unknownWrites.length) {
      if (unknownWrites.shift()) await owner.commit(input)
      throw new Error('The original write response is unavailable')
    }
    return owner.commit(input)
  }, onChange: listener => events ? owner.subscribe(listener) : () => {} }, issue => warnings.push(issue))
  await client.read()
  if (remoteChange) {
    // A different owner writes after the initial read, before observation connects.
    const remote = structuredClone(graphA); remote.resources['remote-note'] = { text: 'Retained remote content' }
    await owner.commit({ expectedRevision: 1, graph: remote })
  }
  const dispose = client.connect(state => {
    applied.push(state.graph.tabLayouts['original-tab']!.activeRegionId)
    appliedNames.push(state.graph.tabs[0]!.name)
  })
  const graphB = structuredClone(graphA); graphB.tabLayouts['original-tab']!.activeRegionId = 'B'
  return { owner, client, graphA, graphB, started, release, applied, appliedNames, warnings, dispose, commits: () => commits }
}

it.each([true, false])('keeps the later return to A while B saves, without flashing B (Core events=%s)', async events => {
  const work = await originalWorkface(events, true)
  try {
    work.client.stage(work.graphB)
    const saving = work.client.flush()
    await work.started
    work.client.stage(structuredClone(work.graphA))
    work.release(); await saving; await work.client.flush()
    const actual = (await work.owner.readForLayout())!.graph
    expect(actual.tabLayouts['original-tab']!.activeRegionId, 'Later return to A is an intent while B is in flight').toBe('A')
    expect(work.applied).toEqual(['A'])
    expect(actual.resources['remote-note']).toEqual({ text: 'Retained remote content' })
    expect(actual.tabs).toEqual(work.graphA.tabs)
    expect(actual.regions).toEqual(work.graphA.regions)
    expect(work.warnings).toEqual([])
  } finally { work.release(); work.dispose() }
})

it('coalesces repeated identical pending navigation and ignores the acknowledged repeat', async () => {
  const work = await originalWorkface(true)
  try {
    work.client.stage(work.graphB)
    const saving = work.client.flush()
    await work.started
    work.client.stage(structuredClone(work.graphB))
    work.release(); await saving; await work.client.flush()
    expect(work.commits(), 'The same in-flight intent does not create another public commit').toBe(1)
    work.client.stage(structuredClone(work.graphB)); await work.client.flush()
    expect(work.commits()).toBe(1)
    expect(work.applied).toEqual(['B'])
    expect((await work.owner.readForLayout())!.graph.tabLayouts['original-tab']!.activeRegionId).toBe('B')
    expect(work.warnings).toEqual([])
  } finally { work.release(); work.dispose() }
})

it('saves a pending selection beside a remote split change, keeping both independent facts', async () => {
  const work = await originalWorkface(false)
  try {
    const remote = structuredClone(work.graphA)
    const split = remote.tabLayouts['original-tab']!.root
    if (split.type !== 'split') throw new Error('The original workface must have two regions')
    split.ratio = 0.7
    await work.owner.commit({ expectedRevision: 1, graph: remote })
    work.client.stage(work.graphB)
    work.release(); await work.client.flush()
    // The split ratio and the active Region are separate facts: both writers' changes are kept.
    const saved = (await work.owner.readForLayout())!.graph.tabLayouts['original-tab']!
    expect(saved.activeRegionId).toBe('B')
    expect(saved.root).toEqual(remote.tabLayouts['original-tab']!.root)
    expect(work.client.conflicts).toEqual([])
    expect(work.applied).toEqual(['B'])
  } finally { work.release(); work.dispose() }
})

const unknownCases = [true, false].flatMap(applied => [true, false].map(events => ({ applied, events })))
it.each(unknownCases)('keeps the return to A after an unknown write (applied=$applied, events=$events)', async ({ applied, events }) => {
  const work = await originalWorkface(events, true, [applied])
  try {
    work.client.stage(work.graphB)
    const saving = work.client.flush()
    await work.started; work.client.stage(structuredClone(work.graphA)); work.release()
    if (applied) {
      // The lost reply's write advanced the document, so the same save merges again at once.
      await saving
    } else {
      await expect(saving).rejects.toThrow('original write response is unavailable')
      expect(work.applied).toEqual([])
      expect(work.client.current!.graph.tabLayouts['original-tab']!.activeRegionId).toBe('A')
      expect((await work.owner.readForLayout())!.graph.tabLayouts['original-tab']!.activeRegionId).toBe('A')
      await work.client.flush()
    }
    const actual = (await work.owner.readForLayout())!.graph
    expect(actual.tabLayouts['original-tab']!.activeRegionId, 'Retry preserves the later A even if B was written without an ACK').toBe('A')
    expect(actual.resources['remote-note']).toEqual({ text: 'Retained remote content' })
    expect(actual.tabs).toEqual(work.graphA.tabs); expect(actual.regions).toEqual(work.graphA.regions)
    expect(work.applied).toEqual(['A'])
  } finally { work.release(); work.dispose() }
})

it.each([true, false])('retains the return to A through two unknown replies (second applied=%s)', async secondApplied => {
  const work = await originalWorkface(true, true, [true, secondApplied])
  try {
    work.client.stage(work.graphB)
    const saving = work.client.flush()
    await work.started; work.client.stage(work.graphA); work.release()
    // Both lost replies are absorbed inside bounded re-merges when the document advanced; a lost
    // reply that wrote nothing still reports the save as unconfirmed for an explicit retry.
    await saving.catch(error => expect(String(error)).toContain('original write response is unavailable'))
    await work.client.flush().catch(error => expect(String(error)).toContain('original write response is unavailable'))
    await work.client.flush()
    const actual = (await work.owner.readForLayout())!.graph
    expect(actual.tabLayouts['original-tab']!.activeRegionId).toBe('A')
    expect(actual.resources['remote-note']).toEqual({ text: 'Retained remote content' })
    expect(work.applied).toEqual(['A'])
  } finally { work.release(); work.dispose() }
})

it('keeps a third writer’s split after an unknown write and still saves the later local selection', async () => {
  const work = await originalWorkface(false, false, [true])
  try {
    work.client.stage(work.graphB)
    const saving = work.client.flush()
    await work.started; work.client.stage(work.graphA); work.release()
    await saving
    const remote = structuredClone((await work.owner.readForLayout())!.graph), split = remote.tabLayouts['original-tab']!.root
    if (split.type !== 'split') throw new Error('The original workface must have two regions')
    split.ratio = 0.7
    const current = (await work.owner.readForLayout())!
    await work.owner.commit({ expectedRevision: current.revision, graph: remote })
    work.client.stage(structuredClone(work.graphA))
    await work.client.flush()
    const saved = (await work.owner.readForLayout())!.graph.tabLayouts['original-tab']!
    // The unknown write's selection B is superseded by the later local A; the third writer's split is kept.
    expect(saved.activeRegionId).toBe('A')
    expect(saved.root).toEqual(remote.tabLayouts['original-tab']!.root)
    expect(work.client.conflicts).toEqual([])
  } finally { work.release(); work.dispose() }
})

it.each(['unknown', 'in-flight'] as const)('accepts an independent name ACK without erasing later A during an %s layout write', async phase => {
  const work = await originalWorkface(true, true, phase === 'unknown' ? [true] : [], phase === 'in-flight')
  try {
    work.client.stage(work.graphB)
    const saving = work.client.flush()
    await work.started; work.client.stage(work.graphA)
    if (phase === 'unknown') {
      // The lost reply's write advanced the document; the same save merges again and settles.
      work.release(); await saving
    }
    const named = await work.owner.mutateDisplayLabel({ target: { kind: 'tab', id: 'original-tab' },
      operationId: 'independent-name', expectedNameRevision: 0, value: 'Chosen name', source: 'manual' },
      { actor: { kind: 'device', id: 'private-device', verified: true }, source: 'desktop-ui',
        entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: { windowId: 'private-window' } })
    work.client.acceptNames(named.state)
    // An in-flight write applies nothing yet; a lost reply already settled through its re-merge.
    if (phase === 'in-flight') expect(work.applied).toEqual([])
    work.release()
    if (phase === 'in-flight') await saving
    await work.client.flush()
    const actual = (await work.owner.readForLayout())!.graph
    expect(actual.tabLayouts['original-tab']!.activeRegionId, 'A name ACK must not replace the later Region intent with its older layout snapshot').toBe('A')
    expect(actual.tabs[0]!.name).toBe('Chosen name')
    expect(actual.resources['remote-note']).toEqual({ text: 'Retained remote content' })
    // The UI never shows the stale B, and ends on the chosen name.
    expect(work.applied.every(region => region === 'A')).toBe(true)
    expect(work.appliedNames.at(-1)).toBe('Chosen name')
  } finally { work.release(); work.dispose() }
})

it('waits for independent name facts before applying an unchanged in-flight selection', async () => {
  const work = await originalWorkface(true, true, [], true)
  try {
    work.client.stage(work.graphB)
    const saving = work.client.flush()
    await work.started
    const named = await work.owner.mutateDisplayLabel({ target: { kind: 'tab', id: 'original-tab' },
      operationId: 'independent-name', expectedNameRevision: 0, value: 'Chosen name', source: 'manual' },
      { actor: { kind: 'device', id: 'private-device', verified: true }, source: 'desktop-ui',
        entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: { windowId: 'private-window' } })
    work.client.acceptNames(named.state)
    expect(work.applied).toEqual([])
    work.release(); await saving; await work.client.flush()
    expect(work.applied).toEqual(['B'])
    expect(work.appliedNames).toEqual(['Chosen name'])
    const actual = (await work.owner.readForLayout())!.graph
    expect(actual.tabLayouts['original-tab']!.activeRegionId).toBe('B')
    expect(actual.tabs[0]!.name).toBe('Chosen name')
    expect(actual.resources['remote-note']).toEqual({ text: 'Retained remote content' })
  } finally { work.release(); work.dispose() }
})
