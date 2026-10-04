// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, useEffect } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../src/renderer/src/App'
import type { FileOpenResult } from '../src/renderer/src/lib/file-workbench-state'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { addWorkbenchRegion, createWorkbenchTab, documentKey, fileTabId, workbenchSurfaces } from '../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose, readPmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { defaultAgent, defaultTab, neighborAgent, neighborTab, moteTopics, seedMoteWorkface, installNativePopover } from './fixtures/mote-workface'

vi.mock('react-resizable-panels', () => createRequire(import.meta.url)(
  '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))

const terminal = vi.hoisted(() => ({ mounts: 0 }))
// Native PTY painting and Monaco are the two host boundaries. App, navigation
// callbacks, SessionPane, Markdown, File opening and the local owners stay real.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => {
  useEffect(() => { terminal.mounts++ }, [])
  return <textarea aria-label="Retained terminal" />
} }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: ({ surface }: { surface: { workspaceId: string; path: string } }) => {
  const document = useAppStore(state => state.documents[documentKey(surface.workspaceId, surface.path)])
  return <pre data-file-content>{document?.content}</pre>
} }))

const baseline = useAppStore.getState()
const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: defaultTab.id, regionId: 'default-region' }
let root: Root, container: HTMLDivElement, restorePopover: () => void
let read: ReturnType<typeof vi.spyOn>
let receipts: FileOpenResult[]
let sourceBody: string
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  localStorage.clear(); terminal.mounts = 0; sourceBody = 'Read notes.txt:2:3.'; restorePopover = installNativePopover()
  useAppStore.setState(baseline, true); seedMoteWorkface()
  const work = createWorkbenchTab('original-work-tab', { kind: 'launcher', workspaceId: 'project', regionId: 'original-work-region' })
  useAppStore.setState(state => ({ loading: false, initialize: async () => () => {},
    tabs: { ...state.tabs, [work.id]: work }, layouts: { ...state.layouts, project: createWorkspaceLayout('work-group', [work.id]) },
    viewModes: { [defaultAgent.id]: 'activity' }, mainSurface: 'board',
    workbenchSpaceSelection: { workspaceId: 'project', groupId: 'work-group', tabId: work.id, regionId: 'original-work-region' },
    timelines: {},
    documents: {}, documentIssues: {}, documentRevealTargets: {}, dirtyDocuments: {}, error: null,
    prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}) }))
  // Observe the real Store receipt without replacing its read, reducer or
  // selection decisions; the original helper still consumes that same receipt.
  receipts = []
  const realOpenFile = useAppStore.getState().openFile
  vi.spyOn(useAppStore.getState(), 'openFile').mockImplementation((...args) => {
    const placement = args[5]
    if (placement?.onResult) {
      const consume = placement.onResult
      args[5] = { ...placement, onResult: result => { receipts.push(result); consume(result) } }
    }
    return realOpenFile(...args)
  })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => moteTopics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'fixture', nativeSessionId: 'original-native' },
    items: control.agentSessionId === defaultAgent.id ? [{ id: 'original-native-response', kind: 'assistant-message', phase: 'final',
      contentParts: [{ kind: 'text', text: sourceBody }] }] : [], nextCursor: null }))
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: {
    path, content: 'ORIGINAL RESOURCE FILE', revision: 'original-file-revision' } }))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); restorePopover()
  useAppStore.setState(baseline, true); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }) }
