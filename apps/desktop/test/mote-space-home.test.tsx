// @vitest-environment happy-dom
import { act } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { ContinuousProgressLoop, FileReadParams, FileReadResult } from '@agentmux/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborTab, customTab, customAgent, customMoteId, quietMoteId, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { beginMoteStartupRecovery } from '../src/renderer/src/lib/mote-session-recovery'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { desktopWorkbenchObservationSchema } from '../src/shared/client-observation'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName, scratchTopicIdentityPath, scratchTopicLogicalPath } from '../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { createWorkbenchTab, documentKey, fileTabId } from '../src/renderer/src/lib/workbench-tabs'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'

let app: MoteAppFixture
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
const revision = 'sha256:' + 'b'.repeat(64)
const node = <T extends HTMLElement>(selector: string): T => {
  const found = app.container.querySelector<T>(selector)
  expect(found, selector).not.toBeNull(); return found!
}
const button = (label: string) => {
  const found = [...app.container.querySelectorAll<HTMLButtonElement>('.mote-space-frame__header button, [data-mote-details] button')]
    .find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
  expect(found, label).toBeDefined(); return found!
}
function material(params: FileReadParams): FileReadResult {
  return { resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: scratchWorkspace.path + '/' + rootPath, path: rootPath + '/' + params.path },
    result: { status: 'read', document: { path: rootPath + '/' + params.path, revision,
      content: params.path === 'MEMORY.md' ? '# Our working notes\nGive me a concrete next step.' : '# Saved original source\nKeep the source and its decisions.' } } }
}
async function type(selector: string, value: string) {
  const input = node<HTMLTextAreaElement>(selector)
  await act(async () => {
    input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }); await settleMoteApp()
}
beforeEach(() => {
  app = createMoteApp()
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ path: rootPath + '/experiment.md', name: 'experiment.md', isDirectory: false, isSymlink: false, ignored: false, mtimeMs: 2 }])
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => material(params))
  vi.spyOn(api.files, 'observe').mockResolvedValue()
  vi.spyOn(api.files, 'unobserve').mockResolvedValue()
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  vi.spyOn(api.schedule, 'onChanged').mockImplementation(() => () => {})
})
afterEach(async () => { await app.dispose() })

async function editPersona(topicId: string, floating = false) {
  const row = floating ? app.panel().querySelector<HTMLElement>('[data-mote-topic-id="' + topicId + '"]')! : node<HTMLElement>('[data-space-nav="topic:' + topicId + '"]')
  expect(row).not.toBeNull()
  await act(async () => {
    row.focus()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
  }); await settleMoteApp()
  const menu = document.querySelector('[role="menu"]')
  expect(menu).not.toBeNull()
  const edit = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Edit persona')
  expect(edit).toBeDefined(); await moteClick(edit!)
  expect(document.querySelector('[role="menu"]')).toBeNull()
}

async function expectPersonaRegion(regionId: string) {
  await vi.waitFor(() => {
    const region = app.container.querySelector<HTMLElement>('.workspace-main-surface [data-workbench-region-id="' + regionId + '"]')
    expect(region).not.toBeNull()
    expect(region!.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
  })
}

function emptyPersonaOwner(customDirectory = false, topicId = customMoteId) {
  const original = moteTopics.find(topic => topic.id === topicId)!
  const physicalDirectoryPath = scratchWorkspace.path + '/retained-persona'
  const topic = customDirectory ? { ...original, physicalDirectoryPath, identityDirectoryPath: physicalDirectoryPath,
    confirmedDirectoryPaths: [physicalDirectoryPath] } : original
  const topics = moteTopics.map(item => item.id === topic.id ? topic : item)
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(item => item.id === id) ?? null)
  useAppStore.setState(state => ({ projectRailOpen: true,
    tabs: Object.fromEntries(Object.entries(state.tabs).filter(([, tab]) => tab.topicId !== topic.id)),
    layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...state.layouts[SCRATCH_WORKSPACE_ID]!,
      groups: state.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({ ...group,
        tabOrder: group.tabOrder.filter(id => state.tabs[id]?.topicId !== topic.id),
        recentTabIds: group.recentTabIds.filter(id => state.tabs[id]?.topicId !== topic.id),
        activeTabId: group.activeTabId && state.tabs[group.activeTabId]?.topicId === topic.id ? defaultTab.id : group.activeTabId })) } },
    scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics } }
  }))
  const spaceId = directoryIdentity(scratchWorkspace.hostId, scratchTopicIdentityPath(scratchWorkspace, topic))
  return { topic, path: scratchTopicLogicalPath(scratchWorkspace, topic)! + '/SOUL.md', space: { spaceId, zoneId: homeZoneId(spaceId) } }
}

