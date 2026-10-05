// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { showMoteConversation } from '../src/renderer/src/lib/mote-conversation-mode'
import type { WorkbenchProjectionSelection } from '../src/renderer/src/lib/workbench-projection'
import { scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { customAgent, customMoteId, customTab, defaultAgent, moteTopics, neighborAgent, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

const baseline = useAppStore.getState()
const reference = { displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: customTab.id, regionId: 'custom-region' }
const scope = { workspace: scratchWorkspace, topic: moteTopics.find(topic => topic.id === customMoteId)!, rootPath: scratchTopicDirectoryName(customMoteId) }
let root: Root, container: HTMLDivElement
let launch: ReturnType<typeof vi.fn>, send: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seedMoteWorkface()
  launch = vi.fn(); send = vi.fn()
  useAppStore.setState({ spaceZoneBindings: {}, workbenchSpaceSelection: null,
    viewModes: Object.fromEntries(useAppStore.getState().sessions.map(session => [session.id, 'terminal' as const])),
    launchAgent: launch, send, reportError: vi.fn() })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => moteTopics.find(topic => topic.id === id) ?? null)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); useAppStore.setState(baseline, true)
})
async function mount(options: { visible?: boolean; entry?: number; reference?: WorkbenchProjectionSelection | null } = {}) {
  await act(async () => root.render(<MoteWorkface workspaceId={scratchWorkspace.id} topicId={customMoteId} floating
    visible={options.visible ?? true} recoverOnOpen={options.visible ?? true} conversationEntry={options.entry}
    reference={options.reference === undefined ? reference : options.reference}><input defaultValue="Original unsent question" /></MoteWorkface>))
}
function retained() {
  const state = useAppStore.getState()
  return { tabs: state.tabs, layouts: state.layouts, sessions: state.sessions, drafts: state.agentComposerDrafts, focus: state.agentFocus }
}
function noRun() { expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled() }
it('cold explicit entry selects conversation once and keeps the original tree and later Terminal', async () => {
  const original = retained()
  await mount({ entry: 0 })
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('activity')
  const input = container.querySelector('input')!
  await act(async () => useAppStore.getState().setViewMode(customAgent.id, 'terminal', { focus: false }))
  for (let i = 0; i < 6; i++) await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === defaultAgent.id ? { ...session, updatedAt: session.updatedAt + 1 } : session) })))
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('terminal')
  expect(container.querySelector('input')).toBe(input)
  const current = retained(); expect({ ...current, sessions: original.sessions }).toEqual(original)
  noRun()
})
it('hover and natural pin do not request conversation; the next explicit entry does', async () => {
  await mount()
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('terminal')
  await mount({ entry: 1 })
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('activity')
  await act(async () => useAppStore.getState().setViewMode(customAgent.id, 'terminal', { focus: false }))
  await mount({ visible: false })
  await mount({ entry: 2 })
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('activity'); noRun()
})
it('waits for its original Session without borrowing a neighboring Agent', async () => {
  const sessions = useAppStore.getState().sessions
  useAppStore.setState({ sessions: sessions.filter(session => session.id !== customAgent.id) })
  await mount({ entry: 1 })
  expect(useAppStore.getState().viewModes[neighborAgent.id]).toBe('terminal')
  await act(async () => useAppStore.setState({ sessions }))
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('activity'); noRun()
})
it.each(['input', 'keydown', 'pointerdown'] as const)('later %s cancels deferred entry preparation', async event => {
  const sessions = useAppStore.getState().sessions
  useAppStore.setState({ sessions: sessions.filter(session => session.id !== customAgent.id) })
  await mount({ entry: 1 })
  container.querySelector('input')!.dispatchEvent(new Event(event, { bubbles: true }))
  await act(async () => useAppStore.setState({ sessions }))
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('terminal'); noRun()
})
it.each([null, { ...reference, groupId: 'missing-original-group' }, { ...reference, regionId: 'foreign-region' }])('unconfirmed exact occurrence %j preserves original modes and inputs', async reference => {
  const original = retained(), modes = useAppStore.getState().viewModes
  await mount({ entry: 1, reference })
  expect(useAppStore.getState().viewModes).toBe(modes); expect(retained()).toEqual(original); noRun()
})
it('an exact occurrence in a different display uses the same resource and leaves Space navigation untouched', async () => {
  const state = useAppStore.getState(), layout = state.layouts[scratchWorkspace.id]!
  useAppStore.setState({ layouts: { ...state.layouts, project: { ...layout, groups: layout.groups.map(group => ({ ...group, id: 'foreign-display-group' })), root: { type: 'leaf', groupId: 'foreign-display-group' }, activeGroupId: 'foreign-display-group' } } })
  const original = retained()
  await mount({ entry: 1, reference: { ...reference, displayWorkspaceId: 'project', groupId: 'foreign-display-group' } })
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('activity')
  expect(retained()).toEqual(original); expect(useAppStore.getState().activeWorkspaceId).toBe('project'); noRun()
})
it('explicit Space navigation, including the same already-selected Mote, resets only its exact conversation', async () => {
  const catalog = spatialCatalog(useAppStore.getState(), moteTopics)
  expect(catalog.locations.some(location => location.tabId === customTab.id && location.groupId === reference.groupId)).toBe(true)
  await act(async () => { await useAppStore.getState().openScratchTopic(customMoteId, scratchWorkspace.id, { tabId: customTab.id }) })
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('activity')
  await act(async () => useAppStore.getState().setViewMode(customAgent.id, 'terminal', { focus: false }))
  await act(async () => { await useAppStore.getState().openScratchTopic(customMoteId, scratchWorkspace.id, { tabId: customTab.id }) })
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('activity')
  expect(useAppStore.getState().viewModes[neighborAgent.id]).toBe('terminal'); noRun()
})
it('closing before a deferred original Session arrives prevents a mode change', async () => {
  const sessions = useAppStore.getState().sessions
  useAppStore.setState({ sessions: sessions.filter(session => session.id !== customAgent.id) })
  await mount({ entry: 1 }); await mount({ visible: false })
  await act(async () => useAppStore.setState({ sessions }))
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('terminal'); noRun()
})
it('a later exact selection cancels deferred entry preparation even without a DOM event', async () => {
  const sessions = useAppStore.getState().sessions
  useAppStore.setState({ sessions: sessions.filter(session => session.id !== customAgent.id) })
  await mount({ entry: 1 })
  await mount({ entry: 1, reference: { ...reference, tabId: 'neighbor-tab', regionId: 'neighbor-region' } })
  await act(async () => useAppStore.setState({ sessions }))
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('terminal')
  expect(useAppStore.getState().viewModes[neighborAgent.id]).toBe('terminal'); noRun()
})
it('later selection of another original Region in the same Mote is not a deferred entry', async () => {
  const second = { ...customAgent, id: 'custom-second', control: { ...customAgent.control, agentSessionId: 'custom-second' } }
  const sessions = [...useAppStore.getState().sessions, second]
  useAppStore.setState(state => ({ sessions: sessions.filter(session => session.id !== customAgent.id),
    viewModes: { ...state.viewModes, [second.id]: 'terminal' }, tabs: { ...state.tabs, [customTab.id]: { ...customTab,
      layout: { ...customTab.layout, root: { type: 'split', direction: 'horizontal', ratio: 0.5,
        first: customTab.layout.root, second: { type: 'leaf', regionId: 'second-region' } } }, regions: {
      ...customTab.regions, 'second-region': { kind: 'agent', phase: 'attached', workspaceId: scratchWorkspace.id, regionId: 'second-region', sessionId: second.id } } } } }))
  await mount({ entry: 1 })
  await mount({ entry: 1, reference: { ...reference, regionId: 'second-region' } })
  await act(async () => useAppStore.setState({ sessions }))
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('terminal')
  expect(useAppStore.getState().viewModes[second.id]).toBe('terminal'); noRun()
})
it('a later original Tab metadata change does not replay entry over a manual Terminal choice', async () => {
  await mount({ entry: 1 })
  await act(async () => useAppStore.getState().setViewMode(customAgent.id, 'terminal', { focus: false }))
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [customTab.id]: { ...state.tabs[customTab.id]!, name: 'Renamed original discussion' } } })))
  expect(useAppStore.getState().viewModes[customAgent.id]).toBe('terminal'); noRun()
})
it('an explicit null reference never borrows the selected Space', () => {
  expect(showMoteConversation(scope, { floating: true, reference: null })).toBe(false); noRun()
})
it('original pinned preference reload preserves Terminal until an actual close and explicit reopen', async () => {
  const original = useAppStore.getState(), storageKey = 'agentmux.leader-topic-floating.v1'
  const saved = window.localStorage.getItem(storageKey)
  window.localStorage.setItem(storageKey, JSON.stringify({ open: true, targetTopicId: customMoteId, targetTabId: customTab.id, reference }))
  vi.resetModules()
  const fresh = (await import('../src/renderer/src/store')).useAppStore
  const floating = await import('../src/renderer/src/lib/pmo-teams-topic-floating')
  const { useMoteConversationMode } = await import('../src/renderer/src/lib/mote-conversation-mode')
  fresh.setState({ config: original.config, tabs: original.tabs, layouts: original.layouts, sessions: original.sessions,
    scratchTopicSnapshots: original.scratchTopicSnapshots, spaceZoneBindings: original.spaceZoneBindings,
    agentFocus: original.agentFocus, viewModes: original.viewModes, launchAgent: launch, send })
  function Restored() {
    const [entry] = floating.usePmoTeamsTopicFloatingState()
    useMoteConversationMode(scope, { workspaceId: scratchWorkspace.id, topicId: customMoteId, active: entry.open,
      floating: true, reference: entry.reference, conversationEntry: entry.conversationEntry })
    return <input defaultValue="The original restored draft" />
  }
  try {
    await act(async () => root.render(<Restored />))
    expect(floating.readPmoTeamsTopicFloatingState()?.conversationEntry).toBeUndefined()
    expect(fresh.getState().viewModes[customAgent.id]).toBe('terminal')
    const input = container.querySelector('input')!
    await act(async () => floating.requestPmoTeamsTopicFloatingClose({ restoreFocus: false }))
    await act(async () => floating.requestPmoTeamsTopicFloatingOpen({ targetTopicId: customMoteId, targetTabId: customTab.id, reference }))
    expect(fresh.getState().viewModes[customAgent.id]).toBe('activity')
    expect(container.querySelector('input')).toBe(input)
    noRun()
  } finally {
    if (saved === null) window.localStorage.removeItem(storageKey)
    else window.localStorage.setItem(storageKey, saved)
  }
})