async function mount(surface: 'survey' | 'mote', selectedRegionId = reference.regionId) {
  const state = useAppStore.getState(), catalog = spatialCatalog(state, moteTopics)
  const zoneId = catalog.tabs.find(tab => tab.tabId === defaultTab.id)!.zoneId
  state.setSurveyZoneSelection({ zoneId, selection: [{ tabId: defaultTab.id, regionId: selectedRegionId }],
    active: { tabId: defaultTab.id, regionId: selectedRegionId } })
  await act(async () => {
    requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, reference: { ...reference, regionId: selectedRegionId } })
    useAppStore.setState({ mainSurface: surface === 'survey' ? 'survey' : 'board' })
    root.render(<App />)
  })
  await settle()
}
function localHost(surface: 'survey' | 'mote') {
  const host = container.querySelector<HTMLElement>(surface === 'mote' ? '[data-pmo-teams-topic-floating]' : '.global-survey-surface')
  expect(host).not.toBeNull(); return host!
}
function fileLink(surface: 'survey' | 'mote', path = 'notes.txt') {
  const links = localHost(surface).querySelectorAll<HTMLButtonElement>('button.md-link--file')
  expect(links).toHaveLength(1); expect(links[0]!.textContent).toContain(path)
  if (surface === 'survey') expect(links[0]!.closest('[data-pmo-teams-topic-floating]')).toBeNull()
  return links[0]!
}
function snapshot() {
  const state = useAppStore.getState()
  return { work: state.workbenchSpaceSelection, workspace: state.activeWorkspaceId, main: state.mainSurface,
    layouts: state.layouts, sessions: state.sessions, drafts: state.agentComposerDrafts,
    source: state.tabs[defaultTab.id]!.regions[reference.regionId], tabActive: state.tabs[defaultTab.id]!.layout.activeRegionId,
    survey: state.surveyZoneSelection, mote: readPmoTeamsTopicFloatingState() }
}
function openedFile() {
  const surfaces = workbenchSurfaces(useAppStore.getState().tabs[defaultTab.id]!).filter(surface => surface.kind === 'file')
  expect(surfaces).toHaveLength(1); expect(surfaces[0]).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, path: 'notes.txt' })
  expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, 'notes.txt')]?.content).toBe('ORIGINAL RESOURCE FILE')
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ placement: { status: 'created', tabId: defaultTab.id, regionId: surfaces[0]!.regionId }, data: { kind: 'text' } })
  return surfaces[0]!
}
function expectRetained(before: ReturnType<typeof snapshot>, fileRead = true, path = 'notes.txt') {
  const after = snapshot()
  for (const key of ['work', 'workspace', 'main', 'layouts', 'sessions', 'drafts', 'source', 'tabActive'] as const) expect(after[key]).toEqual(before[key])
  expect(after.sessions.find(session => session.id === defaultAgent.id)?.control).toBe(defaultAgent.control)
  expect(useAppStore.getState().tabs[neighborTab.id]).toBe(neighborTab)
  if (fileRead) expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path)
  else expect(read).not.toHaveBeenCalled()
}

it.each(['survey', 'mote'] as const)('%s Markdown File link splits its exact local Tab and selects locally without changing Work', async surface => {
  await mount(surface)
  const before = snapshot()
  await act(async () => fileLink(surface).click()); await settle()
  const file = openedFile(); expectRetained(before)
  if (surface === 'survey') {
    expect(useAppStore.getState().surveyZoneSelection?.active).toEqual({ tabId: defaultTab.id, regionId: file.regionId })
    expect(readPmoTeamsTopicFloatingState()).toEqual(before.mote)
  } else {
    expect(readPmoTeamsTopicFloatingState()?.reference).toEqual({ ...reference, regionId: file.regionId })
    expect(useAppStore.getState().surveyZoneSelection).toEqual(before.survey)
  }
  await vi.waitFor(() => expect(localHost(surface).querySelector('[data-file-content]')?.textContent).toBe('ORIGINAL RESOURCE FILE'))
})

it.each(['survey', 'mote'] as const)('%s delayed File completion keeps a later local selection, including returning to the original occurrence', async surface => {
  let complete!: (value: unknown) => void
  read.mockImplementation((_workspace, path) => new Promise(resolve => { complete = resolve }))
  await mount(surface); const before = snapshot()
  await act(async () => fileLink(surface).click())
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  await act(async () => {
    if (surface === 'survey') {
      const selection = useAppStore.getState().surveyZoneSelection!
      useAppStore.getState().setSurveyZoneSelection({ ...selection, active: { tabId: neighborTab.id, regionId: 'neighbor-region' } })
      useAppStore.getState().setSurveyZoneSelection(selection)
    } else {
      requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID,
        reference: { ...reference, tabId: neighborTab.id, regionId: 'neighbor-region' } })
      requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, reference })
    }
    complete({ status: 'read', document: { path: 'notes.txt', content: 'ORIGINAL RESOURCE FILE', revision: 'original-file-revision' } })
  })
  await settle(); openedFile(); expectRetained(before)
  expect(useAppStore.getState().surveyZoneSelection).toEqual(before.survey)
  expect(readPmoTeamsTopicFloatingState()?.reference).toEqual(reference)
})