it.each([true, false])('keeps Space tool buttons in Discussion and the original sidebar reachable across Mote pages (sidebar open=%s)', async sidebarOpen => {
  useAppStore.setState({ projectRailOpen: sidebarOpen, toolsOpen: sidebarOpen })
  await app.mount()
  const tools = node('[aria-label="Space tool selection"]'), header = tools.closest<HTMLElement>('header')!
  const files = tools.querySelector('[data-space-tool="files-branches"]'), agents = tools.querySelector('[data-space-tool="agents"]')
  expect(files).not.toBeNull(); expect(agents).not.toBeNull(); expect(header.hidden).toBe(false)
  const before = useAppStore.getState()
  for (const page of ['Profile', 'Ideas', 'Calendar']) {
    await moteClick(button(page))
    expect(node('[aria-label="Space tool selection"]')).toBe(tools)
    expect(header.hidden).toBe(true)
    if (!sidebarOpen) {
      const sidebar = node<HTMLElement>('.mote-space-frame__header [data-project-rail-toggle]')
      expect(sidebar.closest('[hidden]')).toBeNull()
      expect(sidebar.getAttribute('aria-label')).toBe('Show projects sidebar')
    }
  }
  await moteClick(button('Discussion'))
  expect(header.hidden).toBe(false)
  if (!sidebarOpen) expect(node('.mote-space-frame').querySelectorAll('[aria-label="Window sidebars"]')).toHaveLength(1)
  expect(tools.querySelector('[data-space-tool="files-branches"]')).toBe(files)
  expect(tools.querySelector('[data-space-tool="agents"]')).toBe(agents)
  if (!sidebarOpen) {
    await moteClick(button('Profile'))
    await moteClick(node<HTMLElement>('.mote-space-frame__header [data-project-rail-toggle]'))
    expect(useAppStore.getState().projectRailOpen).toBe(true)
    expect(homeExpanded()).not.toBeNull()
  }
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it.each([false, true])('the real persona menu opens its empty Mote owner while another Topic remains in the original layout (custom physical directory=%s)', async customDirectory => {
  const owner = emptyPersonaOwner(customDirectory)
  const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: '# Original persona', revision } }))
  await app.mount()
  const before = useAppStore.getState()
  expect(before.layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBe(defaultTab.id)
  await editPersona(owner.topic.id)
  expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, owner.path)
  const state = useAppStore.getState(), selected = state.workbenchSpaceSelection!, tab = state.tabs[selected.tabId!]!
  expect(selected).toMatchObject({ ...owner.space, topicId: owner.topic.id, workspaceId: SCRATCH_WORKSPACE_ID })
  expect(tab.topicId).toBe(owner.topic.id); expect(tab.space).toEqual(owner.space)
  expect(tab.regions[selected.regionId!]).toMatchObject({ kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID, path: owner.path })
  await expectPersonaRegion(selected.regionId!)
  expect(homeExpanded()).toBeNull()
  expect(state.tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id]); expect(state.tabs[neighborTab.id]).toBe(before.tabs[neighborTab.id])
  expect(state.sessions).toBe(before.sessions); expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.ensureMote).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it.each([false, true])('the persona menu retains a foreign same-path dirty File and displays the original Mote in its own context (stored space=%s)', async storedSpace => {
  const owner = emptyPersonaOwner(), id = fileTabId(SCRATCH_WORKSPACE_ID, owner.path), key = documentKey(SCRATCH_WORKSPACE_ID, owner.path)
  const foreignSpaceId = directoryIdentity(scratchWorkspace.hostId, scratchTopicIdentityPath(scratchWorkspace, moteTopics[0]!))
  const foreign = { ...createWorkbenchTab(id, { kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'retained-foreign-file', path: owner.path }),
    topicId: PMO_TEAMS_TOPIC_ID, ...(storedSpace ? { space: { spaceId: foreignSpaceId, zoneId: homeZoneId(foreignSpaceId) } } : {}) }
  const document = { path: owner.path, content: '# Original unsaved persona\nKeep this user edit.', revision }
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [foreign.id]: foreign },
    layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [defaultTab.id, neighborTab.id, foreign.id]) },
    documents: { ...state.documents, [key]: document }, dirtyDocuments: { ...state.dirtyDocuments, [key]: true } }))
  const read = vi.spyOn(api.files, 'read')
  await app.mount(); const before = useAppStore.getState()
  await editPersona(owner.topic.id)
  const state = useAppStore.getState(), selected = state.workbenchSpaceSelection!, shown = state.tabs[selected.tabId!]!
  expect(selected).toMatchObject({ ...owner.space, topicId: owner.topic.id })
  expect(shown.id).not.toBe(foreign.id); expect(shown.topicId).toBe(owner.topic.id); expect(shown.space).toEqual(owner.space)
  expect(shown.regions[selected.regionId!]).toMatchObject({ kind: 'file', path: owner.path, workspaceId: SCRATCH_WORKSPACE_ID })
  await expectPersonaRegion(selected.regionId!)
  expect(state.tabs[foreign.id]).toBe(foreign)
  expect(state.layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.tabOrder).toContain(foreign.id)
  expect(state.documents[key]).toBe(document); expect(state.dirtyDocuments[key]).toBe(true); expect(read).not.toHaveBeenCalled()
  expect(state.tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id]); expect(state.sessions).toBe(before.sessions)
  expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts); expect(homeExpanded()).toBeNull()
})

