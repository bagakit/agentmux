import { createWorkspaceLayout } from '@agentmux/layout'
import { saveMoteQuickDefaults } from '../src/renderer/src/lib/mote-quick-mode'
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseMoteQuickMode, serializeMoteQuickMode, type MoteDefaultConversation, PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { moteConversationChoices, moteDefaultExecutor, motePinnedTab, moteTabOrder, resolveMoteDefaultConversation } from '../src/renderer/src/lib/mote-quick-preferences'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { floatingMoteDefaultSelection, requestPmoTeamsTopicFloatingOpen, readPmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { moteTopics, defaultTab, neighborTab, neighborAgent, defaultAgent, executionAgent, scratchWorkspace, quietMoteId, quietTab } from './fixtures/mote-workface'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'

const conversation: MoteDefaultConversation = { hostId: 'local', sessionId: neighborAgent.id, displayWorkspaceId: SCRATCH_WORKSPACE_ID,
  groupId: 'mote-group', tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
let app: MoteAppFixture
function preferences() {
  const topic = { ...moteTopics[0]!, quickMode: { status: 'saved' as const, defaults: { executorId: 'fixture', conversation }, version: 'saved-settings' } }
  const topics = [topic, ...moteTopics.slice(1)]
  useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 0, topics, error: null, reading: false } } })
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(item => item.id === id) ?? null)
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  return topic
}
beforeEach(() => { app = createMoteApp(); vi.spyOn(api.files, 'readDirectory').mockResolvedValue([]) })
afterEach(async () => { await app.dispose() })
describe('original Mote quick preferences', () => {
  it('uses portable identities and preserves unrelated YAML, comments and user Markdown', () => {
    const original = '---\nversion: 1 # format\nlanguage: zh-CN\ndefaults:\n  other: kept\n---\n# My notes\nDo not lose this.\n'
    const saved = serializeMoteQuickMode(original, { executorId: 'fixture', conversation })
    expect(parseMoteQuickMode(saved)).toEqual({ status: 'valid', defaults: { executorId: 'fixture', conversation } })
    for (const text of ['# format', 'language: zh-CN', 'other: kept', '# My notes\nDo not lose this.\n']) expect(saved).toContain(text)
    const cleared = serializeMoteQuickMode(saved, {})
    expect(parseMoteQuickMode(cleared)).toEqual({ status: 'valid', defaults: {} }); expect(cleared).toContain('other: kept')
  })
  it.each(['---\nversion: 2\n---\n', '---\nversion: 1\nversion: 1\n---\n', '---\nversion: 1\ndefaults: []\n---\n', '---\nversion: 1\ndefaults: {executorId: /absolute}\n---\n', '---\nversion: 1\ndefaults: {conversation: {sessionId: missing-tuple}}\n---\n'])('retains invalid original configuration without a guessed default: %s', content => {
    expect(parseMoteQuickMode(content).status).toBe('unconfirmed'); expect(() => serializeMoteQuickMode(content, {})).toThrow()
  })
  it('confirms the exact original Session, Region and Group, not a neighbor or first occurrence', () => {
    const topic = preferences(), state = useAppStore.getState(), catalog = spatialCatalog(state, moteTopics)
    expect(resolveMoteDefaultConversation(state, topic, SCRATCH_WORKSPACE_ID, catalog).conversation).toEqual(conversation)
    const replaced = { ...state, tabs: { ...state.tabs, [neighborTab.id]: { ...neighborTab, regions: { ...neighborTab.regions,
      [conversation.regionId]: { ...neighborTab.regions[conversation.regionId]!, sessionId: defaultAgent.id } } } } }
    expect(resolveMoteDefaultConversation(replaced, topic, SCRATCH_WORKSPACE_ID, catalog).conversation).toBeUndefined()
    const missing = { ...topic, quickMode: { ...topic.quickMode, defaults: { conversation: { ...conversation, groupId: 'missing-group' } } } }
    expect(resolveMoteDefaultConversation(state, missing, SCRATCH_WORKSPACE_ID, catalog).issue).toContain('kept')
  })
  it('orders and protects only the configured occurrence without mutating the original layout', () => {
    const ids = [defaultTab.id, neighborTab.id]
    expect(moteTabOrder(ids, conversation, SCRATCH_WORKSPACE_ID, 'mote-group')).toEqual([neighborTab.id, defaultTab.id])
    expect(ids).toEqual([defaultTab.id, neighborTab.id])
    expect(moteTabOrder(ids, conversation, SCRATCH_WORKSPACE_ID, 'another-group')).toBe(ids)
    expect(motePinnedTab(conversation, 'project', 'mote-group', neighborTab.id)).toBe(false)
    expect(moteTabOrder(ids, undefined, SCRATCH_WORKSPACE_ID, 'mote-group')).toBe(ids)
  })
  it('preselects the original new Launcher without changing global preference, drafts or Run', () => {
    preferences(); const state = useAppStore.getState(), before = useLauncherState.getState().executors
    const id = state.openLauncher({ workspaceId: SCRATCH_WORKSPACE_ID, topicId: PMO_TEAMS_TOPIC_ID, tabGroupId: 'mote-group', reveal: false })!
    const tab = useAppStore.getState().tabs[id]!, region = tab.regions[tab.layout.activeRegionId]!
    expect(region.kind).toBe('launcher'); expect('executorId' in region && region.executorId).toBe('fixture')
    expect(moteDefaultExecutor(useAppStore.getState(), SCRATCH_WORKSPACE_ID, quietMoteId)).toBeUndefined()
    expect(useLauncherState.getState().executors).toBe(before)
    expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('enters through original Space and floating authority while explicit exact navigation wins', async () => {
    preferences()
    await useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID)
    expect(useAppStore.getState().workbenchSpaceSelection?.tabId).toBe(neighborTab.id)
    expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe(conversation.regionId)
    expect(floatingMoteDefaultSelection({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID }).reference).toEqual({ displayWorkspaceId: conversation.displayWorkspaceId, groupId: conversation.groupId, tabId: conversation.tabId, regionId: conversation.regionId })
    requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID })
    expect(readPmoTeamsTopicFloatingState()?.targetTabId).toBe(neighborTab.id)
    requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id })
    expect(readPmoTeamsTopicFloatingState()?.targetTabId).toBe(defaultTab.id)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('renders the original tab strip first/pinned and rejects its close without stopping the Agent', async () => {
    preferences(); await app.mount()
    const buttons = [...app.container.querySelectorAll<HTMLElement>('.pane-tabbar .workbench-tab')]
    expect(buttons.length).toBeGreaterThan(0)
    const pin = app.container.querySelector<HTMLElement>('[aria-label="Main Agent"]')
    expect(pin).not.toBeNull()
    await moteClick(pin!.closest<HTMLElement>('[role="button"]')!)
    await settleMoteApp()
    expect(useAppStore.getState().tabs[neighborTab.id]).toBeDefined()
    expect(useAppStore.getState().reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('main Agent conversation stays open') }), expect.anything())
    expect(app.stop).not.toHaveBeenCalled()
  })
})