it.each(['survey', 'mote'] as const)('%s explicit File Tab choice hands off to Work once and retains both local selections', async surface => {
  await mount(surface); const before = snapshot()
  await act(async () => fileLink(surface).dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })))
  const destination = document.querySelectorAll<HTMLButtonElement>('[aria-label="Open in a new tab"]')
  expect(destination).toHaveLength(1)
  expect(read).not.toHaveBeenCalled()
  const choiceKey = (choice: typeof before.work) => JSON.stringify(choice && [choice.workspaceId, choice.groupId, choice.tabId, choice.regionId, choice.spaceId, choice.zoneId, choice.topicId])
  const choices: string[] = []
  const unsubscribe = useAppStore.subscribe(state => {
    const value = choiceKey(state.workbenchSpaceSelection)
    if (value !== choiceKey(before.work) && choices.at(-1) !== value) choices.push(value)
  })
  try {
    await act(async () => destination[0]!.click()); await settle()
    const state = useAppStore.getState(), id = fileTabId(SCRATCH_WORKSPACE_ID, 'notes.txt'), tab = state.tabs[id]
    expect(tab).toBeDefined()
    expect(state.mainSurface).toBe('workbench')
    expect(state.workbenchSpaceSelection).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, tabId: id, regionId: tab!.layout.activeRegionId })
    expect(choices).toHaveLength(1)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ placement: { status: 'created', tabId: id, regionId: tab!.layout.activeRegionId }, data: { kind: 'text' }, navigation: 'applied' })
    expect(state.surveyZoneSelection).toEqual(before.survey)
    expect(readPmoTeamsTopicFloatingState()?.reference).toEqual(reference)
    expect(state.tabs[defaultTab.id]).toBe(defaultTab)
    expect(state.sessions).toEqual(before.sessions); expect(state.agentComposerDrafts).toEqual(before.drafts)
    expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, 'notes.txt')
  } finally { unsubscribe() }
})


it.each([['survey', false], ['mote', false], ['survey', true], ['mote', true]] as const)('%s File click in an unselected Agent Region uses that Region in the exact parent occurrence (cached=%s)', async (surface, cached) => {
  const peerRegion = 'same-tab-peer'
  const mixed = addWorkbenchRegion(defaultTab, reference.regionId, 'right', { kind: 'agent', phase: 'attached',
    workspaceId: SCRATCH_WORKSPACE_ID, sessionId: neighborAgent.id, regionId: peerRegion })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [mixed.id]: mixed },
    ...(cached ? { documents: { [documentKey(SCRATCH_WORKSPACE_ID, 'notes.txt')]: { path: 'notes.txt', content: 'ORIGINAL RESOURCE FILE', revision: 'cached-revision' } } } : {}),
    viewModes: { ...state.viewModes, [neighborAgent.id]: 'activity' } }))
  await mount(surface, peerRegion); const before = snapshot()
  expect(before.tabActive).toBe(peerRegion)
  await act(async () => fileLink(surface).click()); await settle()
  const file = openedFile(); expectRetained(before, !cached)
  expect(useAppStore.getState().tabs[mixed.id]!.regions[peerRegion]).toBe(mixed.regions[peerRegion])
  if (surface === 'survey') {
    expect(useAppStore.getState().surveyZoneSelection?.active).toEqual({ tabId: defaultTab.id, regionId: file.regionId })
    expect(readPmoTeamsTopicFloatingState()).toEqual(before.mote)
  } else {
    expect(readPmoTeamsTopicFloatingState()?.reference).toEqual({ ...reference, regionId: file.regionId })
    expect(useAppStore.getState().surveyZoneSelection).toEqual(before.survey)
  }
})

