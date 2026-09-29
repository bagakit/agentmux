// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))

// Mock only the surrounding work surface. The Avatar, App route, Panel and resource editors
// remain production consumers; synthetic DOM events here do not establish trusted Native hits.
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', async () => {
  const { AgentAvatar } = await import('../src/renderer/src/components/AgentAvatar')
  return { WorkspaceWorkbench: () => <AgentAvatar executorId="review" label="Reviewer" /> }
})
vi.mock('../src/renderer/src/components/PmoTeamsTopicFloatingPanel', () => ({ PmoTeamsTopicFloatingPanel: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
vi.mock('../src/renderer/src/components/GlobalBoardSurface', () => ({ GlobalBoardSurface: () => null }))
vi.mock('../src/renderer/src/components/GlobalFocusSurface', () => ({ GlobalFocusSurface: () => null }))

import { App } from '../src/renderer/src/App'
import { SettingsPanel, visibleSettingsSections } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { APP_APPEARANCE_DEFAULT, TERMINAL_FONT_SIZE_DEFAULT } from '../src/shared/contracts'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => {
  useAppStore.setState({
    config: { ...composerConfig, copyPathsAsAbsolute: false,
      appearance: { terminalTheme: 'graphite', terminalFontSize: 15, appAppearance: 'dark' } },
    loading: false, toolsOpen: false, mainSurface: 'workbench', activeWorkspaceId: 'workspace',
    projectRailOpen: false, initialize: vi.fn(async () => () => {}),
    detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}),
    hostChecks: { local: { state: 'ready', input: composerConfig.hosts[0], detail: 'Ready' } }
  })
})

function connected<T extends HTMLElement = HTMLElement>(selector: string, scope: ParentNode = dom.container): T {
  const element = scope.querySelector<T>(selector)
  expect(element, `Missing connected element: ${selector}`).not.toBeNull()
  expect(element!.isConnected).toBe(true)
  return element!
}
const overview = () => connected('[data-settings-overview]')
function overviewIsShown() {
  const element = dom.container.querySelector<HTMLElement>('[data-settings-overview]')
  return element !== null && element.isConnected && element.closest('[hidden], [inert]') === null
}
const pane = (id: string) => connected(`[data-settings-pane="${id}"]`)
const mountedPanes = () => [...dom.container.querySelectorAll<HTMLElement>('[data-settings-pane]')]
  .map(node => node.dataset.settingsPane)
async function input(selector: string, value: string) {
  const element = connected<HTMLInputElement>(selector)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function section(title: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings sections"] button')]
    .find(node => node.textContent === title)
  expect(button, `Missing section: ${title}`).toBeDefined()
  expect(button!.isConnected).toBe(true)
  await act(async () => button!.click())
}
async function returnToOverview() { await dom.click('[data-settings-overview-nav]') }
async function openExecutor(avatar: HTMLElement, expectedLabel: string) {
  expect(avatar.isConnected).toBe(true)
  await act(async () => avatar.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  const popover = connected('.agent-identity-popover', document)
  const button = connected<HTMLButtonElement>(`[aria-label="Edit ${expectedLabel} executor"]`, popover)
  await act(async () => button.click())
  expect(document.querySelector('.agent-identity-popover')).toBeNull()
}

it('ordinary App footer opens Overview without mounting or probing the resource panes', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<App />)
  const before = useAppStore.getState()
  expect(dom.container.querySelector('.settings-page')).toBeNull()
  await dom.click('.window-status-bar [aria-label="Settings"]')
  expect(overviewIsShown()).toBe(true)
  expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe('Overview')
  expect(mountedPanes()).toEqual([])
  expect(useAppStore.getState().detectExecutors).not.toHaveBeenCalled()
  expect(useAppStore.getState().checkHost).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  const footer = connected('.window-status-bar')
  expect(footer.closest('[inert], [aria-hidden="true"]')).toBeNull()
  expect(connected('.app-shell__workspace').inert).toBe(true)
  await dom.click('[aria-label="Close settings"]')
  expect(dom.container.querySelector('.settings-page')).toBeNull()
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(connected('.app-shell__workspace').inert).toBe(false)
})

