import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph, reconcileSpatialGraphs } from '../src/renderer/src/lib/desktop-spatial-state'
import { validateProjectGroup } from '../src/renderer/src/lib/cross-device-project-groups'
import { directoryIdentity } from '../src/shared/space-addresses'
import type { AppConfig } from '../src/shared/contracts'

import { fixture, cleanupGroups, groupConfig, group, ids, workbench, disposers } from './helpers/cross-device-project-groups'
afterEach(cleanupGroups)
describe('cross-device Project organization through the real spatial owner', () => {
  it('saves a manual group through Core ACK and keeps exact original surfaces', async () => {
    const owner = await fixture(), before = useAppStore.getState()
    const tabs = before.tabs, layouts = before.layouts
    const result = await before.saveProjectGroup(group)
    expect(result.diskDurability).toBe('confirmed')
    expect((await owner.read())!.graph.projectGroups).toEqual([group])
    expect(useAppStore.getState().projectGroups).toEqual([group])
    expect(useAppStore.getState().tabs).toEqual(tabs)
    expect(useAppStore.getState().layouts).toEqual(layouts)
    expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState())).not.toHaveProperty('projectGroups')
  })
  it('restores the original group from Core on real Store initialization', async () => {
    const owner = await fixture()
    const saved = (await owner.read())!
    await owner.commit({ expectedRevision: saved.revision, graph: { ...saved.graph, projectGroups: [group] } })
    for (const dispose of disposers.splice(0)) dispose()
    useAppStore.setState({ projectGroups: [], config: groupConfig })
    disposers.push(await useAppStore.getState().initialize())
    expect(useAppStore.getState().projectGroups).toEqual([group])
    expect(useAppStore.getState().tabs['original-tab']!.regions['original-region']!.workspaceId).toBe('local-project')
  })
  it('persists overlapping groups and dissolves only the exact group without losing the workface', async () => {
    const owner = await fixture()
    const second = { ...group, groupId: 'second-group', name: 'Second purpose' }
    await useAppStore.getState().saveProjectGroup(group)
    await expect(useAppStore.getState().saveProjectGroup(second)).resolves.toMatchObject({ diskDurability: 'confirmed' })
    expect((await owner.read())!.graph.projectGroups).toEqual([group, second])
    const tabs = useAppStore.getState().tabs
    await useAppStore.getState().dissolveProjectGroup(group.groupId)
    expect((await owner.read())!.graph.projectGroups).toEqual([second])
    for (const dispose of disposers.splice(0)) dispose()
    useAppStore.setState({ projectGroups: [], config: groupConfig })
    disposers.push(await useAppStore.getState().initialize())
    expect(useAppStore.getState().projectGroups).toEqual([second])
    expect(useAppStore.getState().tabs).toEqual(tabs)
  })
  it('applies a group watch without resource config and does not overwrite the new name when config returns', async () => {
    const owner = await fixture()
    await useAppStore.getState().saveProjectGroup(group)
    useAppStore.setState({ config: null })
    const saved = (await owner.read())!
    await owner.commit({ expectedRevision: saved.revision, graph: { ...saved.graph, projectGroups: [{ ...group, name: 'Other client name' }] } })
    await vi.waitFor(() => expect(useAppStore.getState().projectGroups[0]!.name).toBe('Other client name'))
    useAppStore.setState({ config: groupConfig })
    await useAppStore.getState().retryWorkbenchSave()
    expect((await owner.read())!.graph.projectGroups![0]!.name).toBe('Other client name')
  })
  it('dissolves only organization, even if its opaque ID equals an unavailable Tab ID', async () => {
    const owner = await fixture()
    const saved = (await owner.read())!, unknown = structuredClone(saved.graph)
    unknown.tabs.push({ tabId: 'shared-group', workspaceId: 'unavailable-workspace', zoneId: null, name: 'Original unavailable Tab', regionIds: ['unavailable-region'] })
    unknown.regions.push({ tabId: 'shared-group', regionId: 'unavailable-region', kind: 'file', agentSessionId: null, runId: null, execution: null })
    unknown.tabLayouts['shared-group'] = { root: { type: 'leaf', regionId: 'unavailable-region' }, activeRegionId: 'unavailable-region' }
    unknown.projectGroups = [group]
    await owner.commit({ expectedRevision: saved.revision, graph: unknown })
    await vi.waitFor(() => expect(useAppStore.getState().projectGroups).toEqual([group]))
    await useAppStore.getState().dissolveProjectGroup('shared-group')
    const after = (await owner.read())!.graph
    expect(after.projectGroups).toEqual([])
    expect(after.tabs.find(tab => tab.tabId === 'shared-group')).toEqual(unknown.tabs.at(-1))
    expect(after.regions.find(region => region.regionId === 'unavailable-region')).toEqual(unknown.regions.at(-1))
    expect(after.tabs.find(tab => tab.tabId === 'original-tab')).toEqual(saved.graph.tabs[0])
  })
  it('requires exact group deletion intent and retains data on an omitted group write', async () => {
    const owner = await fixture()
    await useAppStore.getState().saveProjectGroup(group)
    const saved = (await owner.read())!
    await expect(owner.commit({ expectedRevision: saved.revision, graph: { ...saved.graph, projectGroups: [] }, allowEntityRemoval: true })).rejects.toMatchObject({ code: 'SPATIAL_ENTITY_REMOVAL_UNCONFIRMED' })
    expect(await owner.read()).toEqual(saved)
  })
  it('merges disjoint group edits and reports same-group conflicts without changing either graph', () => {
    const base = desktopSpatialGraph({ ...workbench(), projectGroups: [group] }, [])
    const local = { ...base, projectGroups: [{ ...group, name: 'Local name' }] }
    const second = { groupId: 'other-group', name: 'Other', projectIds: ['opaque-project-a', 'opaque-project-b'] }
    const remote = { ...base, projectGroups: [group, second] }
    expect(reconcileSpatialGraphs(base, local, remote).projectGroups).toEqual([{ ...group, name: 'Local name' }, second])
    const conflicting = { ...base, projectGroups: [{ ...group, name: 'Remote name' }] }
    expect(() => reconcileSpatialGraphs(base, local, conflicting)).toThrow('edited elsewhere')
    expect(conflicting.projectGroups[0]!.name).toBe('Remote name')
    expect(local.projectGroups[0]!.name).toBe('Local name')
  })
  it('allows unknown retained members to be renamed without claiming a new execution target', () => {
    expect(validateProjectGroup({ ...group, name: 'Renamed' }, [group], [])).toEqual({ ...group, name: 'Renamed' })
    expect(() => validateProjectGroup(group, [], [])).toThrow('registration changed')
    expect(validateProjectGroup({ ...group, projectIds: [ids[0]!, directoryIdentity('local', _hygiene_fixturePath("local/other"))] }, [group], [...groupConfig.workspaces, { ...groupConfig.workspaces[0]!, id: 'other-local', path: _hygiene_fixturePath("local/other") }]).projectIds).toContain(ids[0])
  })
})