it.each(['survey', 'mote'] as const)('%s late explicit File Tab result keeps the file without overriding later local navigation', async surface => {
  let complete!: (value: unknown) => void
  read.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await mount(surface); const before = snapshot()
  await act(async () => fileLink(surface).dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })))
  const destination = document.querySelectorAll<HTMLButtonElement>('[aria-label="Open in a new tab"]')
  expect(destination).toHaveLength(1)
  await act(async () => destination[0]!.click())
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  await act(async () => {
    if (surface === 'survey') {
      const selection = useAppStore.getState().surveyZoneSelection!
      useAppStore.getState().setSurveyZoneSelection({ ...selection, active: { tabId: neighborTab.id, regionId: 'neighbor-region' } })
      useAppStore.getState().setSurveyZoneSelection(selection)
    } else {
      requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID,
        reference: { ...reference, tabId: neighborTab.id, regionId: 'neighbor-region' } })
      requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, reference })
    }
    complete({ status: 'read', document: { path: 'notes.txt', content: 'ORIGINAL RESOURCE FILE', revision: 'original-file-revision' } })
  })
  await settle()
  const state = useAppStore.getState(), id = fileTabId(SCRATCH_WORKSPACE_ID, 'notes.txt')
  expect(state.documents[documentKey(SCRATCH_WORKSPACE_ID, 'notes.txt')]?.content).toBe('ORIGINAL RESOURCE FILE')
  expect(state.tabs[id]).toBeDefined()
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ placement: { status: 'created', tabId: id }, data: { kind: 'text' }, navigation: 'cancelled' })
  expect(state.workbenchSpaceSelection).toEqual(before.work)
  expect(state.mainSurface).toBe(before.main); expect(state.activeWorkspaceId).toBe(before.workspace)
  expect(state.tabs[defaultTab.id]).toBe(defaultTab)
  expect(state.layouts[SCRATCH_WORKSPACE_ID]!.activeGroupId).toBe(before.layouts[SCRATCH_WORKSPACE_ID]!.activeGroupId)
  expect(state.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => [group.id, group.activeTabId])).toEqual(
    before.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => [group.id, group.activeTabId]))
  expect(state.surveyZoneSelection).toEqual(before.survey)
  expect(readPmoTeamsTopicFloatingState()?.reference).toEqual(reference)
  expect(state.sessions).toEqual(before.sessions); expect(state.agentComposerDrafts).toEqual(before.drafts)
})


it.each(['survey', 'mote'] as const)('%s HTTP click in an unselected Agent Region selects its new Browser locally through the current parent callback', async surface => {
  const url = 'https://navigation.example/original'
  sourceBody = '[Inspect original page](' + url + ')'
  const peerRegion = 'same-tab-http-peer'
  const mixed = addWorkbenchRegion(defaultTab, reference.regionId, 'right', { kind: 'agent', phase: 'attached',
    workspaceId: SCRATCH_WORKSPACE_ID, sessionId: neighborAgent.id, regionId: peerRegion })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [mixed.id]: mixed },
    viewModes: { ...state.viewModes, [neighborAgent.id]: 'activity' } }))
  const create = vi.spyOn(api.browser, 'create')
  await mount(surface, peerRegion); const before = snapshot()
  const links = localHost(surface).querySelectorAll<HTMLButtonElement>('button.md-link[title="' + url + '"]')
  expect(links).toHaveLength(1)
  expect(links[0]!.closest('[hidden], [inert]')).toBeNull()
  await act(async () => links[0]!.click())
  const destinations = document.querySelectorAll<HTMLButtonElement>('[aria-label="Open in a split on the right"]')
  expect(destinations).toHaveLength(1)
  await act(async () => destinations[0]!.click()); await settle()
  const browsers = workbenchSurfaces(useAppStore.getState().tabs[mixed.id]!).filter(surface => surface.kind === 'browser')
  expect(browsers).toHaveLength(1)
  expect(browsers[0]).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, url })
  const after = snapshot()
  for (const key of ['work', 'workspace', 'main', 'layouts', 'sessions', 'drafts', 'source', 'tabActive'] as const) expect(after[key]).toEqual(before[key])
  expect(useAppStore.getState().tabs[mixed.id]!.regions[peerRegion]).toBe(mixed.regions[peerRegion])
  if (surface === 'survey') {
    expect(useAppStore.getState().surveyZoneSelection?.active).toEqual({ tabId: mixed.id, regionId: browsers[0]!.regionId })
    expect(readPmoTeamsTopicFloatingState()).toEqual(before.mote)
  } else {
    expect(readPmoTeamsTopicFloatingState()?.reference).toEqual({ ...reference, regionId: browsers[0]!.regionId })
    expect(useAppStore.getState().surveyZoneSelection).toEqual(before.survey)
  }
  expect(create).toHaveBeenCalledExactlyOnceWith(browsers[0]!.regionId, url, SCRATCH_WORKSPACE_ID)
  expect(read).not.toHaveBeenCalled(); expect(receipts).toEqual([])
})

