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

it('retains pending navigation on an overlapping layout conflict and retries after it is resolved', async () => {
  const work = await originalWorkface(false)
  try {
    const remote = structuredClone(work.graphA)
    const split = remote.tabLayouts['original-tab']!.root
    if (split.type !== 'split') throw new Error('The original workface must have two regions')
    split.ratio = 0.7
    await work.owner.commit({ expectedRevision: 1, graph: remote })
    work.client.stage(work.graphB)
    await expect(work.client.flush()).rejects.toThrow('same spatial layout or resource')
    expect((await work.owner.readForLayout())!.graph).toEqual(remote)
    expect(work.applied).toEqual([])
    // The same pending selection remains retryable once the owner resolves the
    // overlapping layout; this does not clear or rebuild the original workface.
    await work.owner.commit({ expectedRevision: 2, graph: work.graphA })
    work.release(); await work.client.flush()
    expect((await work.owner.readForLayout())!.graph).toEqual(work.graphB)
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
    await expect(saving).rejects.toThrow('original write response is unavailable')
    expect(work.applied).toEqual([])
    expect(work.client.current!.graph.tabLayouts['original-tab']!.activeRegionId).toBe('A')
    expect((await work.owner.readForLayout())!.graph.tabLayouts['original-tab']!.activeRegionId).toBe(applied ? 'B' : 'A')
    await work.client.flush()
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
    await expect(saving).rejects.toThrow('original write response is unavailable')
    await expect(work.client.flush()).rejects.toThrow('original write response is unavailable')
    expect(work.applied).toEqual([])
    await work.client.flush()
    const actual = (await work.owner.readForLayout())!.graph
    expect(actual.tabLayouts['original-tab']!.activeRegionId).toBe('A')
    expect(actual.resources['remote-note']).toEqual({ text: 'Retained remote content' })
    expect(work.applied).toEqual(['A'])
  } finally { work.release(); work.dispose() }
})

it('refuses an unrelated third layout after an unknown write, while allowing the user to choose it', async () => {
  const work = await originalWorkface(false, false, [true])
  try {
    work.client.stage(work.graphB)
    const saving = work.client.flush()
    await work.started; work.client.stage(work.graphA); work.release()
    await expect(saving).rejects.toThrow('original write response is unavailable')
    const remote = structuredClone(work.graphB), split = remote.tabLayouts['original-tab']!.root
    if (split.type !== 'split') throw new Error('The original workface must have two regions')
    split.ratio = 0.7
    await work.owner.commit({ expectedRevision: 2, graph: remote })
    await expect(work.client.flush()).rejects.toThrow('same spatial layout or resource')
    expect((await work.owner.readForLayout())!.graph).toEqual(remote)
    expect(work.applied).toEqual([])
    work.client.stage(remote); await work.client.flush()
    expect((await work.owner.readForLayout())!.graph).toEqual(remote)
    expect(work.applied).toEqual(['B'])
  } finally { work.release(); work.dispose() }
})

it.each(['unknown', 'in-flight'] as const)('accepts an independent name ACK without erasing later A during an %s layout write', async phase => {
  const work = await originalWorkface(true, true, phase === 'unknown' ? [true] : [], phase === 'in-flight')
  try {
    work.client.stage(work.graphB)
    const saving = work.client.flush()
    await work.started; work.client.stage(work.graphA)
    if (phase === 'unknown') {
      work.release(); await expect(saving).rejects.toThrow('original write response is unavailable')
    }
    const named = await work.owner.mutateDisplayLabel({ target: { kind: 'tab', id: 'original-tab' },
      operationId: 'independent-name', expectedNameRevision: 0, value: 'Chosen name', source: 'manual' },
      { actor: { kind: 'device', id: 'private-device', verified: true }, source: 'desktop-ui',
        entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: { windowId: 'private-window' } })
    work.client.acceptNames(named.state)
    expect(work.applied).toEqual([])
    work.release()
    if (phase === 'in-flight') await saving
    await work.client.flush()
    const actual = (await work.owner.readForLayout())!.graph
    expect(actual.tabLayouts['original-tab']!.activeRegionId, 'A name ACK must not replace the later Region intent with its older layout snapshot').toBe('A')
    expect(actual.tabs[0]!.name).toBe('Chosen name')
    expect(actual.resources['remote-note']).toEqual({ text: 'Retained remote content' })
    expect(work.applied).toEqual(['A'])
    expect(work.appliedNames).toEqual(['Chosen name'])
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
