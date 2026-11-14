// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import { workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { resolveWorkbenchZone } from '../src/renderer/src/lib/workbench-projection'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { useAppStore } from '../src/renderer/src/store'
import { workspaceZoneId } from '../src/shared/space-addresses'
import { spaceMountKey } from '../src/shared/space-mount'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'

const dom = composerDOM()
const initialLauncher = useLauncherState.getState()
const project = composerConfig.workspaces[0]!
const display = { ...project, id: 'display-workspace', name: 'Display', path: '/review/display' }
const remote = { ...project, id: 'remote-agent', hostId: 'remote', name: 'Agent environment', path: '/review/agent' }
const groupId = 'original-group', regionId = 'original-launcher'
const spaceId = workspaceProjectId(project), zoneId = workspaceZoneId(spaceId, project.id)
const original = { ...createWorkbenchTab('original-tab', {
  kind: 'launcher', regionId, workspaceId: project.id, agentWorkspaceId: remote.id
}), space: { spaceId, zoneId } }

beforeEach(() => {
  useLauncherState.setState({ sections: { [project.id]: { agents: 'hidden', terminal: 'hidden', browser: 'hidden', note: 'hidden' } } })
  vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(Error('Creating a Launcher must not launch an Agent'))
  vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValue(Error('The fixture keeps automatic terminal preview hidden'))
})
afterEach(() => useLauncherState.setState(initialLauncher, true))

function fixture(foreign: boolean) {
  const displayId = foreign ? display.id : project.id
  useAppStore.setState({ config: { ...composerConfig,
    hosts: [...composerConfig.hosts, { id: 'remote', kind: 'ssh', label: 'Remote Agent', hostname: 'remote.invalid' }],
    workspaces: [...composerConfig.workspaces, display, remote] },
    mainSurface: 'workbench', activeWorkspaceId: displayId,
    tabs: { [original.id]: original }, layouts: { [displayId]: createWorkspaceLayout(groupId, [original.id]) },
    workbenchSpaceSelection: { workspaceId: displayId, spaceId, zoneId, groupId, tabId: original.id, regionId, topicId: null },
    sessions: [composerSession('healthy-original')],
    agentComposerDrafts: { [regionId]: 'Original Outpost task' },
    launcherNameDrafts: { [regionId]: { agentName: 'Original Agent', tabName: 'Original work' } },
    launcherOptionDrafts: { [regionId]: { codex: { model: 'original-model' } } },
    pendingAgentLaunches: { 'unconfirmed-original': { events: [], overflowed: false,
      request: { executorId: 'codex', hostId: remote.hostId, workspacePath: remote.path,
        createOperationId: 'original-operation', prompt: 'Original admitted task' } } } })
  return displayId
}

it.each([false, true])('the actual plus creates an independent Launcher at the Zone resource and exact display (foreign=%s)', async foreign => {
  const displayId = fixture(foreign)
  await dom.render(<WorkspaceWorkbench workspaceId={displayId} />)
  const before = useAppStore.getState()
  const button = dom.container.querySelector<HTMLButtonElement>('[aria-label="New Tab"]')!
  expect(button).not.toBeNull(); expect(button.disabled).toBe(false)
  await act(async () => button.click())
  const after = useAppStore.getState()
  const added = Object.values(after.tabs).filter(tab => !before.tabs[tab.id])
  expect(added, 'The plus must create one new independent initial Tab').toHaveLength(1)
  const created = added[0]!, createdRegion = created.regions[created.layout.activeRegionId]!
  expect(created.workspaceId).toBe(project.id)
  expect(createdRegion).toMatchObject({ kind: 'launcher', workspaceId: project.id })
  expect(createdRegion.regionId).not.toBe(regionId)
  expect(created.space).toEqual({ spaceId, zoneId })
  expect(after.layouts[displayId]!.groups.find(group => group.id === groupId)!.tabOrder).toEqual([original.id, created.id])
  expect(after.workbenchSpaceSelection).toMatchObject({ workspaceId: displayId, groupId, tabId: created.id,
    regionId: createdRegion.regionId, zoneId })
  const catalog = workbenchSelectionCatalog(after)
  expect(catalog.locations).toContainEqual(expect.objectContaining({ workspaceId: project.id, displayWorkspaceId: displayId,
    groupId, tabId: created.id, regionId: createdRegion.regionId, zoneId }))
  expect(after.tabs[original.id]).toBe(before.tabs[original.id])
  expect(after.sessions).toBe(before.sessions)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.launcherNameDrafts).toBe(before.launcherNameDrafts)
  expect(after.launcherOptionDrafts).toBe(before.launcherOptionDrafts)
  expect(after.pendingAgentLaunches).toBe(before.pendingAgentLaunches)
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  expect(api.sessions.launchTerminal).not.toHaveBeenCalled()
})

