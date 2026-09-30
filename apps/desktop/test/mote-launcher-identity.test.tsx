// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-native-terminal-excluded /> }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => <div data-activity-body-excluded /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { useAppStore } from '../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { composerDOM } from './helpers/composer-dom-fixture'
import { executionAgent, moteTopics, ordinaryTopicId, quietMoteId, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

const dom = composerDOM()
const launcherBaseline = useLauncherState.getState()
const sleepingPrimary = { ...createWorkbenchTab('sleeping-primary', { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'sleeping-primary-region' }, 'Primary task, not Mote name'), topicId: PMO_TEAMS_TOPIC_ID }
const sleepingCustom = { ...createWorkbenchTab('sleeping-custom', { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'sleeping-custom-region' }, 'Custom task, not Mote name'), topicId: quietMoteId }
const topicTab = { ...createWorkbenchTab('ordinary-launcher', { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'ordinary-launcher-region' }), topicId: ordinaryTopicId }
const folderTab = createWorkbenchTab('folder-launcher', { kind: 'launcher', workspaceId: 'project', regionId: 'folder-region' })
const exactTabs = [sleepingPrimary, sleepingCustom, topicTab, folderTab]
let refresh: ReturnType<typeof vi.fn>, warm: ReturnType<typeof vi.fn>, launch: ReturnType<typeof vi.fn>

beforeEach(async () => { await act(async () => {
  localStorage.clear(); seedMoteWorkface()
  refresh = vi.fn().mockResolvedValue(undefined); warm = vi.fn(); launch = vi.fn().mockResolvedValue(undefined)
  useLauncherState.setState({ sections: { [SCRATCH_WORKSPACE_ID]: { agents: 'expanded' }, project: { agents: 'expanded' } },
    drafts: {}, executors: { [SCRATCH_WORKSPACE_ID]: 'fixture', project: 'fixture' }, persistenceIssue: null })
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, ...Object.fromEntries(exactTabs.map(tab => [tab.id, tab])) },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('identity-group', [sleepingPrimary.id, sleepingCustom.id, topicTab.id]) },
    agentComposerDrafts: { ...useAppStore.getState().agentComposerDrafts,
      [sleepingPrimary.layout.activeRegionId]: 'Primary nonempty draft', [sleepingCustom.layout.activeRegionId]: 'Custom nonempty draft',
      'missing-exact-region': 'Unconfirmed precise region draft' },
    providerCatalog: [], refreshScratchTopics: refresh, prewarmTerminal: warm, detectExecutors: vi.fn().mockResolvedValue(undefined), launchAgent: launch })
}) })
afterEach(async () => { await act(async () => { useLauncherState.setState(launcherBaseline, true); localStorage.clear() }) })

function heading(parent: ParentNode = dom.container) {
  const nodes = parent.querySelectorAll<HTMLHeadingElement>('.launcher-environment__project h2')
  expect(nodes).toHaveLength(1)
  expect(nodes[0]!.isConnected).toBe(true)
  return nodes[0]!
}
function title(expected: string, parent?: ParentNode) {
  const node = heading(parent)
  expect(node.textContent).toBe(expected); expect(node.title).toBe(expected)
}
function input() {
  const nodes = dom.container.querySelectorAll<HTMLElement>('[aria-label="Agent prompt"]')
  expect(nodes).toHaveLength(1); expect(nodes[0]!.isConnected).toBe(true)
  return nodes[0]!
}
function protectedFacts() {
  const state = useAppStore.getState()
  expect(state.sessions.length).toBeGreaterThan(0)
  expect(state.sessions.find(session => session.id === executionAgent.id)?.control.run.runId).toBeTruthy()
  expect(state.agentComposerDrafts[sleepingPrimary.layout.activeRegionId]).toBe('Primary nonempty draft')
  expect(state.agentComposerDrafts[sleepingCustom.layout.activeRegionId]).toBe('Custom nonempty draft')
  return { tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts, sessions: state.sessions,
    focus: state.agentFocus, queues: state.agentSteerQueues, config: state.config, warm: state.warmTerminal,
    activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface }
}
async function mount(tab: WorkbenchTab = sleepingCustom, regionId = tab.layout.activeRegionId) {
  expect(tab.id.length).toBeGreaterThan(0); expect(tab.topicId?.length ?? tab.workspaceId.length).toBeGreaterThan(0)
  await dom.render(<NewTabSurface tabGroupId="identity-group" tabId={tab.id} regionId={regionId} visible={false} />)
}
function originalDirectoryRefreshOnly() {
  // The existing LauncherMoteAction already reads the directory once on mount.
  // The heading must add no second request; raw snapshot/output updates do not refresh it.
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(refresh).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID)
}
function setTopics(topics: typeof moteTopics) {
  const snapshot = useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!
  useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { ...snapshot, revision: snapshot.revision + 1, topics } } })
}

