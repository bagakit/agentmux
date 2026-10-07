// @vitest-environment happy-dom
import { act } from 'react'
import { assertGroupInvariant, createWorkspaceLayout } from '@agentmux/layout'
import { expect, it, vi } from 'vitest'
import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel'
import { api } from '../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { resolveDesktopSpaceSelection, workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { topicSpatialAddress } from '../src/shared/space-addresses'
import { composerDOM } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { moteAgent, moteConfig, moteTopic, scratchWorkspace } from './fixtures/mote-workface'

const dom = composerDOM()
const topic = moteTopic('launcher:occurrence', 'Original positioned work', false)
const agent = moteAgent('positioned-agent', topic.id)
const address = topicSpatialAddress(moteConfig, topic)!
const tab = { ...createWorkbenchTab('positioned-tab', { kind: 'agent', phase: 'attached',
  workspaceId: scratchWorkspace.id, sessionId: agent.id, regionId: 'positioned-region' }), topicId: topic.id, space: address }
const firstGroup = 'original-first-group', secondGroup = 'original-second-group'

async function mount(duplicate: boolean) {
  const first = createWorkspaceLayout(firstGroup, [tab.id])
  const layout = duplicate ? { ...first,
    root: { type: 'split' as const, direction: 'horizontal' as const, ratio: .5,
      first: first.root, second: { type: 'leaf' as const, groupId: secondGroup } },
    groups: [...first.groups, { ...first.groups[0]!, id: secondGroup }] } : first
  assertGroupInvariant(layout)
  useAppStore.setState({ config: moteConfig, activeWorkspaceId: scratchWorkspace.id, mainSurface: 'workbench',
    tabs: { [tab.id]: tab }, layouts: { [scratchWorkspace.id]: layout }, sessions: [agent], timelines: {}, agentNames: {},
    spaceZoneBindings: {}, topicCategories: [], workspaceFileRevisions: {}, pinnedItems: {}, scratchTopicOrder: [],
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 0,
      topics: [topic], reading: false, error: null } }, workbenchSpaceSelection: null,
    agentFocus: { execution: { sessionId: agent.id, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [agent.id]: 'Original unsent request' } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1,
    graph: desktopSpatialGraph(useAppStore.getState(), [topic]) })
  await initializeSpatialControlFixture([topic])
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic)
  const state = useAppStore.getState()
  useAppStore.setState({ workbenchSpaceSelection: { ...resolveDesktopSpaceSelection(state, workbenchSelectionCatalog(state),
    { ...address, displayWorkspaceId: scratchWorkspace.id, groupId: firstGroup, tabId: tab.id }), topicId: topic.id } })
  const navigate = vi.spyOn(useAppStore.getState(), 'openScratchTopic')
  await dom.render(<WorkspaceTopicsPanel workspace={scratchWorkspace} onRevealDirectory={() => {}} />)
  return { navigate, before: useAppStore.getState() }
}

it('opens the explicitly clicked second Group through the mounted Topic panel and original Store owner', async () => {
  const { navigate, before } = await mount(true)
  expect(before.workbenchSpaceSelection?.groupId).toBe(firstGroup)
  const chips = dom.container.querySelectorAll<HTMLButtonElement>('.workbench-topology__tab-chip')
  expect(chips).toHaveLength(2)
  expect(chips[1]!.getAttribute('aria-label')).toContain('Group 2')
  await act(async () => chips[1]!.click())
  const after = useAppStore.getState()
  expect(after.workbenchSpaceSelection).toMatchObject({ ...address, workspaceId: scratchWorkspace.id,
    groupId: secondGroup, tabId: tab.id, regionId: tab.layout.activeRegionId })
  expect(after.layouts[scratchWorkspace.id]?.activeGroupId).toBe(secondGroup)
  expect(navigate).toHaveBeenCalledExactlyOnceWith(topic.id, scratchWorkspace.id, { tabId: tab.id, groupId: secondGroup })
  expect(after.tabs).toBe(before.tabs)
  expect(after.sessions).toBe(before.sessions)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('keeps single-Group Topic navigation on its original occurrence', async () => {
  const { navigate, before } = await mount(false)
  await dom.click('.workbench-topology__tab-chip')
  expect(navigate).toHaveBeenCalledExactlyOnceWith(topic.id, scratchWorkspace.id, { tabId: tab.id, groupId: firstGroup })
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ groupId: firstGroup, tabId: tab.id,
    regionId: tab.layout.activeRegionId })
  expect(useAppStore.getState().tabs).toBe(before.tabs)
})