it.each(['Profile', 'another Topic'] as const)('a delayed persona read retains later %s input and never retakes its display', async later => {
  const owner = emptyPersonaOwner()
  let finish!: () => void
  const read = vi.spyOn(api.files, 'read').mockImplementation((_workspace, path) => new Promise(resolve => {
    finish = () => resolve({ status: 'read', document: { path, content: '# Original delayed persona', revision } })
  }))
  await app.mount(); await editPersona(owner.topic.id)
  expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, owner.path)
  if (later === 'another Topic') await moteClick(node<HTMLElement>('[data-space-nav="topic:' + PMO_TEAMS_TOPIC_ID + '"]'))
  else await moteClick(button('Profile'))
  await type('[aria-label="A question for this Mote"]', 'Keep this later question unsent.')
  const before = useAppStore.getState(), home = homeExpanded(), input = node<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')
  expect(home).not.toBeNull(); expect(document.activeElement).toBe(input)
  await act(async () => finish()); await settleMoteApp()
  expect(homeExpanded()).toBe(home); expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(document.activeElement).toBe(input); expect(input.value).toBe('Keep this later question unsent.')
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, owner.path)]?.content).toBe('# Original delayed persona')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('the floating persona menu opens an empty original Mote File without borrowing the background Agent', async () => {
  const control = vi.spyOn(useAppStore.getState(), 'executeControl')
  const owner = emptyPersonaOwner(false, quietMoteId)
  const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: '# Quiet original persona', revision } }))
  await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: owner.topic.id })); await settleMoteApp()
  const before = useAppStore.getState()
  expect(before.workbenchSpaceSelection?.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  await editPersona(owner.topic.id, true)
  expect(control).toHaveBeenCalledOnce()
  await act(async () => { await control.mock.results[0]!.value }); await settleMoteApp()
  expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, owner.path)
  const state = useAppStore.getState(), selected = state.workbenchSpaceSelection!, tab = state.tabs[selected.tabId!]!
  expect(selected).toMatchObject({ ...owner.space, topicId: owner.topic.id, tabId: expect.any(String), regionId: expect.any(String) })
  expect(tab?.regions[selected.regionId!]).toMatchObject({ kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID, path: owner.path })
  await expectPersonaRegion(selected.regionId!)
  expect(readPmoTeamsTopicFloatingState()?.open).toBe(false)
  expect(state.tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id]); expect(state.tabs[neighborTab.id]).toBe(before.tabs[neighborTab.id])
  expect(state.sessions).toBe(before.sessions); expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('a delayed floating persona read retains later Mote A to B to A choices and newer input', async () => {
  const control = vi.spyOn(useAppStore.getState(), 'executeControl')
  const owner = emptyPersonaOwner(false, quietMoteId)
  let finish!: () => void
  const read = vi.spyOn(api.files, 'read').mockImplementation((_workspace, path) => new Promise(resolve => {
    finish = () => resolve({ status: 'read', document: { path, content: '# Retained delayed quiet persona', revision } })
  }))
  await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: owner.topic.id })); await settleMoteApp()
  await editPersona(owner.topic.id, true)
  expect(control).toHaveBeenCalledOnce()
  await act(async () => { await control.mock.results[0]!.value }); await settleMoteApp()
  expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, owner.path)
  for (const id of [customMoteId, owner.topic.id]) await moteClick(app.panel().querySelector<HTMLElement>('[data-mote-topic-id="' + id + '"]')!)
  await moteClick(button('Profile')); await type('[aria-label="A question for this Mote"]', 'Keep this later quiet question.')
  const before = useAppStore.getState(), floating = readPmoTeamsTopicFloatingState(), home = homeExpanded(), input = node<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')
  expect(floating?.open).toBe(true); expect(floating?.targetTopicId).toBe(owner.topic.id)
  await act(async () => finish()); await settleMoteApp()
  expect(readPmoTeamsTopicFloatingState()).toEqual(floating)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(homeExpanded()).toBe(home); expect(document.activeElement).toBe(input); expect(input.value).toBe('Keep this later quiet question.')
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, owner.path)]?.content).toBe('# Retained delayed quiet persona')
  const retainedFile = Object.values(useAppStore.getState().tabs).find(tab => tab.topicId === owner.topic.id &&
    Object.values(tab.regions).some(region => region.kind === 'file' && region.path === owner.path))!
  expect(retainedFile).toBeDefined()
  const fileChoice = app.panel().querySelector<HTMLButtonElement>('button[data-workbench-tab-id="' + retainedFile.id + '"]')
  expect(fileChoice).not.toBeNull(); await moteClick(fileChoice!)
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ targetTopicId: owner.topic.id, targetTabId: retainedFile.id,
    reference: { displayWorkspaceId: SCRATCH_WORKSPACE_ID, tabId: retainedFile.id, regionId: retainedFile.layout.activeRegionId } })
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('keeps the same original file tree only in Discussion while other Mote pages use its space', async () => {
  await app.mount()
  const tree = node('.file-explorer'), frame = tree.closest<HTMLElement>('.workspace-tool-explorer')!
  const search = node<HTMLInputElement>('.file-explorer input[placeholder="Find loaded files"]')
  const panel = tree.closest<HTMLElement>('[data-panel]')!, header = frame.querySelector<HTMLElement>('.workspace-tool-context')!
  const before = useAppStore.getState()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'experiment')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  for (const page of ['Profile', 'Ideas', 'Calendar']) {
    await moteClick(button(page))
    expect(node('.file-explorer')).toBe(tree)
    expect(header.hidden).toBe(true)
    expect(panel.style.display).toBe('none')
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(frame.classList.contains('workspace-tool-explorer--content-only')).toBe(true)
    expect(frame.querySelector('.workspace-tools-resize-handle')).toBeNull()
  }
  await moteClick(button('Discussion'))
  expect(node('.file-explorer')).toBe(tree)
  expect(node('.file-explorer input')).toBe(search)
  expect(search.value).toBe('experiment')
  expect(header.hidden).toBe(false)
  expect(panel.style.display).not.toBe('none')
  expect(frame.querySelector('.workspace-tools-resize-handle')).not.toBeNull()
  expect(useAppStore.getState().explorerCollapsed).toBe(before.explorerCollapsed)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('reveals the original New note input in Discussion even when its file dock was closed', async () => {
  useAppStore.setState({ toolsOpen: false, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: true } })
  const create = vi.spyOn(api.files, 'create')
  await app.mount(); await moteClick(button('Ideas'))
  const before = useAppStore.getState()
  await moteClick(button('New note'))
  expect(homeExpanded()).toBeNull()
  expect(useAppStore.getState().toolsOpen).toBe(true)
  const input = node<HTMLInputElement>('.file-explorer input[placeholder="file name"]')
  const panel = input.closest<HTMLElement>('[data-panel]')!
  expect(panel.style.display).not.toBe('none')
  expect(input.closest('.file-explorer')?.getAttribute('data-file-root')).toBe(rootPath)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'keep-this-draft.md')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await moteClick(button('Profile')); await moteClick(button('Discussion'))
  expect(node('.file-explorer input[placeholder="file name"]')).toBe(input)
  expect(input.value).toBe('keep-this-draft.md')
  expect(create).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('opens the exact original profile file in the Discussion Editor after hiding its tree', async () => {
  const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, revision, content: '# Original profile' } }))
  await app.mount(); await moteClick(button('Profile'))
  const before = useAppStore.getState()
  await moteClick(button('Edit profile'))
  expect(homeExpanded()).toBeNull()
  expect(read).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, rootPath + '/topic.md')
  const files = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions).filter(region => region.kind === 'file'))
  expect(files).toContainEqual(expect.objectContaining({ kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID, path: rootPath + '/topic.md' }))
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id])
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('finishes the original pending note creation without taking back a later Profile page', async () => {
  let complete!: () => void
  const create = vi.spyOn(api.files, 'create').mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
  const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, revision, content: '' } }))
  await app.mount(); await moteClick(button('Ideas')); await moteClick(button('New note'))
  const input = node<HTMLInputElement>('[aria-label="New file name"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'original-note.md')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(create).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, { path: rootPath + '/original-note.md', kind: 'file' })
  await moteClick(button('Profile'))
  const before = useAppStore.getState()
  await act(async () => complete()); await settleMoteApp()
  expect(homeExpanded()).not.toBeNull()
  expect(node('[data-mote-details]').getAttribute('data-section')).toBe('profile')
  expect(read).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  await moteClick(button('Discussion'))
  expect(app.container.querySelector('[aria-label="New file name"]')).toBeNull()
  expect(useAppStore.getState().fileExplorerStates[SCRATCH_WORKSPACE_ID]?.selection.activePath).toBe(rootPath + '/original-note.md')
  expect(create).toHaveBeenCalledTimes(1)
})