it('Mote HTTP uses its own chooser while background Focus prefers Tab, then selects Browser locally', async () => {
  const url = 'https://navigation.example/mote-over-focus'
  sourceBody = '[Inspect Mote page](' + url + ')'
  await mount('mote')
  await act(async () => useAppStore.setState(state => ({ mainSurface: 'agents', config: { ...state.config!, focus: { linkDestination: 'tab' } } })))
  await settle()
  const before = snapshot(), create = vi.spyOn(api.browser, 'create')
  expect(before.main).toBe('agents')
  const links = localHost('mote').querySelectorAll<HTMLButtonElement>('button.md-link[title="' + url + '"]')
  expect(links).toHaveLength(1); expect(links[0]!.closest('[hidden], [inert]')).toBeNull()
  await act(async () => links[0]!.click())
  const destinations = document.querySelectorAll<HTMLButtonElement>('[aria-label="Open in a split on the right"]')
  expect(destinations).toHaveLength(1); expect(create).not.toHaveBeenCalled()
  await act(async () => destinations[0]!.click()); await settle()
  const browsers = workbenchSurfaces(useAppStore.getState().tabs[defaultTab.id]!).filter(surface => surface.kind === 'browser')
  expect(browsers).toHaveLength(1); expect(browsers[0]).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, url })
  expectRetained(before, false)
  expect(readPmoTeamsTopicFloatingState()?.reference).toEqual({ ...reference, regionId: browsers[0]!.regionId })
  expect(useAppStore.getState().surveyZoneSelection).toEqual(before.survey)
  expect(create).toHaveBeenCalledExactlyOnceWith(browsers[0]!.regionId, url, SCRATCH_WORKSPACE_ID)
})

it.each(['file', 'http'] as const)('the actual Mote secondary Activity consumes its shared %s link opener beside the original Work primary', async kind => {
  const url = 'https://navigation.example/secondary'
  if (kind === 'http') sourceBody = '[Inspect secondary page](' + url + ')'
  await mount('mote')
  await act(async () => {
    useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: SCRATCH_WORKSPACE_ID })
    expect(useAppStore.getState().selectMainRegion(reference)).toBe(true)
  })
  await settle()
  const before = snapshot(), create = vi.spyOn(api.browser, 'create')
  const links = localHost('mote').querySelectorAll<HTMLButtonElement>(kind === 'file' ? 'button.md-link--file' : 'button.md-link[title="' + url + '"]')
  expect(links).toHaveLength(1)
  expect(links[0]!.closest('[data-session-presentation]')).not.toBeNull()
  expect(links[0]!.closest('[hidden], [inert]')).toBeNull()
  const primary = container.querySelectorAll<HTMLElement>('[data-workbench-primary-tab-id="' + defaultTab.id + '"]')
  expect(primary).toHaveLength(1); expect(primary[0]!.closest('[data-pmo-teams-topic-floating]')).toBeNull()
  expect(primary[0]!.closest('[hidden], [inert]')).toBeNull()
  await act(async () => links[0]!.click())
  if (kind === 'http') {
    const destinations = document.querySelectorAll<HTMLButtonElement>('[aria-label="Open in a split on the right"]')
    expect(destinations).toHaveLength(1)
    await act(async () => destinations[0]!.click())
  }
  await settle()
  const opened = kind === 'file' ? openedFile() : workbenchSurfaces(useAppStore.getState().tabs[defaultTab.id]!).find(surface => surface.kind === 'browser')
  expect(opened).toBeDefined()
  if (kind === 'http') {
    expect(opened).toMatchObject({ kind: 'browser', workspaceId: SCRATCH_WORKSPACE_ID, url })
    expect(create).toHaveBeenCalledExactlyOnceWith(opened!.regionId, url, SCRATCH_WORKSPACE_ID)
  }
  expectRetained(before, kind === 'file')
  expect(readPmoTeamsTopicFloatingState()?.reference).toEqual({ ...reference, regionId: opened!.regionId })
  expect(useAppStore.getState().surveyZoneSelection).toEqual(before.survey)
})


it.each(['survey', 'mote'] as const)('%s bookmark File link opens its original URL as a local Browser and retains the exact source origin', async surface => {
  const path = 'original.url', url = 'https://navigation.example/bookmark'
  sourceBody = '[' + path + '](' + path + ')'
  const bookmark = vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url, binary: false })
  const create = vi.spyOn(api.browser, 'create')
  await mount(surface); const before = snapshot()
  await act(async () => fileLink(surface, path).click()); await settle()
  const browsers = workbenchSurfaces(useAppStore.getState().tabs[defaultTab.id]!).filter(surface => surface.kind === 'browser')
  expect(browsers).toHaveLength(1)
  expect(browsers[0]).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, url, bookmarkOrigin: { path, binary: false } })
  expectRetained(before, false)
  expect(useAppStore.getState().documents).toEqual({})
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ placement: { status: 'created', tabId: defaultTab.id, regionId: browsers[0]!.regionId }, data: { kind: 'not-file' } })
  if (surface === 'survey') {
    expect(useAppStore.getState().surveyZoneSelection?.active).toEqual({ tabId: defaultTab.id, regionId: browsers[0]!.regionId })
    expect(readPmoTeamsTopicFloatingState()).toEqual(before.mote)
  } else {
    expect(readPmoTeamsTopicFloatingState()?.reference).toEqual({ ...reference, regionId: browsers[0]!.regionId })
    expect(useAppStore.getState().surveyZoneSelection).toEqual(before.survey)
  }
  expect(bookmark).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path)
  expect(create).toHaveBeenCalledExactlyOnceWith(browsers[0]!.regionId, url, SCRATCH_WORKSPACE_ID)
})

