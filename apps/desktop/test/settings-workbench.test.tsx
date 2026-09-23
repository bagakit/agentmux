// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
// These surfaces are outside Settings' ownership. Keep the actual App route and footer controls.
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/PmoTeamsTopicFloatingPanel', () => ({ PmoTeamsTopicFloatingPanel: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
vi.mock('../src/renderer/src/components/GlobalBoardSurface', () => ({ GlobalBoardSurface: () => null }))
vi.mock('../src/renderer/src/components/GlobalFocusSurface', () => ({ GlobalFocusSurface: () => null }))
vi.mock('../src/renderer/src/components/GlobalSurveySurface', () => ({ GlobalSurveySurface: () => null }))
import { App } from '../src/renderer/src/App'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { WorkspaceSettingsPane } from '../src/renderer/src/components/settings/WorkspaceSettingsPane'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => {
  useAppStore.setState({ hostChecks: { local: { state: 'ready', input: composerConfig.hosts[0], detail: 'Ready' } }, detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}), loading: false, toolsOpen: false, initialize: vi.fn(async () => () => {}), mainSurface: 'workbench' })
})
async function input(selector: string, value: string) {
  const element = dom.container.querySelector<HTMLInputElement>(selector)!
  expect(element).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function section(title: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings sections"] button')].find(node => node.textContent === title)!
  expect(button).not.toBeUndefined()
  await act(async () => button.click())
}

it('keeps drafts and each visited scroll container while leaving unvisited panes unmounted', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect([...dom.container.querySelectorAll<HTMLElement>('[data-settings-pane]')].map(el => el.dataset.settingsPane)).toEqual(['appearance'])
  await section('Appearance')
  await input('[aria-label="Terminal font size in pixels"]', '17')
  const appearance = dom.container.querySelector<HTMLElement>('[data-settings-pane="appearance"]')!
  appearance.scrollTop = 123
  await section('Browser')
  expect(appearance.hidden).toBe(true)
  expect(appearance.inert).toBe(true)
  await section('Appearance')
  expect(dom.container.querySelector('[data-settings-pane="appearance"]')).toBe(appearance)
  expect(appearance.hidden).toBe(false)
  expect(appearance.scrollTop).toBe(123)
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal font size in pixels"]')!.value).toBe('17')
  expect(dom.container.querySelector('[data-settings-pane="hosts"]')).toBeNull()
})

it('searches via the real input, hides unmatched content and restores its draft after clearing', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="appearance" />)
  await input('[aria-label="Terminal font size in pixels"]', '18')
  await input('[aria-label="Search settings"]', 'zz-no-such-setting')
  expect(dom.container.querySelector('.settings-nav-empty[role="status"]')!.textContent).toContain('No settings match')
  expect(dom.container.querySelector<HTMLElement>('[data-settings-pane="appearance"]')!.hidden).toBe(true)
  await dom.click('[aria-label="Clear settings search"]')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal font size in pixels"]')!.value).toBe('18')
  expect(dom.container.querySelector('.settings-nav-empty[role="status"]')).toBeNull()
})

it('clears search with Escape before closing settings, including from a focused input', async () => {
  const close = vi.fn()
  await dom.render(<SettingsPanel onClose={close} />)
  await input('[aria-label="Search settings"]', 'font')
  const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
  await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(search.value).toBe('')
  expect(close).not.toHaveBeenCalled()
  await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(close).toHaveBeenCalledOnce()
})