it('Overview, sidebar and actual navigation share the eight configuration sections rather than a ninth section', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const catalog = visibleSettingsSections('')
  expect(catalog.map(entry => entry.id)).toEqual([
    'appearance', 'notifications', 'browser', 'general', 'keyboard-shortcuts', 'agents', 'prompts', 'workspaces', 'hosts'
  ])
  const links = [...overview().querySelectorAll<HTMLButtonElement>('[data-settings-section]')]
  expect(links.map(link => link.dataset.settingsSection)).toEqual(catalog.map(entry => entry.id))
  expect([...dom.container.querySelectorAll('nav[aria-label="Settings sections"] p')].map(node => node.textContent))
    .toEqual(['Preferences', 'Resources'])
  expect([...dom.container.querySelectorAll('nav[aria-label="Settings sections"] button:not([data-settings-overview-nav])')]
    .map(node => node.textContent)).toEqual(catalog.map(entry => entry.title))
  expect(mountedPanes()).toEqual([])
  for (const [index, entry] of catalog.entries()) {
    const link = connected<HTMLButtonElement>(`[data-settings-section="${entry.id}"]`, overview())
    expect(link.isConnected).toBe(true)
    expect(overviewIsShown()).toBe(true)
    await act(async () => link.click())
    expect(pane(entry.id).hidden).toBe(false)
    expect(pane(entry.id).inert).toBe(false)
    expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe(entry.title)
    expect(mountedPanes()).toEqual(catalog.slice(0, index + 1).map(section => section.id))
    await returnToOverview()
    expect(overviewIsShown()).toBe(true)
  }
  expect(dom.container.querySelector('[data-settings-pane="overview"]')).toBeNull()
})

it('keeps empty and whitespace queries on Overview, then searches the original sections without resetting Clear to Overview', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const search = connected<HTMLInputElement>('[aria-label="Search settings"]')
  expect(overviewIsShown()).toBe(true)
  await input('[aria-label="Search settings"]', '   ')
  expect(overviewIsShown()).toBe(true)
  expect(mountedPanes()).toEqual([])
  await input('[aria-label="Search settings"]', 'font')
  const appearance = pane('appearance')
  expect(appearance.hidden).toBe(false)
  expect(overviewIsShown()).toBe(false)
  expect([...dom.container.querySelectorAll('nav[aria-label="Settings sections"] button:not([data-settings-overview-nav])')]
    .map(node => node.textContent)).toEqual(['Appearance'])
  await input('[aria-label="Terminal font size in pixels"]', '19')
  const clear = connected<HTMLButtonElement>('[aria-label="Clear settings search"]')
  clear.focus()
  await act(async () => clear.click())
  expect(document.activeElement).toBe(search)
  expect(search.value).toBe('')
  expect(pane('appearance')).toBe(appearance)
  expect(appearance.hidden).toBe(false)
  expect(connected<HTMLInputElement>('[aria-label="Terminal font size in pixels"]').value).toBe('19')
  expect(overviewIsShown()).toBe(false)
})

it('external section and same-section Executor re-entry clear a stale query and reach the exact object', async () => {
  const base = useAppStore.getState().config!
  useAppStore.setState({ config: { ...base, executors: {
    review: { ...base.executors.codex!, label: 'Reviewer' },
    build: { ...base.executors.codex!, label: 'Builder' }
  } } })
  const close = vi.fn()
  await dom.render(<SettingsPanel onClose={close} />)
  await input('[aria-label="Search settings"]', 'font')
  expect(pane('appearance').hidden).toBe(false)
  await dom.render(<SettingsPanel onClose={close} initialSection="general" />)
  expect(connected<HTMLInputElement>('[aria-label="Search settings"]').value).toBe('')
  expect(pane('general').hidden).toBe(false)
  await input('[aria-label="Search settings"]', 'host')
  await dom.render(<SettingsPanel onClose={close} initialSection="agents" executorId="review" />)
  expect(connected<HTMLInputElement>('[aria-label="Search settings"]').value).toBe('')
  expect(pane('agents').hidden).toBe(false)
  const review = connected<HTMLDetailsElement>('#executor-settings-review')
  const build = connected<HTMLDetailsElement>('#executor-settings-build')
  expect(review.open).toBe(true)
  expect(build.open).toBe(false)
  expect(document.activeElement).toBe(connected('input[data-executor-name]', review))
  await input('[aria-label="Search settings"]', 'font')
  await dom.render(<SettingsPanel onClose={close} initialSection="agents" executorId="build" />)
  expect(connected<HTMLInputElement>('[aria-label="Search settings"]').value).toBe('')
  expect(pane('agents').hidden).toBe(false)
  expect(connected<HTMLDetailsElement>('#executor-settings-build')).toBe(build)
  expect(build.open).toBe(true)
  expect(document.activeElement).toBe(connected('input[data-executor-name]', build))
  expect(overviewIsShown()).toBe(false)
  expect(close).not.toHaveBeenCalled()
})

