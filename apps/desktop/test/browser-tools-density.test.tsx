// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, BrowserProfileSummary, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import type { BrowserAnnotation } from '../src/renderer/src/lib/browser-annotations.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

const fixture = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return { state: {
    projectRailOpen: true, toolsOpen: true, mainSurface: 'survey', surveyBrowserSelection: null, surveyToolsOpen: true,
    setSurveyBrowserSelection: vi.fn(), setSurveyToolsOpen: vi.fn(), openLauncher: vi.fn(),
    activeWorkspaceId: 'workspace-tools', toggleProjectRail: vi.fn(), toggleTools: vi.fn(),
    layouts: {} as Record<string, WorkspaceLayout>, config: null as AppConfig | null,
    sessions: [] as SessionSnapshot[], tabs: {} as Record<string, WorkbenchTab>,
    browserAnnotationsByBrowserId: {} as Record<string, BrowserAnnotation[]>,
    selectWorkspace: vi.fn(async (_workspaceId: string) => {}), createBrowser: vi.fn(async (_groupId: string, _launcher?: unknown, _url?: string) => {}), selectSession: vi.fn(),
    deleteBrowserAnnotation: vi.fn(), clearBrowserAnnotations: vi.fn(), appendAgentComposerDraft: vi.fn()
  } }
})
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign((selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state, getInitialState: () => fixture.state, subscribe: () => () => {} })
}))
import { GlobalSurveySurface } from '../src/renderer/src/components/GlobalSurveySurface.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { api } from '../src/renderer/src/lib/api.js'

const workspace: WorkspaceRecord = { id: 'workspace-tools', hostId: 'local', name: 'Tools', kind: 'folder', path: '/repo' }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {
    selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true
  } } }
const browser = { id: 'browser-tools', browserId: 'browser-tools', regionId: 'region-tools', workspaceId: workspace.id,
  kind: 'browser' as const, navigationId: 'navigation-tools', profileId: 'default', title: 'Current page', url: 'https://example.test/',
  loading: false, canGoBack: true, canGoForward: false, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null }
const profile: BrowserProfileSummary = { id: 'default', label: 'Default', createdAt: 1, isDefault: true, source: null }
const workProfile: BrowserProfileSummary = { ...profile, id: 'work', label: 'Work', isDefault: false }
const annotation: BrowserAnnotation = { id: 'note-current', workspaceId: workspace.id, browserId: browser.id,
  navigationId: browser.navigationId, note: 'Current page note', selection: {
    browserId: browser.id, navigationId: browser.navigationId, pageTitle: browser.title, pageUrl: browser.url,
    tagName: 'button', role: 'button', accessibleName: 'Continue', selector: 'button.continue', text: 'Continue',
    nearbyText: [], attributes: {}, html: '<button>Continue</button>',
    rectViewport: { x: 1, y: 2, width: 30, height: 20 }, rectPage: { x: 1, y: 2, width: 30, height: 20 }, isFixed: false
  } }
const stale: BrowserAnnotation = { ...annotation, id: 'note-stale', navigationId: 'navigation-old', note: 'Old page note',
  selection: { ...annotation.selection, navigationId: 'navigation-old' } }
function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: workspace.path,
    label: id, createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'working', source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } }
}
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  fixture.state.config = structuredClone(config)
  fixture.state.projectRailOpen = true
  fixture.state.layouts = { [workspace.id]: createWorkspaceLayout('pane-tools', ['tab-tools']) }
  fixture.state.tabs = { 'tab-tools': createWorkbenchTab('tab-tools', browser) }
  fixture.state.openLauncher.mockImplementation(() => {
    const launcher = createWorkbenchTab('new-page', { kind: 'launcher', workspaceId: workspace.id, regionId: 'new-page-region' })
    fixture.state.tabs = { ...fixture.state.tabs, [launcher.id]: launcher }
    fixture.state.layouts[workspace.id]!.groups[0]!.tabOrder.push(launcher.id)
    return launcher.id
  })
  fixture.state.sessions = [agent('agent-1'), agent('agent-2')]
  fixture.state.browserAnnotationsByBrowserId = { [browser.id]: [annotation, stale] }
  vi.spyOn(api.browser, 'listProfiles').mockResolvedValue([profile, workProfile])
  vi.spyOn(api.browser, 'createProfile').mockResolvedValue({ ...workProfile, id: 'new-profile', label: 'Research' })
  vi.spyOn(api.browser, 'detectProfileImportSources').mockResolvedValue([{ token: 'source-1', browserLabel: 'Source Browser', profileLabel: 'Source Profile' }])
  vi.spyOn(api.browser, 'importProfile').mockResolvedValue({ ...workProfile, id: 'imported', label: 'Imported' })
  vi.spyOn(api.browser, 'switchProfile').mockResolvedValue(browser)
  vi.spyOn(api.config, 'save').mockImplementation(async next => { fixture.state.config = next; return next })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
