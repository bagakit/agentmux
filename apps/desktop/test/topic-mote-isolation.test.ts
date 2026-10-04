import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, ScratchTopicSnapshot, SessionSnapshot } from '../src/shared/contracts'
import type { TopicCategory } from '@agentmux/core/control'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId, topicSpatialAddress, workspaceZoneId } from '../src/shared/space-addresses'
import { scratchTopicsScope, scratchTopicKind, scratchMoteTopics } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { workbenchObjectLayout, workbenchSelectionCatalog, restoreWorkbenchSpaceSelection } from '../src/renderer/src/lib/desktop-focus-navigation'
import { useWorkbenchObjectLayout } from '../src/renderer/src/hooks/useWorkbenchObjectLayout'
import { useMoteWorkfaceScope } from '../src/renderer/src/lib/mote-workface'
import { dispatchWorkbenchCommand } from '../src/renderer/src/lib/workbench-shortcuts'

const initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Fixture' }], executors: {},
  workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path: _hygiene_fixturePath("private/scratch"), kind: 'folder' },
    { id: 'project', name: 'Project', hostId: 'local', path: _hygiene_fixturePath("private/project"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true,
    devTools: true, viewport: true, saveBookmark: true, more: true } } }
const scratch = config.workspaces[0]!
const category: TopicCategory = { categoryId: '00000000-0000-4000-8000-000000000000', spaceId: directoryIdentity('local', _hygiene_fixturePath("private/categories/default")),
  title: 'Unclassified', directoryPath: _hygiene_fixturePath("private/categories/default"), hostId: 'local', revision: 'fixture' }
const topic = (id: string, mote = false): ScratchTopicSnapshot => ({ id, title: id, summary: '', collaborators: [],
  directoryPath: (_hygiene_fixturePath("private/scratch/") + (scratchTopicDirectoryName(id)) + ""), physicalDirectoryPath: (_hygiene_fixturePath("private/") + (mote ? 'motes' : 'topics') + "/" + (scratchTopicDirectoryName(id)) + ""),
  identityDirectoryPath: (_hygiene_fixturePath("private/scratch/") + (scratchTopicDirectoryName(id)) + ""),
  topicPath: (_hygiene_fixturePath("private/") + (mote ? 'motes' : 'topics') + "/" + (id) + "/topic.md"),
  ...(mote ? { soul: { path: (_hygiene_fixturePath("private/motes/") + (id) + "/SOUL.md"), content: '# Fixture', version: '1' } } : {}) })
const mote = topic('view:mote', true), first = topic('view:first'), second = topic('view:second')
const topics = [mote, first, second]
const moteAddress = topicSpatialAddress(config, mote, {}, [category])!
const knowledgeBindings = Object.fromEntries([first, second].map(topic => {
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath!)
  return [homeZoneId(spaceId), { spaceId, workspaceId: SCRATCH_WORKSPACE_ID, relations: { [category.spaceId]: true } }]
}))
const firstAddress = topicSpatialAddress(config, first, knowledgeBindings, [category])!
const secondAddress = topicSpatialAddress(config, second, knowledgeBindings, [category])!
const folderSpace = directoryIdentity('local', _hygiene_fixturePath("private/project")), projectZone = workspaceZoneId(folderSpace, 'project')
const session: SessionSnapshot = { id: 'healthy', kind: 'agent', hostId: 'local', executorId: 'fixture', providerId: 'codex',
  workspacePath: _hygiene_fixturePath("original/execution"), label: 'Healthy', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0,
  status: { state: 'running', source: 'run-process', observedAt: 1 }, capabilities: { terminal: true, timeline: 'streaming',
    permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'healthy', run: { runId: 'original-run' } } }