it.each(['survey', 'mote'] as const)('%s a directory-shaped File result retains all navigation instead of jumping to the Work file tree', async surface => {
  const path = 'directory.txt'
  sourceBody = '[' + path + '](' + path + ')'
  read.mockResolvedValue({ status: 'directory' })
  const create = vi.spyOn(api.browser, 'create')
  await mount(surface); const before = snapshot(), tabs = useAppStore.getState().tabs
  const files = { toolsOpen: useAppStore.getState().toolsOpen, explorer: useAppStore.getState().fileExplorerStates }
  await act(async () => fileLink(surface, path).click()); await settle()
  const after = snapshot()
  for (const key of ['work', 'workspace', 'main', 'layouts', 'sessions', 'drafts', 'source', 'tabActive', 'survey', 'mote'] as const) expect(after[key]).toEqual(before[key])
  expect(useAppStore.getState().tabs).toBe(tabs)
  expect(useAppStore.getState().documents).toEqual({})
  expect({ toolsOpen: useAppStore.getState().toolsOpen, explorer: useAppStore.getState().fileExplorerStates }).toEqual(files)
  expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path)
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ placement: { status: 'none', tabId: null, regionId: null }, data: { kind: 'not-file' } })
  expect(create).not.toHaveBeenCalled()
})


it.each(['workbench', 'agents'] as const)('%s delayed bookmark Browser attach retains later Work navigation through A to B to A', async mainSurface => {
  const path = 'late-bookmark.url', url = 'https://navigation.example/late-bookmark'
  sourceBody = '[' + path + '](' + path + ')'
  vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url, binary: false })
  const mixed = addWorkbenchRegion(defaultTab, reference.regionId, 'right', { kind: 'launcher',
    workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'later-work-region' })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [mixed.id]: mixed }, mainSurface,
    activeWorkspaceId: SCRATCH_WORKSPACE_ID }))
  requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
  expect(useAppStore.getState().selectMainRegion(reference)).toBe(true)
  await act(async () => root.render(<App />)); await settle()
  const links = [...container.querySelectorAll<HTMLButtonElement>('button.md-link--file')].filter(link => !link.closest('[hidden], [inert]'))
  expect(links).toHaveLength(1); expect(links[0]!.textContent).toContain(path)
  let complete!: () => void
  const wait = new Promise<void>(resolve => { complete = resolve }), original = api.browser.create
  const create = vi.spyOn(api.browser, 'create').mockImplementation(async (...args) => { await wait; return original(...args) })
  await act(async () => links[0]!.click())
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  const before = snapshot()
  await act(async () => {
    expect(useAppStore.getState().selectMainRegion({ ...reference, regionId: 'later-work-region' })).toBe(true)
    expect(useAppStore.getState().selectMainRegion(reference)).toBe(true)
    complete()
  })
  await settle()
  const state = useAppStore.getState(), browsers = Object.values(state.tabs).flatMap(workbenchSurfaces).filter(surface => surface.kind === 'browser')
  expect(browsers).toHaveLength(1)
  expect(browsers[0]).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, url, bookmarkOrigin: { path, binary: false } })
  expect(state.workbenchSpaceSelection).toEqual(before.work)
  expect(state.mainSurface).toBe(mainSurface); expect(state.activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
  expect(state.tabs[mixed.id]!.layout.activeRegionId).toBe(before.tabActive)
  expect(state.sessions).toEqual(before.sessions); expect(state.agentComposerDrafts).toEqual(before.drafts)
  expect(state.tabs[mixed.id]!.regions[reference.regionId]).toBe(before.source)
  expect(state.documents).toEqual({}); expect(read).not.toHaveBeenCalled()
  // Ordinary Space's existing route has no receipt; Focus consumes the real
  // helper receipt, which must report attached data with cancelled navigation.
  if (mainSurface === 'agents') {
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ placement: { status: 'created', tabId: mixed.id, regionId: browsers[0]!.regionId }, data: { kind: 'not-file' }, navigation: 'cancelled' })
  }
})