it('preserves actual Appearance and General draft controls and scroll positions across Overview', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} />)
  await section('Appearance')
  const appearance = pane('appearance')
  const font = connected<HTMLInputElement>('[aria-label="Terminal font size in pixels"]', appearance)
  await input('[aria-label="Terminal font size in pixels"]', '19')
  appearance.scrollTop = 137
  await returnToOverview()
  expect(appearance.hidden).toBe(true)
  expect(appearance.inert).toBe(true)
  await section('General')
  const general = pane('general')
  const toggle = connected<HTMLInputElement>('input[type="checkbox"]', general)
  await act(async () => toggle.click())
  general.scrollTop = 91
  await returnToOverview()
  expect(general.hidden).toBe(true)
  expect(general.inert).toBe(true)
  await section('Appearance')
  expect(pane('appearance')).toBe(appearance)
  expect(connected('[aria-label="Terminal font size in pixels"]', appearance)).toBe(font)
  expect(font.value).toBe('19')
  expect(appearance.scrollTop).toBe(137)
  expect(connected('[data-settings-save-bar]', appearance).textContent).toContain('Unsaved changes')
  await returnToOverview()
  await section('General')
  expect(pane('general')).toBe(general)
  expect(connected('input[type="checkbox"]', general)).toBe(toggle)
  expect(toggle.checked).toBe(true)
  expect(general.scrollTop).toBe(91)
  expect(connected('[data-settings-save-bar]', general).textContent).toContain('Unsaved changes')
  expect(mountedPanes()).toEqual(['appearance', 'general'])
  expect(save).not.toHaveBeenCalled()
  expect(useAppStore.getState().detectExecutors).not.toHaveBeenCalled()
  expect(useAppStore.getState().checkHost).not.toHaveBeenCalled()
})

it('summarizes saved Appearance values rather than the visited pane draft, and updates only when config changes', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const row = connected('[data-settings-section="appearance"]', overview())
  const savedSummary = row.textContent
  expect(savedSummary).toMatch(/\b15\s?px\b/)
  await act(async () => row.click())
  await input('[aria-label="Terminal font size in pixels"]', '19')
  await returnToOverview()
  const returned = connected('[data-settings-section="appearance"]', overview())
  expect(returned.textContent).toBe(savedSummary)
  const current = useAppStore.getState().config!
  await act(async () => useAppStore.getState().setConfig({ ...current,
    appearance: { ...current.appearance, terminalFontSize: 21, appAppearance: 'light' }
  }))
  expect(returned.textContent).toMatch(/\b21\s?px\b/)
  expect(returned.textContent).not.toBe(savedSummary)
  await act(async () => returned.click())
  expect(connected<HTMLInputElement>('[aria-label="Terminal font size in pixels"]').value).toBe('19')
  expect(save).not.toHaveBeenCalled()
  expect(useAppStore.getState().detectExecutors).not.toHaveBeenCalled()
  expect(useAppStore.getState().checkHost).not.toHaveBeenCalled()
})

it('uses the canonical defaults in the saved summary when optional Appearance settings are absent', async () => {
  const current = useAppStore.getState().config!
  useAppStore.setState({ config: { ...current, appearance: composerConfig.appearance } })
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const row = connected('[data-settings-section="appearance"]', overview())
  expect(row.textContent).toContain(`${TERMINAL_FONT_SIZE_DEFAULT}px`)
  expect(row.textContent?.toLowerCase()).toContain(APP_APPEARANCE_DEFAULT)
  await act(async () => row.click())
  expect(connected<HTMLInputElement>('[aria-label="Terminal font size in pixels"]').value).toBe(String(TERMINAL_FONT_SIZE_DEFAULT))
  const checked = connected<HTMLInputElement>('[aria-label="Application appearance"] input:checked')
  expect(checked.value).toBe(APP_APPEARANCE_DEFAULT)
})

it('the real Avatar settings action enters the matching Executor through App and can retarget within Agents', async () => {
  const base = useAppStore.getState().config!
  useAppStore.setState({ config: { ...base, executors: {
    review: { ...base.executors.codex!, label: 'Reviewer' },
    build: { ...base.executors.codex!, label: 'Builder' }
  } } })
  await dom.render(<App />)
  const before = useAppStore.getState()
  await openExecutor(connected('.workspace-workbench-registry [data-executor-id="review"]'), 'Reviewer')
  expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe('Agents')
  expect(mountedPanes()).toEqual(['agents'])
  expect(connected<HTMLDetailsElement>('#executor-settings-review').open).toBe(true)
  const build = connected<HTMLDetailsElement>('#executor-settings-build')
  expect(build.open).toBe(false)
  await openExecutor(connected('[data-executor-id="build"]', build), 'Builder')
  expect(connected<HTMLDetailsElement>('#executor-settings-build')).toBe(build)
  expect(build.open).toBe(true)
  expect(document.activeElement).toBe(connected('input[data-executor-name]', build))
  expect(overviewIsShown()).toBe(false)
  await dom.click('[aria-label="Close settings"]')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