function launcher(id: string, address: { spaceId: string; zoneId: string }, topicId?: string, workspaceId = SCRATCH_WORKSPACE_ID): WorkbenchTab {
  return { ...createWorkbenchTab(id, { kind: 'launcher', workspaceId, regionId: `region:${id}` }), space: address, ...(topicId ? { topicId } : {}) }
}
let root: Root | undefined, host: HTMLElement | undefined
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState(initial, true)
  const own = { ...createWorkbenchTab('mote-agent', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
    regionId: 'agent-region', sessionId: session.id }), topicId: mote.id, space: moteAddress }
  const container = directoryIdentity('local', scratch.path)
  const free = Array.from({ length: 5 }, (_, index) => {
    const space = { spaceId: container, zoneId: index < 2 ? homeZoneId(container) : `unbound-zone:${index}` }
    return index < 3 ? { ...createWorkbenchTab(`free-${index}`, { kind: 'browser', workspaceId: SCRATCH_WORKSPACE_ID,
      regionId: `free-region:${index}`, browserId: `browser:${index}`, id: `browser:${index}`, navigationId: `navigation:${index}`,
      profileId: 'default', url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false,
      viewport: 'responsive', driving: false, appLinkPrompt: null, error: null }), space }
      : { ...createWorkbenchTab(`free-${index}`, { kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID,
        regionId: `free-region:${index}`, path: `${index}.note.json` }), space }
  })
  const tabs = [own, launcher('mote-chat', moteAddress, mote.id), launcher('topic-first', { ...firstAddress, spaceId: knowledgeBindings[firstAddress.zoneId]!.spaceId }, first.id),
    launcher('topic-second', { ...secondAddress, spaceId: knowledgeBindings[secondAddress.zoneId]!.spaceId }, second.id),
    launcher('project-tab', { spaceId: folderSpace, zoneId: projectZone }, undefined, 'project'), ...free]
  useAppStore.setState({ config, topicCategories: [category], sessions: [session], activeWorkspaceId: SCRATCH_WORKSPACE_ID,
    mainSurface: 'workbench', tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])),
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group', tabs.filter(tab => tab.workspaceId === SCRATCH_WORKSPACE_ID).map(tab => tab.id)),
      project: createWorkspaceLayout('project-group', ['project-tab']) },
    spaceZoneBindings: { ...knowledgeBindings, ...Object.fromEntries(free.map(tab => [tab.space.zoneId, { spaceId: tab.space.spaceId, workspaceId: tab.workspaceId }])) },
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratch), topics, revision: 0, reading: false, error: null } },
    workbenchSpaceSelection: null, retainedSpatialFocus: null, agentFocus: { execution: { sessionId: session.id, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { healthy: 'Unsent original draft' }, error: null, errorDismissed: true })
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; host?.remove(); host = undefined
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function displayed(workspaceId = SCRATCH_WORKSPACE_ID) {
  const projected = workbenchObjectLayout(useAppStore.getState(), workspaceId)
  return [...new Set(projected.layout?.groups.flatMap(group => group.tabOrder) ?? [])]
}
function Probe({ workspaceId }: { workspaceId: string }) {
  const body = useWorkbenchObjectLayout(workspaceId)
  const scope = useMoteWorkfaceScope(workspaceId)
  return createElement('div', { 'data-ids': body.layout?.groups.flatMap(group => group.tabOrder).join(','),
    'data-root': scope?.rootPath, 'data-topic': scope?.topic.id, 'data-mote-issue': scope?.issue }, body.issues.join(' '))
}
async function mount(workspaceId = SCRATCH_WORKSPACE_ID) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(createElement(Probe, { workspaceId })))
}
describe('actual Topic/Mote navigation and Renderer membership owners', () => {
  it('tree entry establishes the exact Mote and local Group/Region/Tab/shortcut clicks retain it without free or foreign content', async () => {
    const before = useAppStore.getState()
    await before.openScratchTopic(mote.id)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ ...moteAddress, topicId: mote.id })
    expect(displayed().sort()).toEqual(['mote-agent', 'mote-chat'])
    await mount()
    expect(host!.firstElementChild!.getAttribute('data-ids')!.split(',').sort()).toEqual(['mote-agent', 'mote-chat'])
    await act(async () => {
      useAppStore.getState().focusTabGroup(SCRATCH_WORKSPACE_ID, 'scratch-group')
      useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, 'mote-agent', 'agent-region')
      dispatchWorkbenchCommand({ kind: 'step-tab', delta: 1 }, useAppStore.getState())
    })
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ ...moteAddress, tabId: 'mote-chat', topicId: mote.id })
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe('original-run')
    expect(useAppStore.getState().agentComposerDrafts).toEqual({ healthy: 'Unsent original draft' })
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })
  it('explicit Topic and ordinary unbound Tab navigation use separate Zones while all five original free Tabs remain reachable', async () => {
    await useAppStore.getState().openScratchTopic(first.id)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject(firstAddress)
    expect(firstAddress.spaceId).toBe(category.spaceId)
    expect(displayed()).toEqual(['topic-first'])
    useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'scratch-group', 'topic-second')
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject(secondAddress)
    expect(useAppStore.getState().workbenchSpaceSelection?.topicId).toBe(second.id)
    expect(displayed()).toEqual(['topic-second'])
    for (let index = 0; index < 5; index++) {
      useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'scratch-group', `free-${index}`)
      expect(useAppStore.getState().workbenchSpaceSelection?.topicId).toBeNull()
      expect(displayed()).toContain(`free-${index}`)
      expect(displayed()).not.toContain('mote-agent')
      expect(displayed()).not.toContain('topic-first')
    }
    expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(10)
    expect(new Set([0, 1, 2, 3, 4].map(index => useAppStore.getState().tabs[`free-${index}`]!.space!.zoneId)).size).toBe(4)
  })
  it('keeps legal multi-binding and cross-Workspace Mote context without changing resource roots, cwd or original IDs', async () => {
    await useAppStore.getState().openScratchTopic(mote.id)
    useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings, [projectZone]: {
      workspaceId: 'project', spaceId: folderSpace, relations: { [moteAddress.spaceId]: true } } } }))
    useAppStore.getState().activateTab('project', 'project-group', 'project-tab')
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: moteAddress.spaceId, zoneId: projectZone, topicId: mote.id })
    expect(workbenchSelectionCatalog(useAppStore.getState()).bindings.filter(binding => binding.zoneId === projectZone)).toHaveLength(2)
    await mount('project')
    expect(host!.firstElementChild!.getAttribute('data-topic')).toBe(mote.id)
    expect(host!.firstElementChild!.getAttribute('data-root')).toBe(scratchTopicDirectoryName(mote.id))
    expect(displayed('project')).toEqual(['project-tab'])
    expect(useAppStore.getState().tabs['project-tab']!.space).toEqual({ spaceId: folderSpace, zoneId: projectZone })
    expect(useAppStore.getState().sessions[0]!.workspacePath).toBe(_hygiene_fixturePath("original/execution"))
  })
  it('unknown position retains the same scoped body, exact reference, healthy Run and draft with a persistent service window', async () => {
    await useAppStore.getState().openScratchTopic(mote.id)
    await mount()
    const choice = useAppStore.getState().workbenchSpaceSelection
    await act(async () => useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings, [moteAddress.zoneId]: {
      workspaceId: SCRATCH_WORKSPACE_ID, spaceId: moteAddress.spaceId, relations: { [moteAddress.spaceId]: false } } } })))
    expect(host!.firstElementChild!.getAttribute('data-ids')!.split(',').sort()).toEqual(['mote-agent', 'mote-chat'])
    expect(host!.textContent).toMatch(/not confirmed/)
    useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, 'mote-agent', 'agent-region')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(choice)
    expect(useAppStore.getState().error).toBeTruthy()
    expect(useAppStore.getState().sessions[0]!.processState).toBe('running')
    expect(useAppStore.getState().agentComposerDrafts.healthy).toBe('Unsent original draft')
  })
  it('Session navigation uses its exact occurrence and refuses ambiguous aliases instead of choosing the first one', async () => {
    const state = useAppStore.getState(), saved = state.layouts[SCRATCH_WORKSPACE_ID]!
    useAppStore.setState({ layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...saved,
      root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: saved.root, second: { type: 'leaf', groupId: 'alias' } },
      groups: [...saved.groups, { id: 'alias', tabOrder: ['mote-agent'], activeTabId: 'mote-agent', recentTabIds: ['mote-agent'] }] } } })
    const before = useAppStore.getState()
    before.selectSession(session.id)
    expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().error).toMatch(/unique confirmed/)
    useAppStore.getState().focusExecutionSession(session.id, { displayWorkspaceId: SCRATCH_WORKSPACE_ID,
      groupId: 'alias', tabId: 'mote-agent', regionId: 'agent-region' })
    useAppStore.getState().selectSession(session.id)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ ...moteAddress, groupId: 'alias', tabId: 'mote-agent', regionId: 'agent-region' })
  })
  it('a confirmed empty Mote stays empty across surface return and durable selection recovery', async () => {
    useAppStore.setState(state => ({ tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => !id.startsWith('mote-'))),
      layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group', ['topic-first', 'topic-second', 'free-0']) } }))
    await useAppStore.getState().openScratchTopic(mote.id)
    const choice = useAppStore.getState().workbenchSpaceSelection
    expect(choice).toMatchObject({ ...moteAddress, tabId: null, groupId: null, regionId: null })
    expect(displayed()).toEqual([])
    useAppStore.getState().setMainSurface('agents'); useAppStore.getState().setMainSurface('workbench')
    useAppStore.setState({ workbenchSpaceSelection: restoreWorkbenchSpaceSelection(JSON.parse(JSON.stringify(choice))) })
    expect(displayed()).toEqual([])
    expect(Object.keys(useAppStore.getState().tabs).some(id => id.startsWith('launcher:'))).toBe(false)
  })
  it('explicit Mote creation keeps its born launcher, exact identity and first draft when metadata preparation is unavailable', async () => {
    vi.spyOn(api.scratch, 'ensureMote').mockRejectedValue(new Error('Private metadata failure'))
    const before = useAppStore.getState()
    await expect(before.createScratchTopic('mote', { prompt: 'First unsent request' })).rejects.toThrow('Private metadata failure')
    const state = useAppStore.getState(), choice = state.workbenchSpaceSelection!
    expect(choice.topicId).toMatch(/^launcher:/)
    expect(choice.tabId).toBeTruthy()
    expect(state.tabs[choice.tabId!]!.space).toEqual({ spaceId: choice.spaceId, zoneId: choice.zoneId })
    expect(displayed()).toEqual([choice.tabId])
    expect(state.agentComposerDrafts[choice.regionId!]).toBe('First unsent request')
    expect(state.sessions).toBe(before.sessions)
    expect(state.errorNoticeContext?.summary).toMatch(/preparation is unconfirmed/)
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })
  it('an empty SOUL and readError retain positive Mote identity and the same bounded material scope', async () => {
    const emptySoul = { ...mote, soul: { ...mote.soul!, content: '' }, readError: 'Private Soul read gap' }
    expect(scratchTopicKind(mote.id, [emptySoul])).toBe('mote')
    expect(scratchMoteTopics([emptySoul]).some(topic => topic.id === mote.id)).toBe(true)
    await useAppStore.getState().openScratchTopic(mote.id)
    await mount()
    const { soul: _unavailableSoul, ...unclassified } = mote
    await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: {
      ...state.scratchTopicSnapshots, [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!,
        topics: [{ ...unclassified, readError: 'Private metadata read gap' }, first, second], error: 'Private metadata read gap' } } })))
    expect(host!.firstElementChild!.getAttribute('data-topic')).toBe(mote.id)
    expect(host!.firstElementChild!.getAttribute('data-root')).toBe(scratchTopicDirectoryName(mote.id))
    expect(host!.firstElementChild!.getAttribute('data-mote-issue')).toMatch(/metadata read gap/)
    expect(displayed().sort()).toEqual(['mote-agent', 'mote-chat'])
  })
  it('a cold metadata gap uses the confirmed Core Mote origin and an explicit service window instead of whole-library scope', async () => {
    await useAppStore.getState().openScratchTopic(mote.id)
    vi.spyOn(useAppStore.getState(), 'refreshScratchTopics').mockResolvedValue(undefined)
    useAppStore.setState(state => ({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: {
      scope: scratchTopicsScope(scratch), topics: null, revision: 0, reading: false, error: 'Private cold gap' } },
      spaceZoneBindings: { ...state.spaceZoneBindings, [moteAddress.zoneId]: { spaceId: moteAddress.spaceId,
        workspaceId: SCRATCH_WORKSPACE_ID, contentKind: 'mote', topicId: mote.id, directoryPath: mote.physicalDirectoryPath! } } }))
    await mount()
    expect(host!.firstElementChild!.getAttribute('data-topic')).toBe(mote.id)
    expect(host!.firstElementChild!.getAttribute('data-root')).toBe(scratchTopicDirectoryName(mote.id))
    expect(host!.firstElementChild!.getAttribute('data-mote-issue')).toMatch(/metadata is not confirmed/)
    expect(displayed().sort()).toEqual(['mote-agent', 'mote-chat'])
    expect(useAppStore.getState().sessions[0]!.processState).toBe('running')
    expect(useAppStore.getState().agentComposerDrafts.healthy).toBe('Unsent original draft')
  })
})