it('ordinary bookmark opening retains the existing dirty canonical File and creates an independent Browser Tab', async () => {
  const path = 'dirty-bookmark.url', url = 'https://navigation.example/dirty-bookmark', key = documentKey(SCRATCH_WORKSPACE_ID, path)
  sourceBody = '[' + path + '](' + path + ')'
  vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url, binary: false })
  const id = fileTabId(SCRATCH_WORKSPACE_ID, path)
  const file = { ...createWorkbenchTab(id, { kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID, path, regionId: 'retained-dirty-file' }), topicId: PMO_TEAMS_TOPIC_ID }
  const draft = { path, content: 'Original unsaved bookmark source', revision: 'retained-revision' }
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [id]: file },
    layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [...Object.keys(state.tabs).filter(tabId => state.tabs[tabId]?.workspaceId === SCRATCH_WORKSPACE_ID), id]) },
    documents: { [key]: draft }, dirtyDocuments: { [key]: true }, documentGenerations: { [key]: 27 },
    mainSurface: 'workbench', activeWorkspaceId: SCRATCH_WORKSPACE_ID }))
  requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
  expect(useAppStore.getState().selectMainRegion(reference)).toBe(true)
  await act(async () => root.render(<App />)); await settle()
  const links = [...container.querySelectorAll<HTMLButtonElement>('button.md-link--file')].filter(link => !link.closest('[hidden], [inert]'))
  expect(links).toHaveLength(1); expect(links[0]!.textContent).toBe(path)
  await act(async () => links[0]!.click()); await settle()
  const state = useAppStore.getState(), browsers = Object.values(state.tabs).filter(tab => workbenchSurfaces(tab).some(surface => surface.kind === 'browser'))
  expect(browsers).toHaveLength(1); expect(browsers[0]!.id).not.toBe(id)
  expect(workbenchSurfaces(browsers[0]!)).toMatchObject([{ kind: 'browser', url, bookmarkOrigin: { path, binary: false } }])
  expect(state.tabs[id]).toBe(file); expect(state.documents[key]).toBe(draft)
  expect(state.dirtyDocuments[key]).toBe(true); expect(state.documentGenerations[key]).toBe(27)
  expect(state.workbenchSpaceSelection?.tabId).toBe(browsers[0]!.id)
  expect(state.sessions.find(session => session.id === defaultAgent.id)?.control).toBe(defaultAgent.control)
  expect(read).not.toHaveBeenCalled()
})