it('returns Clear focus to the original search input so the next query can be typed directly', async () => {
  const close = vi.fn()
  await dom.render(<SettingsPanel onClose={close} initialSection="appearance" />)
  await input('[aria-label="Terminal font size in pixels"]', '18')
  const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
  expect(search.isConnected).toBe(true)
  await input('[aria-label="Search settings"]', 'copy')
  const clear = dom.container.querySelector<HTMLButtonElement>('[aria-label="Clear settings search"]')!
  expect(clear.isConnected).toBe(true)
  clear.focus()
  await act(async () => clear.click())
  expect(document.activeElement).toBe(search)
  expect(search.value).toBe('')
  expect(clear.isConnected).toBe(false)
  await act(async () => {
    const focused = document.activeElement as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(focused, 'host')
    focused.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(search.value).toBe('host')
  expect(dom.container.querySelector('.settings-content__header h2')!.textContent).toBe('Hosts')
  expect(close).not.toHaveBeenCalled()
  await input('[aria-label="Search settings"]', '')
  await section('Appearance')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal font size in pixels"]')!.value).toBe('18')
})

it('keeps one Copy Paths introduction and the actual path examples and scope', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="general" />)
  const pane = dom.container.querySelector<HTMLElement>('[data-settings-pane="general"]')!
  expect(pane.isConnected).toBe(true)
  expect(pane.hidden).toBe(false)
  expect(dom.container.querySelector('.settings-content__header h2')!.textContent).toBe('General')
  expect(dom.container.querySelector('.settings-content__header p')!.textContent).toBe('Copied paths, local data, and diagnostics.')
  const copiedPaths = pane.querySelector<HTMLElement>('.settings-group')!
  expect(copiedPaths.isConnected).toBe(true)
  expect(copiedPaths.querySelector('header > span')!.textContent).toBe('Home directory in copied paths')
  expect(copiedPaths.querySelector('.settings-lead')).toBeNull()
  const toggle = copiedPaths.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(toggle.isConnected).toBe(true)
  expect(pane.textContent).toContain('proj/app')
  expect(pane.textContent).toContain('your own home directory')
  expect(pane.textContent).toContain('Remote paths and paths belonging to another user always stay complete')
  expect(pane.textContent).toContain('Applies to every Copy Path action')
})

it('prioritizes existing workspaces and retains the creation draft across disclosure and section switches', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="workspaces" />)
  expect(dom.container.querySelector('.workspace-settings-list')!.textContent).toContain('Project')
  expect(dom.container.querySelector<HTMLElement>('.settings-workspace-create')!.hidden).toBe(true)
  await dom.click('.settings-pane-toolbar button')
  await input('[placeholder="/path/to/project"]', '/new-project')
  await dom.click('[aria-label="Cancel adding project"]')
  expect(dom.container.querySelector<HTMLElement>('.settings-workspace-create')!.hidden).toBe(true)
  await section('Appearance')
  await section('Workspaces')
  await dom.click('.settings-pane-toolbar button')
  expect(dom.container.querySelector<HTMLInputElement>('[placeholder="/path/to/project"]')!.value).toBe('/new-project')
})

it('starts empty workspaces with a creation path and calls the original registration API', async () => {
  const config = { ...composerConfig, workspaces: [] }
  const created = { ...composerConfig.workspaces[0]!, id: 'new', path: '/new' }
  const add = vi.spyOn(api.workspaces, 'add').mockResolvedValue(created)
  vi.spyOn(api.config, 'get').mockResolvedValue({ ...config, workspaces: [created] })
  const select = vi.fn(async () => {})
  useAppStore.setState({ selectWorkspace: select })
  const close = vi.fn()
  await dom.render(<WorkspaceSettingsPane config={config} onClose={close} />)
  expect(dom.container.querySelector<HTMLElement>('.settings-workspace-create')!.hidden).toBe(false)
  await input('[placeholder="/path/to/project"]', '/new')
  await dom.click('.workspace-composer .primary-button')
  expect(add).toHaveBeenCalledWith({ hostId: 'local', path: '/new' })
  expect(select).toHaveBeenCalledWith('new')
  expect(close).toHaveBeenCalledOnce()
})

it('keeps the real App footer interactive, returns through its surface controls and preserves runtime/workbench facts', async () => {
  useAppStore.setState({ config: { ...composerConfig, workspaces: [] }, sessions: [], tabs: {}, layouts: {}, activeWorkspaceId: null })
  await dom.render(<App />)
  const before = useAppStore.getState()
  await dom.click('.window-status-bar [aria-label="Settings"]')
  const settings = dom.container.querySelector('.settings-page')!
  const footer = dom.container.querySelector<HTMLElement>('.window-status-bar')!
  expect(settings).not.toBeNull()
  expect(settings.querySelector('.settings-content__header h2')!.textContent).toBe('Appearance')
  expect(footer.closest('[inert]')).toBeNull()
  expect(footer.closest('[aria-hidden="true"]')).toBeNull()
  expect(dom.container.querySelector<HTMLElement>('.app-shell__workspace')!.inert).toBe(true)
  await dom.click('.window-status-bar [aria-label="Space: show terminal and file workbench"]')
  expect(dom.container.querySelector('.settings-page')).toBeNull()
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  await dom.click('.window-status-bar [aria-label="Settings"]')
  await dom.click('.window-status-bar [aria-label="Settings"]')
  expect(dom.container.querySelector('.settings-page')).toBeNull()
})
