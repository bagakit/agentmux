import { createWorkspaceLayout } from '@agentmux/layout'
import { saveMoteQuickDefaults } from '../src/renderer/src/lib/mote-quick-mode'
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseMoteQuickMode, serializeMoteQuickMode, type MoteDefaultConversation } from '../src/shared/mote-quick-mode'
import { moteConversationChoices, moteDefaultExecutor, motePinnedTab, moteTabOrder, resolveMoteDefaultConversation } from '../src/renderer/src/lib/mote-quick-preferences'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { floatingMoteDefaultSelection, requestPmoTeamsTopicFloatingOpen, readPmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { moteTopics, defaultTab, neighborTab, neighborAgent, defaultAgent, scratchWorkspace, quietMoteId, quietTab } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
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
    const pin = app.container.querySelector<HTMLElement>('[aria-label="Default conversation"]')
    expect(pin).not.toBeNull()
    await moteClick(pin!.closest<HTMLElement>('[role="button"]')!)
    await settleMoteApp()
    expect(useAppStore.getState().tabs[neighborTab.id]).toBeDefined()
    expect(useAppStore.getState().reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('default conversation stays open') }), expect.anything())
    expect(app.stop).not.toHaveBeenCalled()
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
  it('Profile displays saved choices and reopens them selected, while Cancel never writes', async () => {
    preferences(); const text = serializeMoteQuickMode('', { executorId: 'fixture', conversation })
    const read = vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: moteTopics[0]!.directoryPath, path: moteTopics[0]!.directoryPath.slice(scratchWorkspace.path.length + 1) + '/' + params.path }, result: { status: 'read', document: { path: moteTopics[0]!.directoryPath.slice(scratchWorkspace.path.length + 1) + '/' + params.path, content: text, revision: 'sha256:' + '1'.repeat(64) } } }))
    const write = vi.spyOn(api.files, 'write'), create = vi.spyOn(api.files, 'create')
    useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
    await app.mount()
    await moteClick(app.container.querySelector<HTMLElement>('[aria-label="Edit quick mode"]')!)
    const agent = document.querySelector<HTMLSelectElement>('select[aria-label="Default Agent"]')!, selected = document.querySelector<HTMLSelectElement>('select[aria-label="Default conversation"]')!
    expect(agent.value).toBe('fixture'); expect(JSON.parse(selected.value)).toEqual(conversation)
    expect(read).toHaveBeenCalled()
    await moteClick(document.querySelector<HTMLElement>('[aria-label="Close quick mode"]')!)
    expect(write).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
  })
  it('conflicting source revision refuses only Save and keeps user choices, input and Agent', async () => {
    const topic = preferences(), scope = { topic, workspace: scratchWorkspace, rootPath: topic.directoryPath.slice(scratchWorkspace.path.length + 1) }
    const text = serializeMoteQuickMode('', { executorId: 'fixture', conversation }), open = vi.fn()
    vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: moteTopics[0]!.directoryPath, path: moteTopics[0]!.directoryPath.slice(scratchWorkspace.path.length + 1) + '/' + params.path }, result: { status: 'read', document: { path: moteTopics[0]!.directoryPath.slice(scratchWorkspace.path.length + 1) + '/' + params.path, content: text, revision: 'sha256:' + '2'.repeat(64) } } }))
    await expect(saveMoteQuickDefaults(scope, { executorId: 'fixture', conversation }, { document: { path: scope.rootPath + '/MOTE.md', content: text, revision: 'sha256:' + '1'.repeat(64) }, defaults: { executorId: 'fixture', conversation } }, open, () => true)).rejects.toThrow('kept')
    expect(api.files.readPublic).toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
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