it.each([['survey', false], ['mote', false], ['survey', true], ['mote', true]] as const)('%s Browser toolbar View bookmark source preserves the Browser and selects a real local File (cached=%s)', async (surface, cached) => {
  const path = 'view-source.url', url = 'https://navigation.example/view-source'
  sourceBody = '[' + path + '](' + path + ')'
  const bookmark = vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url, binary: false })
  const create = vi.spyOn(api.browser, 'create')
  await mount(surface)
  if (surface === 'survey') { await act(async () => requestPmoTeamsTopicFloatingClose({ restoreFocus: false })); await settle() }
  await act(async () => fileLink(surface, path).click()); await settle()
  const browser = workbenchSurfaces(useAppStore.getState().tabs[defaultTab.id]!).filter(surface => surface.kind === 'browser')
  expect(browser).toHaveLength(1); expect(browser[0]).toMatchObject({ url, bookmarkOrigin: { path, binary: false } })
  const document = { path, content: 'ORIGINAL RESOURCE FILE', revision: 'cached-source-revision' }
  if (cached) {
    await act(async () => {
      useAppStore.setState({ documents: { [documentKey(SCRATCH_WORKSPACE_ID, path)]: document } })
      // The Browser remains visible beside the selected Agent. Keyboard click
      // must select this Browser and then consume the synchronous cached File.
      if (surface === 'survey') {
        const selected = useAppStore.getState().surveyZoneSelection!
        useAppStore.getState().setSurveyZoneSelection({ ...selected, selection: [{ tabId: defaultTab.id, regionId: reference.regionId }], active: { tabId: defaultTab.id, regionId: reference.regionId } })
      } else requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, reference })
    })
    await settle()
  }
  const before = snapshot()
  const buttons = [...localHost(surface).querySelectorAll<HTMLButtonElement>('button[aria-label="View bookmark source"]')].filter(button => !button.closest('[hidden], [inert]'))
  expect(buttons).toHaveLength(1); expect(buttons[0]!.disabled).toBe(false)
  if (surface === 'survey') expect(buttons[0]!.closest('.browser-surface--survey')).not.toBeNull()
  await act(async () => buttons[0]!.click()); await settle()
  const state = useAppStore.getState(), files = workbenchSurfaces(state.tabs[defaultTab.id]!).filter(surface => surface.kind === 'file')
  expect(files).toHaveLength(1); expect(files[0]).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, path })
  expect(state.documents[documentKey(SCRATCH_WORKSPACE_ID, path)]?.content).toBe('ORIGINAL RESOURCE FILE')
  expect(state.tabs[defaultTab.id]!.regions[browser[0]!.regionId]).toBe(browser[0])
  expect(state.tabs[fileTabId(SCRATCH_WORKSPACE_ID, path)]).toBeUndefined()
  expectRetained(before, !cached, path)
  if (cached) expect(state.documents[documentKey(SCRATCH_WORKSPACE_ID, path)]).toBe(document)
  if (surface === 'survey') {
    expect(state.surveyZoneSelection?.active).toEqual({ tabId: defaultTab.id, regionId: files[0]!.regionId })
    expect(readPmoTeamsTopicFloatingState()).toEqual(before.mote)
  } else {
    expect(readPmoTeamsTopicFloatingState()?.reference).toEqual({ ...reference, regionId: files[0]!.regionId })
    expect(state.surveyZoneSelection).toEqual(before.survey)
  }
  if (cached) expect(read).not.toHaveBeenCalled()
  else expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path)
  expect(bookmark).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1)
})

it.each(['survey', 'mote'] as const)('%s delayed Browser View bookmark source retains later local A to B to A navigation', async surface => {
  const path = 'late-source.url', url = 'https://navigation.example/late-source'
  sourceBody = '[' + path + '](' + path + ')'
  vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url, binary: false })
  await mount(surface)
  if (surface === 'survey') { await act(async () => requestPmoTeamsTopicFloatingClose({ restoreFocus: false })); await settle() }
  await act(async () => fileLink(surface, path).click()); await settle()
  const browser = workbenchSurfaces(useAppStore.getState().tabs[defaultTab.id]!).filter(surface => surface.kind === 'browser')
  expect(browser).toHaveLength(1)
  const buttons = [...localHost(surface).querySelectorAll<HTMLButtonElement>('button[aria-label="View bookmark source"]')].filter(button => !button.closest('[hidden], [inert]'))
  expect(buttons).toHaveLength(1); expect(buttons[0]!.disabled).toBe(false)
  if (surface === 'survey') expect(buttons[0]!.closest('.browser-surface--survey')).not.toBeNull()
  let complete!: (value: unknown) => void
  read.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await act(async () => buttons[0]!.click())
  await vi.waitFor(() => expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path))
  const before = snapshot()
  await act(async () => {
    if (surface === 'survey') {
      const selected = useAppStore.getState().surveyZoneSelection!
      const select = (regionId: string) => useAppStore.getState().setSurveyZoneSelection({ ...selected,
        selection: [{ tabId: defaultTab.id, regionId }], active: { tabId: defaultTab.id, regionId } })
      select(reference.regionId); select(browser[0]!.regionId)
    } else {
      requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, reference })
      requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, reference: { ...reference, regionId: browser[0]!.regionId } })
    }
    complete({ status: 'read', document: { path, content: 'LATE RETAINED SOURCE', revision: 'late-source-revision' } })
  })
  await settle()
  const state = useAppStore.getState(), files = workbenchSurfaces(state.tabs[defaultTab.id]!).filter(surface => surface.kind === 'file')
  expect(files).toHaveLength(1); expect(files[0]).toMatchObject({ path, workspaceId: SCRATCH_WORKSPACE_ID })
  expect(state.documents[documentKey(SCRATCH_WORKSPACE_ID, path)]?.content).toBe('LATE RETAINED SOURCE')
  expect(state.tabs[defaultTab.id]!.regions[browser[0]!.regionId]).toBe(browser[0])
  expectRetained(before, true, path)
  expect(state.surveyZoneSelection).toEqual(before.survey); expect(readPmoTeamsTopicFloatingState()).toEqual(before.mote)
})
