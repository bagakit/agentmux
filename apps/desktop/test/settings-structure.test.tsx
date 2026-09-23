// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => {
  useAppStore.setState({ loading: false, mainSurface: 'workbench',
    config: { ...composerConfig, copyPathsAsAbsolute: false },
    detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) })
})

async function section(title: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings sections"] button')]
    .find(node => node.textContent === title)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

it('renders eight daily-preference/resource entries and opens Appearance by default', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect([...dom.container.querySelectorAll('nav[aria-label="Settings sections"] p')].map(node => node.textContent))
    .toEqual(['Preferences', 'Resources'])
  expect([...dom.container.querySelectorAll('nav[aria-label="Settings sections"] button')].map(node => node.textContent))
    .toEqual(['Appearance', 'Notifications', 'Browser', 'General', 'Agents', 'Prompts', 'Workspaces', 'Hosts'])
  expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe('Appearance')
  const pane = dom.container.querySelector<HTMLElement>('[data-settings-pane="appearance"]')!
  expect(pane.isConnected).toBe(true)
  expect([...pane.querySelectorAll('.settings-group > header > span')].map(node => node.textContent))
    .toEqual(['Application appearance', 'Terminal font size', 'Terminal palette'])
  expect(dom.container.querySelector('[data-settings-pane="copy-paths"]')).toBeNull()
})

it('ordinary settings entry targets Appearance through the actual SurfaceSwitch control', async () => {
  const open = vi.fn()
  await dom.render(<SurfaceSwitch onOpenSettings={open} />)
  await dom.click('[aria-label="Settings"]')
  expect(open).toHaveBeenCalledExactlyOnceWith('appearance')
})

it('General saves only copied paths through the existing config owner with its captured expected value', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="general" />)
  const current = useAppStore.getState().config!
  const pane = dom.container.querySelector<HTMLElement>('[data-settings-pane="general"]')!
  expect(pane.querySelectorAll('[data-settings-save-bar]')).toHaveLength(1)
  expect(pane.querySelector('.settings-diagnostics button')?.textContent).toBe('Show crash log')
  expect(pane.querySelector('.settings-diagnostics [data-settings-save-bar]')).toBeNull()
  const toggle = pane.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(toggle.isConnected).toBe(true)
  await act(async () => toggle.click())
  const button = pane.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...current, copyPathsAsAbsolute: true }, { ...current, copyPathsAsAbsolute: false })
})

it('General preserves its dirty draft and original mounted control across section changes', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="general" />)
  const pane = dom.container.querySelector<HTMLElement>('[data-settings-pane="general"]')!
  const toggle = pane.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(toggle.isConnected).toBe(true)
  await act(async () => toggle.click())
  expect(toggle.checked).toBe(true)
  await section('Appearance')
  expect(pane.hidden).toBe(true)
  expect(pane.inert).toBe(true)
  await section('General')
  expect(dom.container.querySelector('[data-settings-pane="general"]')).toBe(pane)
  expect(pane.querySelector('input[type="checkbox"]')).toBe(toggle)
  expect(toggle.checked).toBe(true)
  expect(pane.querySelector('[data-settings-save-bar]')?.textContent).toContain('Unsaved changes')
  expect(dom.container.querySelector('[data-settings-pane="hosts"]')).toBeNull()
})