it('makes original memory a first-class home entry while keeping its exact source lazy and editable', async () => {
  await app.mount(); await moteClick(button('Profile'))
  const memory = node<HTMLDetailsElement>('[data-mote-memory]')
  expect(memory.closest('.mote-profile__preferences')).toBeNull()
  expect(memory.open).toBe(false)
  expect(vi.mocked(api.files.readPublic).mock.calls.filter(([params]) => params.path === 'MEMORY.md')).toEqual([])
  const before = useAppStore.getState()
  await act(async () => { memory.open = true; memory.dispatchEvent(new Event('toggle')) }); await settleMoteApp()
  const reads = vi.mocked(api.files.readPublic).mock.calls.filter(([params]) => params.path === 'MEMORY.md')
  expect(reads).toHaveLength(1)
  expect(reads[0]![0]).toMatchObject({ path: 'MEMORY.md', expectedResource: { hostId: scratchWorkspace.hostId, workspaceId: SCRATCH_WORKSPACE_ID, workspacePath: scratchWorkspace.path } })
  expect(memory.textContent).toContain('Give me a concrete next step.')
  expect(memory.querySelector('[data-memory-revision]')?.textContent).toBe(revision)
  expect(memory.querySelector('[aria-label="Correct or remove a memory detail in editor"]')).not.toBeNull()
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('returns to each original home and Ideas reading position with its unsent inputs intact', async () => {
  await app.mount(); await moteClick(button('Profile'))
  const profile = node<HTMLElement>('[aria-label="Mote profile"]')
  await type('[aria-label="A question for this Mote"]', 'Keep our question beside the original work.')
  await act(async () => { profile.scrollTop = 144; profile.dispatchEvent(new Event('scroll')) })
  await moteClick(button('Ideas'))
  const ideas = node<HTMLElement>('[aria-label="Mote ideas"]')
  expect(ideas.scrollTop).toBe(0)
  await moteClick(node('.mote-details__ideas .mote-details__note'))
  await type('[aria-label="Idea direction"]', 'Compare one exact source.')
  await type('[aria-label="Idea feedback comment"]', 'Retain the unsent source feedback.')
  await act(async () => { ideas.scrollTop = 312; ideas.dispatchEvent(new Event('scroll')) })
  await moteClick(button('Profile'))
  expect(node<HTMLElement>('[aria-label="Mote profile"]').scrollTop).toBe(144)
  expect(node<HTMLTextAreaElement>('[aria-label="A question for this Mote"]').value).toBe('Keep our question beside the original work.')
  await moteClick(button('Calendar')); await moteClick(button('Ideas'))
  expect(node<HTMLElement>('[aria-label="Mote ideas"]').scrollTop).toBe(312)
  expect(node<HTMLTextAreaElement>('[aria-label="Idea direction"]').value).toBe('Compare one exact source.')
  expect(node<HTMLTextAreaElement>('[aria-label="Idea feedback comment"]').value).toBe('Retain the unsent source feedback.')
  expect(node('.mote-details__preview').textContent).toContain('Keep the source and its decisions.')
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('keeps the original private-chat draft and manual question through Ideas and Calendar navigation', async () => {
  const chatRead = vi.spyOn(api.moteChat, 'call').mockResolvedValue({ configuration: null, operation: null })
  await app.mount(); await moteClick(button('Profile')); await settleMoteApp()
  const chat = node('[data-mote-private-chat]'), interval = node<HTMLInputElement>('[aria-label="Conversation update interval in minutes"]')
  expect(chat.closest('.mote-profile__preferences')).toBeNull()
  const target = chatRead.mock.calls.find(([method]) => method === 'space.mote.chat.inspect')![1]
  const before = useAppStore.getState()
  await type('[aria-label="A question for this Mote"]', 'Keep this new-discussion question unsent.')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(interval, '47')
    interval.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await moteClick(button('Ideas')); await moteClick(button('Calendar')); await moteClick(button('Profile'))
  expect(node('[data-mote-private-chat]')).toBe(chat)
  expect(node<HTMLInputElement>('[aria-label="Conversation update interval in minutes"]')).toBe(interval)
  expect(interval.value).toBe('47')
  expect(node<HTMLTextAreaElement>('[aria-label="A question for this Mote"]').value).toBe('Keep this new-discussion question unsent.')
  expect(chatRead.mock.calls.length).toBeGreaterThan(0)
  for (const [method, input] of chatRead.mock.calls) { expect(method).toBe('space.mote.chat.inspect'); expect(input).toEqual(target) }
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().moteChatIntents).toEqual(before.moteChatIntents)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('reads a changed original idea once when returning from Profile and retains it on ordinary mode switches', async () => {
  await app.mount(); await moteClick(button('Ideas'))
  await moteClick(node('.mote-details__ideas .mote-details__note'))
  const ideaReads = () => vi.mocked(api.files.readPublic).mock.calls.filter(([params]) => params.path === 'experiment.md').length
  const before = ideaReads()
  expect(node('.mote-details__preview').textContent).toContain('Keep the source and its decisions.')
  await moteClick(button('Profile'))
  vi.mocked(api.files.readPublic).mockImplementation(async params => {
    const result = material(params)
    if (params.path === 'experiment.md' && result.result.status === 'read') result.result.document.content = 'The original source has a new decision.'
    return result
  })
  await act(async () => useAppStore.setState(state => ({ workspaceFileRevisions: {
    ...state.workspaceFileRevisions, [SCRATCH_WORKSPACE_ID]: (state.workspaceFileRevisions[SCRATCH_WORKSPACE_ID] ?? 0) + 1
  } })))
  expect(ideaReads()).toBe(before)
  await moteClick(button('Ideas'))
  expect(ideaReads()).toBe(before + 1)
  expect(node('.mote-details__preview').textContent).toContain('The original source has a new decision.')
  await moteClick(button('Profile')); await moteClick(button('Ideas'))
  expect(ideaReads()).toBe(before + 1)
})

const homeExpanded = () => app.container.querySelector('[data-surface-tool-dock][data-content-expanded="true"]')
const originalComposer = () => node<HTMLElement>('.workspace-workbench-slot[data-workspace-id="' + SCRATCH_WORKSPACE_ID + '"] .workbench-tab-slot[data-workbench-tab-id="' + defaultTab.id + '"] [aria-label="Message Agent"]')
async function openHome() {
  await moteClick(node<HTMLButtonElement>('[data-space-nav="topic:' + PMO_TEAMS_TOPIC_ID + '"]'))
  expect(homeExpanded()).not.toBeNull()
}

it('opens the companion home from the actual directory and returns to the same original discussion and Composer', async () => {
  useAppStore.setState({ projectRailOpen: true })
  await app.mount()
  const input = originalComposer()
  await moteType(input, 'Keep this exact original conversation draft.')
  const before = useAppStore.getState()
  await openHome()
  const workface = input.closest<HTMLElement>('.workspace-main-surface')!
  expect(workface).not.toBeNull()
  expect(workface.hasAttribute('inert')).toBe(true)
  expect(workface.getAttribute('aria-hidden')).toBe('true')
  expect(originalComposer()).toBe(input)
  const covered = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'companion-covered-observation', operation: 'inspect.client' })
  expect(covered.operation).toBe('inspect.client')
  if (covered.operation !== 'inspect.client') throw new Error('Wrong original observation')
  expect(desktopWorkbenchObservationSchema.parse(covered.observation).desktop.presentation).toMatchObject({ state: 'covered', blockers: [] })
  await moteClick(button('Discussion'))
  expect(homeExpanded()).toBeNull()
  const revealed = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'companion-revealed-observation', operation: 'inspect.client' })
  expect(revealed.operation).toBe('inspect.client')
  if (revealed.operation !== 'inspect.client') throw new Error('Wrong original observation')
  expect(desktopWorkbenchObservationSchema.parse(revealed.observation).desktop.presentation.state).not.toBe('covered')
  expect(workface.hasAttribute('inert')).toBe(false)
  expect(originalComposer()).toBe(input)
  expect(input.textContent).toContain('Keep this exact original conversation draft.')
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: defaultTab.id, regionId: 'default-region' })
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('lets an explicit public focus of the same original address reveal the existing workface', async () => {
  useAppStore.setState({ projectRailOpen: true })
  await app.mount(); const input = originalComposer()
  await openHome()
  const choice = useAppStore.getState().workbenchSpaceSelection!
  expect(choice.tabId).toBe(defaultTab.id)
  let result: unknown
  await act(async () => { result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'companion-same-original-focus', operation: 'focus',
    target: { kind: 'space', spaceId: choice.spaceId!, zoneId: choice.zoneId!, tabId: choice.tabId!, regionId: choice.regionId!, displayWorkspaceId: choice.workspaceId, groupId: choice.groupId! }, inputPolicy: 'preserve' }) })
  await settleMoteApp()
  expect(result).toBeDefined()
  expect(homeExpanded()).toBeNull()
  expect(originalComposer()).toBe(input)
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('prepares a home question in one original Launcher and reveals it without submitting or replacing existing work', async () => {
  useAppStore.setState({ projectRailOpen: true })
  await app.mount(); await openHome()
  await type('[aria-label="A question for this Mote"]', 'Prepare our next decision with the original source.')
  const before = useAppStore.getState()
  await moteClick(button('Prepare this question in a new discussion'))
  const current = useAppStore.getState(), created = Object.values(current.tabs).filter(tab => !before.tabs[tab.id])
  expect(created).toHaveLength(1)
  const launcher = created[0]!
  expect(launcher.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(Object.values(launcher.regions).map(region => region.kind)).toEqual(['launcher'])
  expect(current.agentComposerDrafts[launcher.layout.activeRegionId]).toBe('Prepare our next decision with the original source.')
  expect(current.agentComposerNotes[launcher.layout.activeRegionId]).toContain(revision)
  expect(homeExpanded()).toBeNull()
  expect(current.sessions).toBe(before.sessions)
  expect(current.tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id])
  expect(current.agentComposerDrafts[defaultAgent.id]).toBe(before.agentComposerDrafts[defaultAgent.id])
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('reveals retained unplaced original members without inventing a selected Agent or physical Group', async () => {
  useAppStore.setState({ projectRailOpen: true, activeWorkspaceId: 'project', workbenchSpaceSelection: null,
    retainedSpatialFocus: null, spaceZoneBindings: {}, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [customTab.id]), project: createWorkspaceLayout('project-group') } })
  const before = useAppStore.getState()
  await app.mount(); await openHome()
  expect(app.container.querySelector('[data-mote-details] [aria-label="Continue discussion"]')).toBeNull()
  await moteClick(button('Discussion'))
  expect(homeExpanded()).toBeNull()
  const main = node<HTMLElement>('.workspace-workbench-slot[data-workspace-id="' + SCRATCH_WORKSPACE_ID + '"]')
  expect(main.querySelector('button[data-workbench-tab-id="' + defaultTab.id + '"]')).not.toBeNull()
  expect(main.querySelector('button[data-workbench-tab-id="' + neighborTab.id + '"]')).not.toBeNull()
  expect(main.textContent).not.toContain('This original entity has no confirmed display occurrence here')
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

function confirmOriginalHome() {
  const topics = moteTopics.map(topic => topic.id === PMO_TEAMS_TOPIC_ID ? { ...topic, physicalDirectoryPath: topic.directoryPath, confirmedDirectoryPaths: [topic.directoryPath] } : topic)
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  useAppStore.setState(state => ({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
    [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics } } }))
}
const arrangement = (id: string, offset: number, status: ContinuousProgressLoop['status'] = 'active'): ContinuousProgressLoop => ({
  hostId: defaultAgent.hostId, providerId: defaultAgent.providerId, agentSessionId: defaultAgent.control.agentSessionId,
  workspacePath: defaultAgent.workspacePath, loopId: id, status, revision: 1, creationOperationId: 'saved-' + id,
  futureIntentId: 'intent-' + id, afterMs: 60000, intervalMs: 1000, nextCheckAt: Date.now() + offset,
  prompt: 'Original arrangement ' + id
})

it('shows a bounded reading of original arrangements and opens the selected row in the existing Calendar', async () => {
  confirmOriginalHome()
  const saved = [arrangement('later', 40000), arrangement('ended', 1, 'stopped'), arrangement('next', 20000), arrangement('first', 10000), arrangement('third', 30000)]
  vi.mocked(api.schedule.list).mockImplementation(async params => ({ schedules: params.scope ? saved : saved.filter(record => record.agentSessionId === params.target?.agentSessionId), executionScope: 'connected-host' }))
  const listeners = new Set<(value: ContinuousProgressLoop) => void>()
  vi.mocked(api.schedule.onChanged).mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  await app.mount(); await moteClick(button('Profile'))
  expect(vi.mocked(api.schedule.list).mock.calls.filter(([params]) => params.scope).map(([params]) => params)).toEqual([{ scope: { hostId: defaultAgent.hostId, workspacePath: defaultAgent.workspacePath } }])
  const upcoming = node('[aria-label="Next arrangements"]')
  expect([...upcoming.querySelectorAll('[data-upcoming-id]')].map(row => row.getAttribute('data-upcoming-id'))).toEqual(['first', 'next', 'third'])
  const visibleConsumers = listeners.size
  expect(visibleConsumers).toBeGreaterThan(0)
  const drafts = useAppStore.getState().agentComposerDrafts
  await moteClick(button('Ideas'))
  expect(listeners.size).toBe(visibleConsumers - 1)
  const reads = vi.mocked(api.schedule.list).mock.calls.filter(([params]) => params.scope).length
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, updatedAt: session.updatedAt + 1 })) })))
  await settleMoteApp(); expect(vi.mocked(api.schedule.list).mock.calls.filter(([params]) => params.scope)).toHaveLength(reads)
  await moteClick(button('Profile'))
  expect(listeners.size).toBe(visibleConsumers)
  await moteClick(node('[data-upcoming-id="next"]'))
  expect(button('Calendar').getAttribute('aria-selected')).toBe('true')
  await vi.waitFor(() => expect(node<HTMLDetailsElement>('.mote-calendar [data-schedule-id="next"] details').open).toBe(true))
  await moteClick(button('Profile'))
  await moteClick(node('[data-upcoming-id="third"]'))
  expect(node<HTMLDetailsElement>('.mote-calendar [data-schedule-id="third"] details').open).toBe(true)
  expect(document.activeElement).toBe(node('.mote-calendar [data-schedule-id="third"] summary'))
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('keeps confirmed upcoming rows and independent work available when the original read fails, then recovers on the same scope', async () => {
  confirmOriginalHome()
  vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [arrangement('retained', 10000)], executionScope: 'connected-host' })
  await app.mount(); await moteClick(button('Profile'))
  const original = node('[data-upcoming-id="retained"]')
  await moteClick(button('Ideas'))
  vi.mocked(api.schedule.list).mockRejectedValueOnce(new Error('Original arrangement observation unavailable.'))
  await moteClick(button('Profile'))
  expect(node('[aria-label="Next arrangements"]').textContent).toContain('Original arrangement observation unavailable.')
  expect(node('[data-upcoming-id="retained"]')).toBe(original)
  const question = node<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')
  expect(question.disabled).toBe(false)
  await type('[aria-label="A question for this Mote"]', 'Work continues while arrangements recover.')
  await moteClick(button('Retry arrangements'))
  expect(node('[aria-label="Next arrangements"]').textContent).not.toContain('Original arrangement observation unavailable.')
  expect(node('[data-upcoming-id="retained"]')).toBe(original)
  expect(question.value).toBe('Work continues while arrangements recover.')
  expect(vi.mocked(api.schedule.list).mock.calls.filter(([params]) => params.scope).map(([params]) => params)).toEqual(Array.from({ length: 3 }, () => ({ scope: { hostId: defaultAgent.hostId, workspacePath: defaultAgent.workspacePath } })))
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('keeps the original on-open recovery eligible while its companion home covers the retained conversation', async () => {
  const cleanup = beginMoteStartupRecovery()
  try {
    const reference = { hostId: customAgent.hostId, sessionId: customAgent.id, displayWorkspaceId: SCRATCH_WORKSPACE_ID,
      groupId: 'mote-group', tabId: customTab.id, regionId: 'custom-region' }
    const topics = moteTopics.map(topic => topic.id === customMoteId ? { ...topic,
      quickMode: { status: 'saved' as const, version: 'confirmed-original', defaults: { conversation: reference, recovery: 'on-open' as const } } } : topic)
    vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
    vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
    useAppStore.setState(state => ({ projectRailOpen: true, sessions: state.sessions.map(session => session.id === customAgent.id ? { ...customAgent, processState: 'exited' as const } : session),
      scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics } } }))
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'reattachable', session: customAgent })
    const before = useAppStore.getState()
    await app.mount()
    expect(recover).not.toHaveBeenCalled()
    await moteClick(node<HTMLButtonElement>('[data-space-nav="topic:' + customMoteId + '"]'))
    expect(homeExpanded()).not.toBeNull()
    expect(recover).toHaveBeenCalledExactlyOnceWith(customAgent.control, customAgent.workspacePath, expect.any(String), { trigger: 'mote-open', timingOverride: 'on-open' })
    await moteClick(button('Discussion'))
    expect(homeExpanded()).toBeNull()
    expect(recover).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions.find(session => session.id === customAgent.id)?.control).toEqual(customAgent.control)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  } finally { cleanup() }
})