async function mount() { await act(async () => root.render(<GlobalSurveySurface />)) }
async function click(element: Element | null) {
  expect(element).not.toBeNull(); await act(async () => (element as HTMLElement).click())
}
async function select(element: HTMLSelectElement, value: string) {
  await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('mounts one creation entry beside the current Workspace and nonempty flat sections without an introduction or cards', async () => {
  await mount()
  const content = container.querySelector('.browser-tools-panel')!
  expect(content).not.toBeNull()
  expect(container.querySelectorAll('[aria-label="New Browser"]')).toHaveLength(1)
  expect(container.querySelector('[aria-label="New Browser"]')?.closest('.survey-tabs')).not.toBeNull()
  expect(content.querySelector('h2')).toBeNull()
  expect(content.textContent).not.toContain('Open a browser tab')
  expect(content.textContent).not.toContain('Main-owned')
  expect(content.textContent).not.toContain('Universal Pane')
  const sections = [...content.querySelectorAll(':scope > section')]
  expect(sections.map(section => section.getAttribute('aria-label'))).toEqual(['Browser bar visibility', 'Browser Profiles', 'Browser annotations'])
  expect(content.querySelectorAll('input[type="checkbox"]')).toHaveLength(6)
  expect(content.querySelectorAll('.browser-profiles__catalog article')).toHaveLength(2)
  expect(content.querySelectorAll('.browser-annotations__list article')).toHaveLength(2)
  const css = readFileSync(resolve('apps/desktop/src/renderer/src/styles/browser.css'), 'utf8')
  // Derive the scanned selectors from mounted sections; empty DOM or missing CSS cannot pass this gate.
  for (const section of sections) {
    const rule = css.match(new RegExp(`\\.${section.className}\\s*\\{([^}]+)\\}`))
    expect(rule, section.className).not.toBeNull()
    expect(rule![1]).not.toMatch(/\bborder\s*:|\bborder-radius\s*:|\bbackground\s*:/)
  }
  const settings = content.querySelector<HTMLDetailsElement>('details')!
  expect(settings).not.toBeNull()
  expect(settings.open).toBe(false)
  expect(settings.querySelector('summary')?.getAttribute('aria-label')).toBe('Browser bar settings')
  fixture.state.projectRailOpen = false
  await mount()
  expect(container.querySelectorAll('[aria-label="New Browser"]')).toHaveLength(1)
})

it('creates in the focused pane once, preserves busy state, and shows a persistent failure in the visible body', async () => {
  let release!: () => void
  fixture.state.createBrowser.mockImplementationOnce(() => new Promise<void>(done => { release = done }))
  await mount()
  const create = container.querySelector<HTMLButtonElement>('[aria-label="New Browser"]')!
  await click(create)
  expect(fixture.state.createBrowser).toHaveBeenCalledExactlyOnceWith('pane-tools', { tabId: 'new-page', regionId: 'new-page-region' }, 'about:blank')
  expect(create.disabled).toBe(true)
  await act(async () => release())
  expect(create.disabled).toBe(false)
  fixture.state.createBrowser.mockRejectedValueOnce(new Error('Browser could not open; retry here'))
  await click(create)
  expect(container.querySelector('.survey-error[role="alert"]')?.textContent).toContain('Browser could not open; retry here')
})

it('keeps explicit save and its CAS expectation; failure and dirty draft remain visible when settings collapse', async () => {
  await mount()
  const settings = container.querySelector<HTMLDetailsElement>('.browser-tools-preferences details')!
  expect(settings).not.toBeNull()
  settings.open = true
  const screenshot = [...settings.querySelectorAll('label')].find(label => label.textContent === 'Screenshot')!.querySelector('input')!
  await click(screenshot)
  expect(api.config.save).not.toHaveBeenCalled()
  const save = settings.querySelector('button')!
  vi.mocked(api.config.save).mockRejectedValueOnce(new Error('Changed elsewhere; review and save again'))
  await click(save)
  expect(api.config.save).toHaveBeenLastCalledWith(
    { ...config, browser: { toolbar: { ...config.browser.toolbar, screenshot: false } } }, config)
  settings.open = false
  const error = container.querySelector('.browser-tools-preferences > [role="alert"]')
  expect(error?.textContent).toContain('Changed elsewhere; review and save again')
  expect(screenshot.checked).toBe(false)
  expect(save.disabled).toBe(false)
  settings.open = true
  await click(save)
  expect(fixture.state.config!.browser.toolbar.screenshot).toBe(false)
  expect(container.querySelector('.browser-tools-preferences > [role="alert"]')).toBeNull()
})

it('retains actual Profile create, detected-source import and current Browser Profile switch handlers', async () => {
  await mount()
  await input(container.querySelector('[aria-label="New Browser Profile name"]')!, 'Research')
  await act(async () => container.querySelector('form.browser-profiles__create')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(api.browser.createProfile).toHaveBeenCalledExactlyOnceWith('Research')
  expect(container.querySelectorAll('.browser-profiles__catalog article')).toHaveLength(3)
  await click(container.querySelector('.browser-profiles__import-open'))
  const importer = container.querySelector('[aria-label="Import Browser Profile"]')!
  await select(importer.querySelector('select')!, 'source-1')
  await click(importer.querySelector('.primary-button'))
  expect(api.browser.importProfile).toHaveBeenCalledExactlyOnceWith('source-1', 'Source Browser — Source Profile')
  await select(container.querySelector('[aria-label="Profile for Current page"]')!, 'work')
  expect(api.browser.switchProfile).toHaveBeenCalledExactlyOnceWith(browser.id, 'work')
})

it('retains note deletion, clear and delivery of current notes to the explicitly selected Agent Composer', async () => {
  await mount()
  const annotations = container.querySelector('.browser-annotations')!
  await click(annotations.querySelector('[aria-label="Delete annotation"]'))
  expect(fixture.state.deleteBrowserAnnotation).toHaveBeenCalledExactlyOnceWith(browser.id, annotation.id)
  await select(annotations.querySelector('select')!, 'agent-2')
  await click(annotations.querySelector('.primary-button'))
  expect(fixture.state.appendAgentComposerDraft).toHaveBeenCalledTimes(1)
  expect(fixture.state.appendAgentComposerDraft.mock.calls[0]![0]).toBe('agent-2')
  expect(fixture.state.appendAgentComposerDraft.mock.calls[0]![1]).toContain('Current page note')
  expect(fixture.state.appendAgentComposerDraft.mock.calls[0]![1]).not.toContain('Old page note')
  expect(fixture.state.selectSession).toHaveBeenCalledExactlyOnceWith('agent-2', 'pane-tools')
  await click(annotations.querySelector('.small-button'))
  expect(fixture.state.clearBrowserAnnotations).toHaveBeenCalledExactlyOnceWith(browser.id)
})

it('shows real unavailable import and Agent states without hiding notes or failing controls', async () => {
  fixture.state.sessions = []
  vi.mocked(api.browser.detectProfileImportSources).mockResolvedValue([])
  await mount()
  expect(container.querySelectorAll('.browser-annotations__list article')).toHaveLength(2)
  expect(container.querySelector<HTMLButtonElement>('.browser-annotations .primary-button')?.disabled).toBe(true)
  await click(container.querySelector('.browser-profiles__import-open'))
  expect(container.querySelector('[aria-label="Import Browser Profile"]')?.textContent).toContain('No supported Browser Profiles were detected')
  expect(container.querySelector('[aria-label="Import Browser Profile"] .primary-button')).toBeNull()
})


it('scopes notes and Profile switches to the current Workspace and keeps global Profile usage protection', async () => {
  const elsewhere = { ...browser, id: 'browser-elsewhere', browserId: 'browser-elsewhere', regionId: 'region-elsewhere', workspaceId: 'elsewhere', profileId: 'work', title: 'Other workspace page' }
  fixture.state.tabs.elsewhere = createWorkbenchTab('tab-elsewhere', elsewhere)
  fixture.state.browserAnnotationsByBrowserId.elsewhere = [{ ...annotation, id: 'elsewhere-note', workspaceId: 'elsewhere', note: 'Not this Workspace' }]
  fixture.state.sessions.push({ ...agent('agent-elsewhere'), workspacePath: '/elsewhere' })
  await mount()
  expect([...container.querySelectorAll('.browser-profiles__browsers label strong')].map(node => node.textContent)).toEqual(['Current page'])
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Delete Work"]')?.disabled).toBe(true)
  expect([...container.querySelectorAll('.browser-annotations__list article')].map(node => ({ stale: node.classList.contains('stale'), text: node.querySelector('small')?.textContent }))).toEqual([
    { stale: false, text: 'Current page note' }, { stale: true, text: 'Page changed · annotation is stale' }
  ])
  expect([...container.querySelectorAll('.browser-annotations select option')].map(node => node.getAttribute('value'))).toEqual(['', 'agent-1', 'agent-2'])
  expect(container.textContent).not.toContain('Not this Workspace')
})