it('a missing original Zone resource refuses only the new placement and keeps the old Outpost request', async () => {
  const displayId = fixture(true)
  await dom.render(<WorkspaceWorkbench workspaceId={displayId} />)
  const button = dom.container.querySelector<HTMLButtonElement>('[aria-label="New Tab"]')!
  const before = useAppStore.getState(), report = vi.spyOn(before, 'reportError')
  await act(async () => {
    useAppStore.setState({ config: { ...before.config!, workspaces: before.config!.workspaces.filter(item => item.id !== project.id) } })
    button.click()
  })
  const after = useAppStore.getState()
  expect(report).toHaveBeenCalled()
  expect(after.tabs).toBe(before.tabs)
  expect(after.layouts).toBe(before.layouts)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.pendingAgentLaunches).toBe(before.pendingAgentLaunches)
  expect(after.sessions).toBe(before.sessions)
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
})

it.each([false, true])('Space creates and selects one raw Launcher even beside a registered Source (qualified=%s)', async qualified => {
  fixture(false)
  const target = { hostId: project.hostId, reference: { runtimeId: 'original-runtime', spaceId }, zoneId, workspaceId: project.id }
  const starting = useAppStore.getState().workbenchSpaceSelection!
  useAppStore.setState({
    mountedSpaceInputs: { [spaceMountKey(target.reference)]: { target } },
    workbenchSpaceSelection: qualified ? { ...starting, sourceRuntimeId: target.reference.runtimeId } : starting
  })
  const before = useAppStore.getState()
  const select = vi.fn()
  const projection = resolveWorkbenchZone(zoneId, workbenchSelectionCatalog(before), before.layouts, before.tabs, 'workbench-tab', [], select)
  expect(projection).not.toBeNull()
  await dom.render(<WorkspaceWorkbench workspaceId={project.id} projection={projection!} />)
  select.mockClear()
  const plus = dom.container.querySelector<HTMLButtonElement>('[aria-label="New Tab"]')!
  await act(async () => {
    plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    plus.click()
  })
  const current = useAppStore.getState()
  const added = Object.values(current.tabs).filter(tab => !before.tabs[tab.id])
  expect(added).toHaveLength(1)
  const created = added[0]!
  expect(created.source).toBeUndefined()
  expect(created.space).toEqual({ spaceId, zoneId })
  expect(current.workbenchSpaceSelection).toMatchObject({ groupId, tabId: created.id, regionId: created.layout.activeRegionId })
  expect(current.layouts[project.id]!.groups[0]!.activeTabId).toBe(created.id)
  expect(select, 'Creation must not navigate through an older projection').not.toHaveBeenCalled()
  expect(current.agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('the actual plus reaches the original spatial writer and a fresh Core owner reads its resource and foreign placement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-new-launcher-'))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  fixture(true)
  const config = useAppStore.getState().config!, sessions = useAppStore.getState().sessions
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions, timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  const commit = vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(input => spatial.retainDisplayLabels(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  const dispose = await useAppStore.getState().initialize()
  try {
    fixture(true)
    await dom.render(<WorkspaceWorkbench workspaceId={display.id} />)
    await dom.click('[aria-label="New Tab"]')
    const created = Object.values(useAppStore.getState().tabs).find(tab => tab.id !== original.id)!
    expect(created, 'The foreign-display plus must create an independent owner').toBeDefined()
    const reader = new AgentMuxSpatialStateStore(spatial.path)
    await vi.waitFor(async () => {
      const saved = (await reader.read())!
      expect(saved.graph.tabs).toContainEqual(expect.objectContaining({ tabId: created.id, workspaceId: project.id, zoneId }))
      expect(saved.graph.layouts[display.id]!.groups.find(group => group.id === groupId)!.tabOrder).toEqual([original.id, created.id])
      expect(saved.graph.regions).toContainEqual(expect.objectContaining({ tabId: original.id, regionId, kind: 'launcher' }))
      expect(saved.graph.resources['region:' + created.layout.activeRegionId]).toMatchObject({ workspaceId: project.id })
    })
    expect(commit).toHaveBeenCalled()
    expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  } finally {
    dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