describe('the exact sleeping Mote Launcher identity', () => {
  it('the real Workbench caller shows primary and custom names while keeping original resource and work', async () => {
    const before = protectedFacts()
    await dom.render(<WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID} visible={false} />)
    for (const [tab, expected] of [[sleepingPrimary, 'Mote'], [sleepingCustom, 'Quiet collaborator']] as const) {
      const regions = dom.container.querySelectorAll<HTMLElement>(`[data-workbench-region-id="${tab.layout.activeRegionId}"]`)
      expect(regions).toHaveLength(1)
      expect(regions[0]!.closest('[data-workbench-tab-id]')?.getAttribute('data-workbench-tab-id')).toBe(tab.id)
      title(expected, regions[0]!)
      expect(regions[0]!.querySelector('.launcher-environment__path')?.getAttribute('title')).toBe(scratchWorkspace.path)
      expect(regions[0]!.querySelector('[aria-label="Runtime environment"]')?.textContent).toContain('This Mac')
    }
    expect(protectedFacts()).toEqual(before); expect(launch).not.toHaveBeenCalled(); expect(warm).not.toHaveBeenCalled()
  })

  it('switching this precise Launcher ignores another selected Mote and names the actual Tab, not its task', async () => {
    const before = protectedFacts(); await mount(); title('Quiet collaborator')
    expect(heading().textContent).not.toBe(sleepingCustom.name)
    await mount(sleepingPrimary); title('Mote')
    await mount(); title('Quiet collaborator')
    expect(protectedFacts()).toEqual(before); originalDirectoryRefreshOnly(); expect(launch).not.toHaveBeenCalled()
  })

  it.each([sleepingPrimary, sleepingCustom])('an original raw rename updates the same $id heading and retains the actual input, caret and environment', async tab => {
    await mount(tab); const originalInput = input(); originalInput.focus(); const before = protectedFacts()
    await act(async () => setTopics(moteTopics.map(topic => topic.id === tab.topicId ? { ...topic, title: 'Renamed original Mote' } : topic)))
    title('Renamed original Mote'); expect(input()).toBe(originalInput); expect(document.activeElement).toBe(originalInput)
    expect(originalInput.textContent).toContain(tab === sleepingPrimary ? 'Primary nonempty draft' : 'Custom nonempty draft')
    expect(dom.container.querySelector('.launcher-environment__path')?.getAttribute('title')).toBe(scratchWorkspace.path)
    expect(protectedFacts()).toEqual(before); originalDirectoryRefreshOnly(); expect(warm).not.toHaveBeenCalled()
  })

  it('the same entity keeps its title across exact presentation references without changing its original binding', async () => {
    const before = protectedFacts()
    for (const displayWorkspaceId of [SCRATCH_WORKSPACE_ID, 'project']) {
      await dom.render(<WorkbenchPresentationContext.Provider value={{ active: false, retainedRegionId: null,
        reference: { displayWorkspaceId, groupId: 'identity-group', tabId: sleepingCustom.id, regionId: sleepingCustom.layout.activeRegionId } }}>
        <NewTabSurface tabGroupId="identity-group" tabId={sleepingCustom.id} regionId={sleepingCustom.layout.activeRegionId} visible={false} />
      </WorkbenchPresentationContext.Provider>)
      title('Quiet collaborator')
    }
    expect(protectedFacts()).toEqual(before); originalDirectoryRefreshOnly(); expect(launch).not.toHaveBeenCalled()
  })

  it.each(['absent', 'foreign-host', 'foreign-path', 'missing-row', 'read-error'] as const)(
    '%s raw name stays neutral without borrowing a neighbor and retains usable original input', async failure => {
      const snapshot = useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!
      useAppStore.setState({ scratchTopicSnapshots: failure === 'absent' ? {} : { [SCRATCH_WORKSPACE_ID]: {
        ...snapshot,
        scope: failure === 'foreign-host' ? scratchTopicsScope({ hostId: 'different', path: scratchWorkspace.path })
          : failure === 'foreign-path' ? scratchTopicsScope({ hostId: scratchWorkspace.hostId, path: '/different-topics' }) : snapshot.scope,
        topics: failure === 'missing-row' ? moteTopics.filter(topic => topic.id !== quietMoteId)
          : failure === 'read-error' ? moteTopics.map(topic => topic.id === quietMoteId ? { ...topic, readError: 'Read unavailable' } : topic) : moteTopics
      } } })
      const before = protectedFacts(); await mount(); title('Context name unconfirmed')
      expect(input().textContent).toContain('Custom nonempty draft')
      const button = dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')
      expect(button).not.toBeNull(); expect(button!.disabled).toBe(false)
      expect(protectedFacts()).toEqual(before); originalDirectoryRefreshOnly(); expect(warm).not.toHaveBeenCalled()
    })

  it.each(['missing-row', 'read-error'] as const)('primary identity does not fabricate its user-renamed title when %s', async failure => {
    setTopics(failure === 'missing-row' ? moteTopics.filter(topic => topic.id !== PMO_TEAMS_TOPIC_ID)
      : moteTopics.map(topic => topic.id === PMO_TEAMS_TOPIC_ID ? { ...topic, title: 'User primary title', readError: 'Read unavailable' } : topic))
    await mount(sleepingPrimary); title('Context name unconfirmed')
    expect(input().textContent).toContain('Primary nonempty draft'); originalDirectoryRefreshOnly()
  })

  it.each(['missing-tab', 'wrong-region', 'other-workspace-region'] as const)('the %s exact binding is neutral, never repaired from an adjacent Region', async failure => {
    const before = protectedFacts()
    const tab = sleepingCustom
    if (failure === 'missing-tab') {
      const { [tab.id]: _removed, ...tabs } = useAppStore.getState().tabs; useAppStore.setState({ tabs })
    } else if (failure === 'other-workspace-region') useAppStore.setState({ tabs: { ...useAppStore.getState().tabs,
      [tab.id]: { ...tab, regions: { [tab.layout.activeRegionId]: { ...tab.regions[tab.layout.activeRegionId]!, workspaceId: 'project' } } } } })
    await mount(tab, failure === 'wrong-region' ? 'missing-exact-region' : tab.layout.activeRegionId)
    title('Context name unconfirmed'); expect(input().textContent).toContain(failure === 'wrong-region' ? 'Unconfirmed precise region draft' : 'Custom nonempty draft')
    const after = protectedFacts(); expect(after.drafts).toEqual(before.drafts); expect(after.sessions).toEqual(before.sessions)
    expect(after.focus).toEqual(before.focus); originalDirectoryRefreshOnly(); expect(launch).not.toHaveBeenCalled()
  })

  it('ordinary confirmed Topic, Folder and empty Group retain their original Workspace heading', async () => {
    await mount(topicTab); title('Topics')
    await mount(folderTab); title('Project')
    await dom.render(<NewTabSurface tabGroupId="empty-group" visible={false} />); title('Project')
    originalDirectoryRefreshOnly(); expect(launch).not.toHaveBeenCalled()
  })

  it('unrelated Session output changes never rescan the existing directory to derive the heading', async () => {
    const topics = useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics!
    const find = vi.spyOn(topics, 'find'); await mount(); title('Quiet collaborator')
    expect(find.mock.calls.length).toBeGreaterThan(0); find.mockClear()
    await act(async () => useAppStore.setState({ sessions: useAppStore.getState().sessions.map(session => session.id === executionAgent.id
      ? { ...session, latestOutputBytes: session.latestOutputBytes + 1 } : session) }))
    title('Quiet collaborator'); expect(find).not.toHaveBeenCalled(); originalDirectoryRefreshOnly()
  })

  it('a neutral title never blocks the original launch writer or changes its exact resource arguments', async () => {
    useAppStore.setState({ scratchTopicSnapshots: {} }); await mount(); title('Context name unconfirmed')
    const before = protectedFacts(); await dom.click('.launcher-launch-button')
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0]).toEqual(['fixture', 'Custom nonempty draft', 'identity-group',
      { tabId: sleepingCustom.id, regionId: sleepingCustom.layout.activeRegionId }, {}, { agentName: undefined, tabName: undefined }])
    expect(protectedFacts()).toEqual(before); originalDirectoryRefreshOnly()
  })
})