describe('[survey-delivery-close] one original Tab close owner', () => {
  async function surveyCloseMain() {
    const state = useAppStore.getState(), catalog = spatialCatalog(state, moteTopics)
    const zoneId = catalog.tabs.find(tab => tab.tabId === neighborTab.id)!.zoneId!
    expect(state.setSurveyZoneCollected(zoneId, true)).toBe(true)
    await app.mount()
    await moteClick(app.container.querySelector<HTMLElement>('[aria-label="Survey: browse and explore"]')!)
    const row = [...app.container.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(row => row.dataset.surveyZoneId === zoneId)!
    expect(row).toBeDefined()
    const column = row.querySelector<HTMLElement>(`[data-survey-tab-id="${neighborTab.id}"]`)!
    expect(column).not.toBeNull()
    await moteClick(column.parentElement!.querySelector<HTMLElement>('.survey-tab-close')!)
  }
  it('protects a legally collected Mote original through Survey and direct Store without opening a stop confirmation', async () => {
    preferences()
    const stop = vi.spyOn(api.sessions, 'stop'), before = useAppStore.getState()
    await surveyCloseMain()
    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').not.toContain('Stop Agent Session?')
    expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', neighborTab.id, { keepAgentSessions: true })).toBe(false)
    expect(useAppStore.getState().tabs[neighborTab.id]).toBe(before.tabs[neighborTab.id])
    expect(useAppStore.getState().sessions.map(({ id, control, processState }) => ({ id, control, processState })))
      .toEqual(before.sessions.map(({ id, control, processState }) => ({ id, control, processState })))
    expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
    expect(useAppStore.getState().reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('main Agent conversation stays open') }), expect.anything())
    expect(stop).not.toHaveBeenCalled()
  })
  it.each(['Keep Session & Close', 'Stop & Close'])('rechecks the original pin at confirmation commit: %s', async action => {
    const stop = vi.spyOn(api.sessions, 'stop')
    await surveyCloseMain()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Stop Agent Session?')
    const before = useAppStore.getState()
    await act(async () => { preferences() })
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === action)!
    expect(button).toBeDefined(); await moteClick(button)
    expect(useAppStore.getState().tabs[neighborTab.id]).toBe(before.tabs[neighborTab.id])
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(stop).not.toHaveBeenCalled()
  })
  it('closes another exact display binding and allows the original after an explicit unpin', async () => {
    const topic = preferences(), state = useAppStore.getState()
    useAppStore.setState({ layouts: { ...state.layouts, project: createWorkspaceLayout('project-copy', [neighborTab.id]) } })
    expect(await useAppStore.getState().closeTab('project', 'project-copy', neighborTab.id, { keepAgentSessions: true })).toBe(true)
    expect(useAppStore.getState().tabs[neighborTab.id]).toBe(state.tabs[neighborTab.id])
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.tabOrder).toContain(neighborTab.id)
    const unpinned = { ...topic, quickMode: { status: 'saved' as const, defaults: {}, version: 'explicit-unpin' } }
    useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics: [unpinned, ...moteTopics.slice(1)], error: null, reading: false } } })
    expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', neighborTab.id, { keepAgentSessions: true })).toBe(true)
    expect(useAppStore.getState().tabs[neighborTab.id]).toBeUndefined()
    expect(useAppStore.getState().sessions).toBe(state.sessions)
  })
  it('protects a Project Agent linked to a Mote using that Mote preference owner, while another display remains closable', async () => {
    const topic = preferences(), initial = useAppStore.getState()
    const projectTab = createWorkbenchTab('cross-resource-main', { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: 'cross-resource-region', sessionId: executionAgent.id }, 'Existing Project Agent')
    const projectLayout = createWorkspaceLayout('project-original', [projectTab.id])
    projectLayout.groups.push({ id: 'project-other-view', tabOrder: [projectTab.id], activeTabId: projectTab.id, recentTabIds: [projectTab.id] })
    projectLayout.root = { type: 'split', direction: 'horizontal', ratio: 0.5, first: projectLayout.root, second: { type: 'leaf', groupId: 'project-other-view' } }
    useAppStore.setState({ tabs: { ...initial.tabs, [projectTab.id]: projectTab }, layouts: { ...initial.layouts, project: projectLayout } })
    const original = spatialCatalog(useAppStore.getState(), moteTopics)
    const zoneId = original.tabs.find(tab => tab.tabId === projectTab.id)!.zoneId!
    const moteSpaces = original.spaces.filter(space => space.kind === 'mote' && space.topicId === topic.id)
    expect(moteSpaces).toHaveLength(1)
    const origin = original.bindings.find(binding => binding.zoneId === zoneId)!
    expect(origin).toBeDefined()
    const saved = { hostId: executionAgent.control.hostId, sessionId: executionAgent.id, displayWorkspaceId: 'project', groupId: 'project-original', tabId: projectTab.id, regionId: projectTab.layout.activeRegionId }
    const linkedTopic = { ...topic, quickMode: { status: 'saved' as const, version: 'linked-project-main', defaults: { conversation: saved } } }
    const topics = [linkedTopic, ...moteTopics.slice(1)]
    useAppStore.setState({ spaceZoneBindings: { ...initial.spaceZoneBindings, [zoneId]: { workspaceId: 'project', spaceId: origin.spaceId, relations: { [moteSpaces[0]!.spaceId]: true } } },
      scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics, error: null, reading: false } } })
    vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
    vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
    const state = useAppStore.getState(), catalog = spatialCatalog(state, topics)
    expect(catalog.locations.some(location => location.tabId === projectTab.id && location.workspaceId === 'project' && location.spaceId === moteSpaces[0]!.spaceId)).toBe(true)
    expect(resolveMoteDefaultConversation(state, linkedTopic, SCRATCH_WORKSPACE_ID, catalog).conversation).toEqual(saved)
    expect(moteConversationChoices(state, linkedTopic, SCRATCH_WORKSPACE_ID, catalog)).toContainEqual(saved)
    expect(state.setSurveyZoneCollected(zoneId, true)).toBe(true)
    const stop = vi.spyOn(api.sessions, 'stop')
    await app.mount(); await moteClick(app.container.querySelector<HTMLElement>('[aria-label="Survey: browse and explore"]')!)
    const row = [...app.container.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(row => row.dataset.surveyZoneId === zoneId)!
    expect(row).toBeDefined(); await moteClick(row.querySelector<HTMLElement>('.survey-item-tab-close')!)
    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').not.toContain('Stop Agent Session?')
    expect(await useAppStore.getState().closeTab('project', 'project-original', projectTab.id, { keepAgentSessions: true })).toBe(false)
    expect(useAppStore.getState().tabs[projectTab.id]).toBe(projectTab)
    expect(await useAppStore.getState().closeTab('project', 'project-other-view', projectTab.id, { keepAgentSessions: true })).toBe(true)
    expect(useAppStore.getState().tabs[projectTab.id]).toBe(projectTab)
    expect(useAppStore.getState().layouts.project!.groups.find(group => group.id === 'project-original')!.tabOrder).toContain(projectTab.id)
    expect(useAppStore.getState().sessions.find(session => session.id === executionAgent.id)?.control).toEqual(executionAgent.control)
    expect(stop).not.toHaveBeenCalled()
  })
  it.each(['different-region', 'replacement-session', 'unconfirmed-config'] as const)('does not infer a pin from stale or unknown facts: %s', async kind => {
    const topic = preferences(), state = useAppStore.getState()
    if (kind === 'replacement-session') useAppStore.setState({ tabs: { ...state.tabs, [neighborTab.id]: { ...neighborTab,
      regions: { ...neighborTab.regions, [conversation.regionId]: { ...neighborTab.regions[conversation.regionId]!, sessionId: defaultAgent.id } } } } })
    else {
      const changed = { ...topic, quickMode: kind === 'unconfirmed-config'
        ? { status: 'unconfirmed' as const, message: 'Original settings observation unavailable' }
        : { status: 'saved' as const, defaults: { conversation: { ...conversation, regionId: 'different-original-region' } }, version: 'changed' } }
      useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics: [changed, ...moteTopics.slice(1)], error: null, reading: false } } })
    }
    expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', neighborTab.id, { keepAgentSessions: true })).toBe(true)
    expect(useAppStore.getState().tabs[neighborTab.id]).toBeUndefined()
    expect(useAppStore.getState().sessions).toBe(state.sessions)
  })
})

