// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { spaceNewTabFixture } from './fixtures/space-new-tab'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../src/renderer/src/store'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => <p>Original Agent work</p> }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))

const dom = composerDOM()
it.each(['same-runtime', 'foreign-runtime'])('the actual Space plus keeps its original resource beside a %s Source projection', async runtimeId => {
  const f = spaceNewTabFixture(composerConfig, composerSession(), runtimeId)
  useAppStore.setState({ ...f.state, loading: false, mainSurface: 'workbench', retainedSpatialFocus: null,
    scratchTopicSnapshots: {}, prewarmTerminal: async () => {}, agentComposerDrafts: { [f.session.id]: 'Original unsent input' } })
  const before = useAppStore.getState(), projected = before.tabs[f.sourceTabId]!, projectedLayout = before.layouts[f.sourceWorkspaceId]!
  expect(projected.source?.reference.runtimeId).toBe(runtimeId)
  expect(projected.workspaceId).not.toBe(f.tab.workspaceId)
  expect(projected.space?.zoneId).toBe(f.zoneId)
  expect(workbenchSelectionCatalog(before).zones.find(zone => zone.zoneId === f.zoneId)).toMatchObject({ kind: 'directory', workspaceId: f.tab.workspaceId })
  await dom.render(<WorkspaceWorkbench workspaceId={f.tab.workspaceId} />)
  await dom.click('button[title="New tab"]')
  const after = useAppStore.getState(), created = Object.values(after.tabs).filter(tab => !before.tabs[tab.id])
  expect(created).toHaveLength(1)
  expect(created[0]!.space).toEqual({ spaceId: f.spaceId, zoneId: f.zoneId })
  expect(created[0]!.workspaceId).toBe(f.tab.workspaceId)
  expect(created[0]!.regions[created[0]!.layout.activeRegionId]?.kind).toBe('launcher')
  expect(after.workbenchSpaceSelection).toMatchObject({ zoneId: f.zoneId, groupId: 'original-group', tabId: created[0]!.id })
  expect(after.tabs[f.tab.id]).toBe(before.tabs[f.tab.id])
  expect(after.tabs[f.sourceTabId]).toBe(projected)
  expect(after.layouts[f.sourceWorkspaceId]).toBe(projectedLayout)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.sessions).toBe(before.sessions)
  expect(dom.container.querySelector('.launch-surface')).not.toBeNull()
})

it('a genuine ordinary resource conflict remains unknown and cannot create against a guessed Workspace', async () => {
  const f = spaceNewTabFixture(composerConfig, composerSession(), 'same-runtime')
  const projected = f.state.tabs[f.sourceTabId]!
  const { source: _source, ...ordinaryConflict } = projected
  const state = { ...f.state, tabs: { ...f.state.tabs, [projected.id]: ordinaryConflict } }
  expect(spatialCatalog(state, []).zones.find(zone => zone.zoneId === f.zoneId)).toMatchObject({ kind: 'unknown', hostId: null, directoryPath: null })
  useAppStore.setState({ ...state, mainSurface: 'workbench', error: null, scratchTopicSnapshots: {}, prewarmTerminal: async () => {} })
  const before = useAppStore.getState()
  await act(async () => before.openLauncher({ workspaceId: f.tab.workspaceId, tabGroupId: 'original-group', zoneId: f.zoneId, reveal: true }))
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(useAppStore.getState().error).toContain('exact Zone resource context is unavailable')
})