it('does not let a late original file opening collapse a subsequently reopened companion home', async () => {
  useAppStore.setState({ projectRailOpen: true })
  let finish!: () => void
  const read = vi.spyOn(api.files, 'read').mockImplementation((_workspace, path) => new Promise(resolve => {
    finish = () => resolve({ status: 'read', document: { path, content: '# Original file retained', revision } })
  }))
  await app.mount(); await openHome()
  await moteClick(button('Ideas')); await moteClick(node('.mote-details__ideas .mote-details__note'))
  await moteClick(button('Open file'))
  expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, rootPath + '/experiment.md')
  expect(finish).toBeTypeOf('function')
  await openHome()
  const reopened = homeExpanded(), drafts = useAppStore.getState().agentComposerDrafts
  await act(async () => finish()); await settleMoteApp()
  expect(homeExpanded()).toBe(reopened)
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it.each([false, true])('reveals a newly saved home arrangement after the existing Calendar refreshes, unless later input owns focus (%s)', async cancelReveal => {
  confirmOriginalHome()
  const previous = arrangement('previous', 20000), added = arrangement('newly-saved', 10000)
  let records = [previous], finish!: () => void, holdScope = false
  vi.mocked(api.schedule.list).mockImplementation(params => {
    if (!params.scope) return Promise.resolve({ schedules: records.filter(record => record.agentSessionId === params.target?.agentSessionId), executionScope: 'connected-host' })
    if (holdScope) return new Promise(resolve => { finish = () => resolve({ schedules: records, executionScope: 'connected-host' }) })
    return Promise.resolve({ schedules: records, executionScope: 'connected-host' })
  })
  await app.mount(); await moteClick(button('Calendar'))
  await moteClick(button('Upcoming'))
  expect(node('.mote-calendar [data-schedule-id="previous"]')).not.toBeNull()
  await moteClick(button('New arrangement'))
  expect(node<HTMLDetailsElement>('.mote-calendar .schedule-create').open).toBe(true)
  records = [added, previous]
  await moteClick(button('Profile'))
  expect(node('[data-upcoming-id="newly-saved"]')).not.toBeNull()
  holdScope = true
  await moteClick(node('[data-upcoming-id="newly-saved"]'))
  expect(finish).toBeTypeOf('function')
  expect(app.container.querySelector('.mote-calendar [data-schedule-id="newly-saved"]')).toBeNull()
  const input = node<HTMLTextAreaElement>('.mote-calendar [aria-label="Arranged message"]')
  if (cancelReveal) await act(async () => {
    input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep this later arrangement thought.')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => finish()); await settleMoteApp()
  const row = node<HTMLDetailsElement>('.mote-calendar [data-schedule-id="newly-saved"] details')
  expect(row.open).toBe(!cancelReveal)
  expect(document.activeElement).toBe(cancelReveal ? input : row.querySelector('summary'))
  if (cancelReveal) expect(input.value).toBe('Keep this later arrangement thought.')
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})


it('keeps one shared navigation and question lifecycle across Profile and Discussion without replacing the original workface', async () => {
  useAppStore.setState({ projectRailOpen: true })
  await app.mount(); await openHome()
  const navigation = node('[aria-label="Mote pages"]')
  const question = node<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')
  const composer = originalComposer()
  await type('[aria-label="A question for this Mote"]', 'A new question, kept separately from the current discussion.')
  const before = useAppStore.getState()
  const reads = vi.mocked(api.files.readPublic).mock.calls.length
  for (const mode of ['Discussion', 'Profile', 'Ideas', 'Calendar', 'Profile', 'Discussion']) {
    await moteClick(button(mode))
    expect(node('[aria-label="Mote pages"]')).toBe(navigation)
    expect(node<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')).toBe(question)
    expect(button(mode).getAttribute('aria-selected')).toBe('true')
    expect(originalComposer()).toBe(composer)
  }
  expect(question.value).toBe('A new question, kept separately from the current discussion.')
  expect(vi.mocked(api.files.readPublic).mock.calls).toHaveLength(reads)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('retains the original pending question across local page switches and prepares it only once', async () => {
  useAppStore.setState({ projectRailOpen: true })
  await app.mount(); await openHome()
  await type('[aria-label="A question for this Mote"]', 'Hold this one original preparation.')
  const replies: (() => void)[] = []
  vi.mocked(api.files.readPublic).mockImplementation(params => new Promise(resolve => replies.push(() => resolve(material(params)))))
  const before = useAppStore.getState()
  await moteClick(button('Prepare this question in a new discussion'))
  expect(replies).toHaveLength(2)
  await moteClick(button('Discussion')); await moteClick(button('Profile'))
  expect(button('Reading original materials').disabled).toBe(true)
  expect(replies).toHaveLength(2)
  vi.mocked(api.files.readPublic).mockImplementation(async params => material(params))
  await act(async () => replies.forEach(reply => reply())); await settleMoteApp()
  const created = Object.values(useAppStore.getState().tabs).filter(tab => !before.tabs[tab.id])
  expect(created).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts[created[0]!.layout.activeRegionId]).toBe('Hold this one original preparation.')
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id])
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('lists recent original discussions and opens the exact selected Tab without creating another conversation', async () => {
  useAppStore.setState({ projectRailOpen: true })
  await app.mount(); await openHome()
  const recent = node('[aria-label="Recent discussions"]')
  expect(recent.querySelector('[data-mote-discussion="' + defaultTab.id + '"]')).not.toBeNull()
  const chosen = recent.querySelector<HTMLButtonElement>('[data-mote-discussion="' + neighborTab.id + '"]')!
  expect(chosen).not.toBeNull()
  const before = useAppStore.getState()
  await moteClick(chosen)
  expect(button('Discussion').getAttribute('aria-selected')).toBe('true')
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: neighborTab.id, groupId: 'mote-group', regionId: neighborTab.layout.activeRegionId })
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