describe('quick-mode original consumer counterexamples', () => {
  it('stores the Core Session and execution Host instead of a renderer alias or directory Host', () => {
    const topic = preferences(), state = useAppStore.getState()
    const session = { ...neighborAgent, id: neighborAgent.id, hostId: 'execution-host', control: { ...neighborAgent.control, hostId: 'execution-host', agentSessionId: 'durable-core-session' } }
    const actual = { ...state, sessions: state.sessions.map(item => item.id === neighborAgent.id ? session : item) }
    const catalog = spatialCatalog(actual, moteTopics)
    const choice = moteConversationChoices(actual, topic, SCRATCH_WORKSPACE_ID, catalog).find(item => item.tabId === neighborTab.id)!
    expect(choice).toMatchObject({ hostId: 'execution-host', sessionId: 'durable-core-session' })
    expect(resolveMoteDefaultConversation(actual, { ...topic, quickMode: { status: 'saved', defaults: { conversation: choice }, version: '' } }, SCRATCH_WORKSPACE_ID, catalog).conversation).toEqual(choice)
    expect(resolveMoteDefaultConversation(actual, topic, SCRATCH_WORKSPACE_ID, catalog).conversation).toBeUndefined()
  })
  it('cold directory discovery selects the real foreign display layout and original Region', async () => {
    const topic = preferences(), state = useAppStore.getState()
    const preferred = { ...conversation, displayWorkspaceId: 'project', groupId: 'project-group' }
    const fresh = { ...topic, quickMode: { status: 'saved' as const, defaults: { conversation: preferred }, version: 'fresh' } }
    useAppStore.setState({ scratchTopicSnapshots: {}, layouts: { ...state.layouts, project: createWorkspaceLayout('project-group', [defaultTab.id, neighborTab.id]) } })
    vi.mocked(api.scratch.readTopic).mockResolvedValue(fresh)
    await useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID)
    const after = useAppStore.getState()
    expect(after.activeWorkspaceId).toBe('project')
    expect(after.workbenchSpaceSelection).toMatchObject({ workspaceId: 'project', groupId: 'project-group', tabId: neighborTab.id, regionId: conversation.regionId })
    expect(after.layouts.project?.groups[0]?.activeTabId).toBe(neighborTab.id)
    expect(after.agentComposerDrafts).toBe(state.agentComposerDrafts); expect(app.launch).not.toHaveBeenCalled()
  })
  it('a fresh directory default cannot override the later original input or exact navigation', async () => {
    const topic = preferences()
    let finish!: (value: typeof topic) => void
    vi.mocked(api.scratch.readTopic).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const opening = useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID)
    useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id, 'local')
    useAppStore.getState().setAgentComposerDraft(defaultTab.layout.activeRegionId, 'Later real input')
    finish(topic); expect(await opening).toBe(false)
    expect(useAppStore.getState().workbenchSpaceSelection?.tabId).toBe(defaultTab.id)
    expect(useAppStore.getState().agentComposerDrafts[defaultTab.layout.activeRegionId]).toBe('Later real input')
  })
  it('shows ordered Executors and keeps Main managed by AgentMux, while Cancel never writes', async () => {
    preferences(); const text = serializeMoteQuickMode('', { executorId: 'fixture', conversation })
    vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: moteTopics[0]!.directoryPath, path: moteTopics[0]!.directoryPath.slice(scratchWorkspace.path.length + 1) + '/' + params.path }, result: { status: 'read', document: { path: moteTopics[0]!.directoryPath.slice(scratchWorkspace.path.length + 1) + '/' + params.path, content: text, revision: 'sha256:' + '1'.repeat(64) } } }))
    const read = vi.spyOn(api.motePreferences, 'read').mockImplementation(async params => ({ kind: 'quick', target: params.target, status: 'ready', main: true, issue: null,
      source: await api.files.readPublic({ ...params.target, expectedResource: params.target.expectedResource, path: 'MOTE.md' }),
      defaults: { executorId: 'fixture', conversation }, choices: params.includeChoices === false ? null : { executors: [{ id: 'fixture', name: 'Fixture', providerId: 'fixture' }, { id: 'codex', name: 'Codex', providerId: 'codex' }], conversations: null, destinations: null } }))
    const save = vi.spyOn(api.motePreferences, 'save')
    useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
    await app.mount()
    await moteClick(app.container.querySelector<HTMLElement>('[aria-label="Edit quick mode"]')!)
    await vi.waitFor(() => expect(document.querySelector('.mote-executor-priority .selection-field')).not.toBeNull())
    const priority = document.querySelector<HTMLFieldSetElement>('.mote-executor-priority')!
    const add = priority.querySelector<HTMLButtonElement>('[aria-label="Add Executor"]')!
    const order = () => [...priority.querySelectorAll('li > span')].map(row => row.textContent)
    expect(order()).toEqual(['Fixture'])
    expect(document.querySelector('.selection-field[aria-label="Main Agent"]')).toBeNull()
    await moteClick(add)
    await moteClick(document.querySelector<HTMLElement>('[role="option"][data-value="codex"]')!)
    expect(order()).toEqual(['Fixture', 'Codex'])
    await moteClick(priority.querySelector<HTMLElement>('[aria-label="Move Codex up"]')!)
    expect(order()).toEqual(['Codex', 'Fixture'])
    await moteClick(priority.querySelector<HTMLElement>('[aria-label="Remove Fixture"]')!)
    expect(order()).toEqual(['Codex'])
    expect(read).toHaveBeenCalled()
    await moteClick(document.querySelector<HTMLElement>('[aria-label="Close quick mode"]')!)
    expect(save).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
  })
  it('an unconfirmed source refuses only Save and keeps user choices, input and Agent', async () => {
    const topic = preferences(), scope = { topic, workspace: scratchWorkspace, rootPath: topic.directoryPath.slice(scratchWorkspace.path.length + 1) }
    const text = serializeMoteQuickMode('', { executorId: 'fixture', conversation }), open = vi.fn()
    const save = vi.spyOn(api.motePreferences, 'save')
    vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: moteTopics[0]!.directoryPath, path: moteTopics[0]!.directoryPath.slice(scratchWorkspace.path.length + 1) + '/' + params.path }, result: { status: 'read', document: { path: moteTopics[0]!.directoryPath.slice(scratchWorkspace.path.length + 1) + '/' + params.path, content: text, revision: 'sha256:' + '2'.repeat(64) } } }))
    await expect(saveMoteQuickDefaults(scope, { executorId: 'fixture', conversation }, { document: { path: scope.rootPath + '/MOTE.md', content: text, revision: 'sha256:' + '1'.repeat(64) }, defaults: { executorId: 'fixture', conversation } }, open, () => true)).rejects.toThrow('Keep your draft')
    expect(save).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
  })
})


