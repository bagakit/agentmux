// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
vi.mock('../src/renderer/src/components/GlobalFocusSurface', () => ({ GlobalFocusSurface: () => null }))
vi.mock('../src/renderer/src/components/GlobalSurveySurface', () => ({ GlobalSurveySurface: () => null }))
import { App } from '../src/renderer/src/App'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const font = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal font size in pixels"]')!
const opener = '.window-status-bar [aria-label="Settings"]'
const appearance = 'nav [data-settings-target="appearance"]'
beforeEach(() => {
  useAppStore.setState({ loading: false, mainSurface: 'workbench', initialize: vi.fn(async () => () => {}),
    detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}),
    hostChecks: { local: { state: 'ready', input: composerConfig.hosts[0]!, detail: 'Ready' } } })
})
async function enter(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(font(), value)
    font().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('retains the original App settings editor, scroll and unsaved value without writing', async () => {
  const save = vi.spyOn(api.config, 'save')
  await dom.render(<App />)
  await dom.click(opener)
  await dom.click(appearance)
  await enter('18')
  const editor = font(), pane = editor.closest<HTMLElement>('[data-settings-pane]')!
  pane.scrollTop = 91
  await dom.click('[aria-label="Close settings"]')
  expect(dom.container.querySelector<HTMLElement>('.settings-page')!.hidden).toBe(true)
  expect(dom.container.querySelector<HTMLElement>('.app-shell__workspace')!.inert).toBe(false)
  await dom.click(opener)
  await dom.click(appearance)
  expect(font()).toBe(editor)
  expect(font().value).toBe('18')
  expect(pane.scrollTop).toBe(91)
  expect(save).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-settings-pane="hosts"]')).toBeNull()
})

it('retains failed-save feedback and the original draft across close and explicit navigation', async () => {
  vi.spyOn(api.config, 'save').mockRejectedValue(new Error('Settings write unavailable'))
  await dom.render(<App />)
  await dom.click(opener)
  await dom.click(appearance)
  await enter('19')
  await dom.click('[data-settings-pane="appearance"] .settings-pane-actions .primary-button')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Settings write unavailable')
  await dom.click('[aria-label="Close settings"]')
  await dom.click(opener)
  await dom.click(appearance)
  expect(font().value).toBe('19')
  expect(dom.container.querySelector('[data-settings-pane="appearance"] [role="alert"]')?.textContent).toContain('Settings write unavailable')
})

it('silences a retained hidden shell and restores focus to each original opener', async () => {
  const close = vi.fn(), button = document.createElement('button')
  document.body.append(button)
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 20, 20))
  button.focus()
  await dom.render(<SettingsPanel visible initialSection="appearance" onClose={close} />)
  await dom.render(<SettingsPanel visible={false} initialSection="appearance" onClose={close} />)
  expect(document.activeElement).toBe(button)
  expect(dom.container.querySelector<HTMLElement>('.settings-page')!.inert).toBe(true)
  await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(close).not.toHaveBeenCalled()
  const second = document.createElement('button')
  document.body.append(second)
  vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 20, 20))
  second.focus()
  await dom.render(<SettingsPanel visible initialSection="appearance" onClose={close} />)
  await dom.render(<SettingsPanel visible={false} initialSection="appearance" onClose={close} />)
  expect(document.activeElement).toBe(second)
  button.remove()
  second.remove()
})

it('dismisses an original Host confirmation portal when its settings owner becomes hidden', async () => {
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts,
    { id: 'original-remote', kind: 'ssh', label: 'Original remote', hostname: 'remote.invalid' }] }, sessions: [] })
  const route = { section: 'hosts' as const, hostId: 'original-remote' }
  await dom.render(<SettingsPanel visible initialSection="hosts" navigationRequest={route} onClose={() => {}} />)
  await dom.click('[aria-label="Remove Original remote"]')
  expect(document.querySelector('[data-confirm-label="Remove Host"]')).not.toBeNull()
  await dom.render(<SettingsPanel visible={false} initialSection="hosts" navigationRequest={route} onClose={() => {}} />)
  expect(document.querySelector('[data-confirm-label="Remove Host"]')).toBeNull()
  await dom.render(<SettingsPanel visible initialSection="hosts" navigationRequest={route} onClose={() => {}} />)
  expect(document.querySelector('[data-confirm-label="Remove Host"]')).toBeNull()
})
