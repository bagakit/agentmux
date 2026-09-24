// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
const toolsObservation = vi.hoisted(() => ({ commits: 0 }))
vi.mock('../src/renderer/src/components/SearchBrowserTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/SearchBrowserTools')>()
  const { Profiler } = await import('react')
  // Observe the actual tool tree's consumption boundary without replacing its behavior.
  return { ...actual, SearchBrowserTools: (props: ComponentProps<typeof actual.SearchBrowserTools>) => (
    <Profiler id="search-tools" onRender={() => { toolsObservation.commits += 1 }}>
      <actual.SearchBrowserTools {...props} />
    </Profiler>
  ) }
})
import { App } from '../src/renderer/src/App'
import { GlobalSearchSurface } from '../src/renderer/src/components/GlobalSearchSurface'
import type { BrowserSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import type { BrowserAnnotation } from '../src/renderer/src/lib/browser-annotations'
import { addWorkbenchRegion, createWorkbenchTab, documentKey, titleWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const realInitialize = useAppStore.getState().initialize
const dom = composerDOM()
const workspace = composerConfig.workspaces[0]!
const session = composerSession()
const retained = createWorkbenchTab('retained-agent', {
  regionId: 'retained-region', kind: 'agent', phase: 'attached',
  workspaceId: workspace.id, sessionId: session.id
})
let previousStorage: string | null
const browser: BrowserSnapshot = {
  id: 'browser-search', navigationId: 'navigation-search', profileId: 'default', url: 'https://example.test/',
  title: 'Search result', loading: false, canGoBack: false, canGoForward: false,
  viewport: 'responsive', driving: false, appLinkPrompt: null, error: null
}

beforeEach(() => {
  toolsObservation.commits = 0
  previousStorage = localStorage.getItem('agentmux-workbench-v1')
  useAppStore.setState({
    loading: false, initialize: vi.fn(async () => () => {}), mainSurface: 'search',
    config: composerConfig, activeWorkspaceId: workspace.id, sessions: [session],
    tabs: { [retained.id]: retained }, layouts: { [workspace.id]: createWorkspaceLayout('search-group', [retained.id]) },
    agentFocus: { execution: { sessionId: session.id, history: [{ sessionId: session.id, focusedAt: 1 }] }, pmo: { sessionId: null } },
    workspaceTool: 'agents', projectRailOpen: true, toolsOpen: true, browserAnnotationsByBrowserId: {}, demands: {},
    error: null, lastError: null, errorDismissed: true, documents: {}, dirtyDocuments: {}, displacedAgentSessionIds: []
  })
  vi.spyOn(api.browser, 'listProfiles').mockResolvedValue([{ id: 'default', label: 'Default', createdAt: 1, isDefault: true, source: null }])
})
afterEach(() => {
  if (previousStorage === null) localStorage.removeItem('agentmux-workbench-v1')
  else localStorage.setItem('agentmux-workbench-v1', previousStorage)
})
async function fill(field: HTMLInputElement, value: string) {
  expect(field).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function input(value: string) {
  await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')!, value)
}
async function submit() {
  const form = dom.container.querySelector<HTMLFormElement>('.global-search-input')!
  expect(form).not.toBeNull()
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
function healthyAgentRetained() {
  const current = useAppStore.getState()
  expect(current.tabs[retained.id]).toEqual(retained)
  expect(current.sessions).toEqual([session])
  expect(current.sessions[0]!.control.run).toEqual({ runId: 'run-agent-1' })
  expect(current.agentComposerDrafts[session.id]).toBe('Keep my draft')
}

it('mounts Search through the actual App navigation and consumes the Browser tools in the current Workspace', async () => {
  useAppStore.setState({ mainSurface: 'workbench' })
  const before = useAppStore.getState()
  await dom.render(<App />)
  expect(dom.container.querySelector('.global-search-surface')).toBeNull()
  await dom.click('[aria-label="Search: search and manage browsers"]')
  expect(useAppStore.getState().mainSurface).toBe('search')
  const surface = dom.container.querySelector('.global-search-surface')!
  expect(surface).not.toBeNull()
  expect(surface.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')).not.toBeNull()
  expect(surface.querySelector('.global-search-context > span')?.textContent).toBe('WorkspaceProject')
  expect(surface.querySelector('.global-search-context > span')?.getAttribute('title')).toBe(workspace.path)
  expect([...surface.querySelectorAll('.browser-tools-panel > section')].map(section => section.getAttribute('aria-label'))).toEqual([
    'Browser bar visibility', 'Browser Profiles', 'Browser annotations'
  ])
  expect(surface.querySelectorAll('.browser-profiles__catalog article')).toHaveLength(1)
  expect(dom.container.querySelector('[aria-label="Browser Tools"]')?.closest('.surface-tool-panel')).toBeNull()
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  await dom.click('.global-search-context button:first-of-type')
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  healthyAgentRetained()
})

it('keeps visited Search drafts and failed save through both actual Space return paths without repeating owner actions', async () => {
  useAppStore.setState({ mainSurface: 'workbench' })
  const before = useAppStore.getState()
  const createBrowser = vi.spyOn(api.browser, 'create')
  const createProfile = vi.spyOn(api.browser, 'createProfile')
  const importProfile = vi.spyOn(api.browser, 'importProfile')
  const detect = vi.spyOn(api.browser, 'detectProfileImportSources').mockResolvedValue([
    { token: 'source-draft', browserLabel: 'Source Browser', profileLabel: 'Source Profile' }
  ])
  const save = vi.spyOn(api.config, 'save').mockRejectedValue(new Error('Changed elsewhere; review and save again'))
  await dom.render(<App />)
  expect(dom.container.querySelector('.global-search-surface')).toBeNull()
  await dom.click('[aria-label="Search: search and manage browsers"]')
  const surface = dom.container.querySelector<HTMLElement>('.global-search-surface')!
  const query = surface.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')!
  const details = surface.querySelector<HTMLDetailsElement>('.browser-tools-preferences details')!
  expect(surface).not.toBeNull()
  await input('Unsubmitted search query')
  await dom.click('[aria-label="Browser bar settings"]')
  expect(details.open).toBe(true)
  const screenshotLabel = [...details.querySelectorAll('label')].find(label => label.textContent === 'Screenshot')
  expect(screenshotLabel).toBeDefined()
  const screenshot = screenshotLabel!.querySelector<HTMLInputElement>('input')!
  await act(async () => screenshot.click())
  await dom.click('.browser-tools-preferences button')
  const createName = surface.querySelector<HTMLInputElement>('[aria-label="New Browser Profile name"]')!
  await fill(createName, 'Unsubmitted Profile')
  await dom.click('.browser-profiles__import-open')
  const importer = surface.querySelector<HTMLElement>('[aria-label="Import Browser Profile"]')!
    expect(importer).not.toBeNull()
  const source = importer.querySelector<HTMLSelectElement>('select')!
  const importName = importer.querySelector<HTMLInputElement>('input')!
  await act(async () => { source.value = 'source-draft'; source.dispatchEvent(new Event('change', { bubbles: true })) })
  await fill(importName, 'Unsubmitted import name')

  for (const returnSelector of ['.global-search-context button:first-of-type', '[aria-label="Space: show terminal and file workbench"]']) {
    importName.focus()
    expect(document.activeElement).toBe(importName)
    await dom.click(returnSelector)
    expect(useAppStore.getState().mainSurface).toBe('workbench')
    expect(dom.container.querySelector('.global-search-surface')).toBe(surface)
    expect(surface.hidden).toBe(true)
    expect(surface.hasAttribute('inert')).toBe(true)
    expect(surface.getAttribute('aria-hidden')).toBe('true')
    expect(surface.contains(document.activeElement)).toBe(false)
    await dom.click('[aria-label="Search: search and manage browsers"]')
    expect(dom.container.querySelector('.global-search-surface')).toBe(surface)
    expect(surface.hidden).toBe(false)
    expect(surface.hasAttribute('inert')).toBe(false)
    expect(surface.getAttribute('aria-hidden')).toBe('false')
    expect(document.activeElement).toBe(query)
    expect(query.value).toBe('Unsubmitted search query')
    expect(details.open).toBe(true)
    expect(screenshot.checked).toBe(false)
    expect(details.querySelector('summary')?.textContent).toContain('Unsaved')
    expect(surface.querySelector('.browser-tools-preferences > [role="alert"]')?.textContent).toBe('Changed elsewhere; review and save again')
    expect(details.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
    expect(surface.querySelector('[aria-label="New Browser Profile name"]')).toBe(createName)
    expect(createName.value).toBe('Unsubmitted Profile')
    expect(surface.querySelector('[aria-label="Import Browser Profile"]')).toBe(importer)
    expect(source.value).toBe('source-draft')
    expect(importName.value).toBe('Unsubmitted import name')
    // Space's existing Agent selection may rebuild the projection object, retaining its IDs and topology.
    expect(useAppStore.getState().tabs).toStrictEqual(before.tabs)
    expect(useAppStore.getState().layouts).toStrictEqual(before.layouts)
    healthyAgentRetained()
  }
  expect(save).toHaveBeenCalledExactlyOnceWith(
    { ...composerConfig, browser: { toolbar: { ...composerConfig.browser.toolbar, screenshot: false } } }, composerConfig)
  expect(api.browser.listProfiles).toHaveBeenCalledTimes(1)
  expect(detect).toHaveBeenCalledTimes(1)
  expect(createBrowser).not.toHaveBeenCalled()
  expect(createProfile).not.toHaveBeenCalled()
  expect(importProfile).not.toHaveBeenCalled()
})

it('parks hidden Search tool subscriptions while unrelated Session, Tab and annotation facts change, then reads current facts on return', async () => {
  const browserSurface = { ...browser, kind: 'browser' as const, browserId: browser.id, regionId: 'search-browser-region', workspaceId: workspace.id }
  const browserTab = createWorkbenchTab('search-browser-tab', browserSurface)
  const annotation: BrowserAnnotation = { id: 'current-note', workspaceId: workspace.id, browserId: browser.id,
    navigationId: browser.navigationId, note: 'Retained current note', selection: {
      browserId: browser.id, navigationId: browser.navigationId, pageTitle: browser.title, pageUrl: browser.url,
      tagName: 'button', role: 'button', accessibleName: 'Continue', selector: 'button', text: 'Continue', nearbyText: [],
      attributes: {}, html: '<button>Continue</button>', rectViewport: { x: 1, y: 2, width: 30, height: 20 },
      rectPage: { x: 1, y: 2, width: 30, height: 20 }, isFixed: false
    } }
  const tabs = { [retained.id]: retained, [browserTab.id]: browserTab }
  useAppStore.setState({ mainSurface: 'workbench', tabs, layouts: { [workspace.id]: createWorkspaceLayout('search-group', Object.keys(tabs)) },
    browserAnnotationsByBrowserId: { [browser.id]: [annotation] } })
  vi.mocked(api.browser.listProfiles).mockResolvedValue([
    { id: 'default', label: 'Default', createdAt: 1, isDefault: true, source: null },
    { id: 'work', label: 'Work', createdAt: 1, isDefault: false, source: null }
  ])
  await dom.render(<App />)
  await dom.click('[aria-label="Search: search and manage browsers"]')
  const surface = dom.container.querySelector<HTMLElement>('.global-search-surface')!
  expect(toolsObservation.commits).toBeGreaterThan(0)
  expect(surface.querySelectorAll('.browser-annotations__list article')).toHaveLength(1)
  expect(surface.querySelector<HTMLButtonElement>('[aria-label="Delete Work"]')?.disabled).toBe(false)
  await dom.click('.global-search-context button:first-of-type')
  const parkedCommits = toolsObservation.commits
  const foreign = { ...composerSession('foreign-agent'), workspacePath: '/elsewhere' }
  await act(async () => useAppStore.setState({ sessions: [session, foreign] }))
  expect(toolsObservation.commits).toBe(parkedCommits)
  const foreignBrowser = { ...browserSurface, browserId: 'foreign-browser', regionId: 'foreign-browser-region', workspaceId: 'elsewhere', profileId: 'work' }
  const foreignTab = createWorkbenchTab('foreign-browser-tab', foreignBrowser)
  await act(async () => useAppStore.setState({ tabs: { ...tabs, [foreignTab.id]: foreignTab } }))
  expect(toolsObservation.commits).toBe(parkedCommits)
  await act(async () => useAppStore.setState({ browserAnnotationsByBrowserId: {
    [browser.id]: [annotation], [foreignBrowser.browserId]: [{ ...annotation, id: 'foreign-note', browserId: foreignBrowser.browserId, workspaceId: 'elsewhere' }]
  } }))
  expect(toolsObservation.commits).toBe(parkedCommits)
  expect(surface.querySelector<HTMLButtonElement>('[aria-label="Delete Work"]')?.disabled).toBe(false)
  expect(useAppStore.getState().tabs[retained.id]).toEqual(retained)
  expect(useAppStore.getState().sessions[0]).toEqual(session)
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep my draft')
  await dom.click('[aria-label="Search: search and manage browsers"]')
  expect(toolsObservation.commits).toBeGreaterThan(parkedCommits)
  expect(dom.container.querySelector('.global-search-surface')).toBe(surface)
  expect(surface.querySelector<HTMLButtonElement>('[aria-label="Delete Work"]')?.disabled).toBe(true)
  expect([...surface.querySelectorAll('.browser-profiles__browsers label strong')].map(node => node.textContent)).toEqual([browser.title])
  expect([...surface.querySelectorAll('.browser-annotations__list article small')].map(node => node.textContent)).toEqual(['Retained current note'])
  expect([...surface.querySelectorAll('.browser-annotations select option')].map(node => node.getAttribute('value'))).toEqual(['', session.id])
})

it('forwards multiword queries and URLs unchanged to the Main Browser owner and reveals the new Tab despite a selected Agent', async () => {
  const create = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url = 'about:blank') => ({ ...browser, id, url }))
  await dom.render(<GlobalSearchSurface />)
  for (const query of ['  distributed protocol notes  ', 'https://example.test/reference']) {
    await act(async () => useAppStore.getState().setMainSurface('search'))
    await input(query)
    await submit()
    const current = useAppStore.getState()
    expect(current.mainSurface).toBe('workbench')
    expect(current.activeWorkspaceId).toBe(workspace.id)
    const group = current.layouts[workspace.id]!.groups[0]!
    expect(group.id).toBe('search-group')
    expect(group.activeTabId).not.toBe(retained.id)
    const opened = titleWorkbenchSurface(current.tabs[group.activeTabId!]!)
    expect(opened.kind).toBe('browser')
    expect(opened).toMatchObject({ workspaceId: workspace.id, url: query })
    expect(create).toHaveBeenLastCalledWith(opened.regionId, query, workspace.id)
    healthyAgentRetained()
  }
  expect(create).toHaveBeenCalledTimes(2)
})

it('creates one blank Browser in the current group and keeps the sole secondary action busy until its owner attaches', async () => {
  let finish!: (snapshot: BrowserSnapshot) => void
  const create = vi.spyOn(api.browser, 'create').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await dom.render(<GlobalSearchSurface />)
  expect(dom.container.querySelectorAll('[aria-label="New Browser"]')).toHaveLength(1)
  await dom.click('[aria-label="New Browser"]')
  const button = dom.container.querySelector<HTMLButtonElement>('[aria-label="New Browser"]')!
  expect(button.disabled).toBe(true)
  expect(button.title).toBe('Opening Browser…')
  await dom.click('[aria-label="New Browser"]')
  expect(create).toHaveBeenCalledTimes(1)
  expect(create.mock.calls[0]?.slice(1)).toEqual(['about:blank', workspace.id])
  expect(useAppStore.getState().mainSurface).toBe('search')
  healthyAgentRetained()
  await act(async () => finish({ ...browser, id: create.mock.calls[0]![0], url: 'about:blank' }))
  expect(button.disabled).toBe(false)
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  const current = useAppStore.getState()
  const group = current.layouts[workspace.id]!.groups[0]!
  expect(group.tabOrder).toHaveLength(2)
  expect(titleWorkbenchSurface(current.tabs[group.activeTabId!]!)).toMatchObject({ kind: 'browser', workspaceId: workspace.id, url: 'about:blank' })
  healthyAgentRetained()
})

it('does not create for whitespace or a missing current landing and keeps the query and durable siblings visible', async () => {
  const create = vi.spyOn(api.browser, 'create')
  await dom.render(<GlobalSearchSurface />)
  await input('   ')
  await submit()
  expect(create).not.toHaveBeenCalled()
  const before = useAppStore.getState()
  await act(async () => useAppStore.setState({ layouts: {} }))
  await input('query with no focused group')
  await submit()
  expect(create).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('Select a workspace and focus a pane before opening a browser.')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')?.value).toBe('query with no focused group')
  expect(useAppStore.getState().mainSurface).toBe('search')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  healthyAgentRetained()
})

it('retains Search input, current Workspace, original Agent and actionable error after creation fails', async () => {
  const create = vi.spyOn(api.browser, 'create').mockRejectedValue(new Error('Native Browser owner unavailable'))
  await dom.render(<GlobalSearchSurface />)
  const before = useAppStore.getState()
  await input('recoverable search query')
  await submit()
  expect(create).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')?.value).toBe('recoverable search query')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Native Browser owner unavailable. Your input is kept; retry here.')
  expect(useAppStore.getState().mainSurface).toBe('search')
  expect(useAppStore.getState().activeWorkspaceId).toBe(workspace.id)
  expect(useAppStore.getState().tabs[retained.id]).toBe(before.tabs[retained.id])
  healthyAgentRetained()
})

it('restores Search beside the same durable Browser split and dirty file, then returns without replacing their identities', async () => {
  const surface = { ...browser, kind: 'browser' as const, regionId: 'search-browser-region', browserId: browser.id, workspaceId: workspace.id }
  const tab = addWorkbenchRegion(createWorkbenchTab('saved-search-tab', surface), surface.regionId, 'right', {
    kind: 'file', regionId: 'dirty-sibling', workspaceId: workspace.id, path: 'draft.md'
  })
  const layout = createWorkspaceLayout('saved-search-group', [tab.id])
  const key = documentKey(workspace.id, 'draft.md')
  const durable = {
    mainSurface: 'search', activeWorkspaceId: workspace.id,
    restoredWorkbench: { tabs: { [tab.id]: tab }, layouts: { [workspace.id]: layout } },
    documents: { [key]: { path: 'draft.md', content: 'Unsaved sibling', revision: 'disk' } }, dirtyDocuments: { [key]: true },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }
  }
  useAppStore.setState({ loading: true, mainSurface: 'workbench', tabs: {}, layouts: {}, restoredWorkbench: null, sessions: [], documents: {}, dirtyDocuments: {} })
  localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ version: 1, state: durable }))
  await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().restoredWorkbench).toEqual(durable.restoredWorkbench)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  const create = vi.spyOn(api.browser, 'create').mockResolvedValue(browser)
  const dispose = await realInitialize()
  try {
    await dom.render(<GlobalSearchSurface />)
    expect(useAppStore.getState().mainSurface).toBe('search')
    expect(useAppStore.getState().tabs[tab.id]?.layout).toEqual(tab.layout)
    expect(Object.keys(useAppStore.getState().tabs[tab.id]!.regions)).toEqual(['search-browser-region', 'dirty-sibling'])
    expect(useAppStore.getState().layouts[workspace.id]).toEqual(layout)
    expect(useAppStore.getState().documents[key]?.content).toBe('Unsaved sibling')
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(create).toHaveBeenCalledExactlyOnceWith(browser.id, browser.url, workspace.id)
    await dom.click('.global-search-context button:first-of-type')
    expect(useAppStore.getState().mainSurface).toBe('workbench')
    expect(useAppStore.getState().tabs[tab.id]?.layout).toEqual(tab.layout)
    expect(useAppStore.getState().tabs[tab.id]?.regions[surface.regionId]).toMatchObject({ kind: 'browser', browserId: browser.id, regionId: surface.regionId, profileId: browser.profileId })
    expect(create).toHaveBeenCalledTimes(1)
  } finally { dispose() }
})