describe('original floating Launcher identity', () => {
  it('uses the actual floating Mote rather than background context and keeps manual choice local', async () => {
    preferences(); const state = useAppStore.getState()
    const topics = state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics!.map(topic => topic.id === quietMoteId ? { ...topic, quickMode: { status: 'saved' as const, defaults: { executorId: 'quiet-agent' }, version: 'quiet' } } : topic)
    useAppStore.setState({ config: { ...state.config!, executors: { ...state.config!.executors, 'quiet-agent': { ...state.config!.executors.fixture!, label: 'Quiet Agent' } } }, scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics } } })
    vi.mocked(api.scratch.listTopics).mockResolvedValue(topics); vi.mocked(api.scratch.readTopic).mockImplementation(async (_w,id)=>topics.find(t=>t.id===id)??null)
    const global = useLauncherState.getState().executors
    vi.mocked(api.scratch.listTopics).mockResolvedValue(topics); vi.mocked(api.scratch.readTopic).mockImplementation(async (_w,id)=>topics.find(t=>t.id===id)??null)
    await app.mount()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: quietMoteId, targetTabId: quietTab.id, reference: { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: quietTab.id, regionId: 'quiet-region' } }))
    await settleMoteApp()
    const input = app.panel().querySelector<HTMLElement>('.agent-pick[aria-pressed="true"]')!
    expect(input?.dataset.executorId).toBe('quiet-agent')
    await moteClick(app.panel().querySelector<HTMLElement>('[data-executor-id="fixture"]')!)
    expect(app.panel().querySelector<HTMLElement>('.agent-pick[aria-pressed="true"]')?.dataset.executorId).toBe('fixture')
    expect(useLauncherState.getState().executors).toBe(global)
    expect(useAppStore.getState().agentComposerDrafts['quiet-region']).toBe('Launcher unsent')
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('keeps a missing saved Executor visible instead of choosing another installed Agent', async () => {
    const state = useAppStore.getState(), topics = moteTopics.map(topic => topic.id === quietMoteId ? { ...topic, quickMode: { status: 'saved' as const, defaults: { executorId: 'saved-unavailable-agent' }, version: 'missing' } } : topic)
    useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 0, topics, error: null, reading: false } } })
    vi.mocked(api.scratch.listTopics).mockResolvedValue(topics); vi.mocked(api.scratch.readTopic).mockImplementation(async (_w,id)=>topics.find(t=>t.id===id)??null)
    await app.mount()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: quietMoteId, targetTabId: quietTab.id, reference: { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: quietTab.id, regionId: 'quiet-region' } }))
    await settleMoteApp()
    expect(app.panel().textContent).toContain('saved-unavailable-agent')
    expect(app.panel().querySelector('.agent-pick[aria-pressed="true"]')).toBeNull()
    expect(app.launch).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts).toEqual(state.agentComposerDrafts)
  })
})
