// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
async function input(selector: string, value: string) {
  const element = dom.container.querySelector<HTMLInputElement>(selector)!
  expect(element?.isConnected).toBe(true)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function general() {
  const pane = dom.container.querySelector<HTMLElement>('[data-settings-pane="general"]')!
  expect(pane?.isConnected).toBe(true)
  expect(pane.hidden).toBe(false)
  expect(pane.inert).toBe(false)
  expect([...pane.querySelectorAll('dt')].map(node => node.textContent)).toContain('Session recovery')
  expect(pane.textContent).toContain('Your tabs and layouts are restored when you return. Running agents stay available when the desktop window closes.')
  expect(pane.textContent).toContain('Crashes are recorded to a local file and never uploaded.')
  const buttons = [...pane.querySelectorAll<HTMLButtonElement>('button')]
  expect(buttons.map(node => node.textContent)).toEqual(['Show crash log'])
  expect(buttons[0]!.isConnected).toBe(true)
  expect(buttons[0]!.disabled).toBe(false)
  return pane
}

it.each(['crash', 'log', 'recovery', 'crash log', 'Show crash log', 'Session recovery', '  sHoW cRaSh LoG  '])(
  'finds the original General content through the mounted search input: %s', async query => {
    const reveal = vi.spyOn(api.ui, 'revealCrashLog')
    const close = vi.fn()
    await dom.render(<SettingsPanel onClose={close} initialSection="appearance" />)
    await input('[aria-label="Terminal font size in pixels"]', '18')
    const appearance = dom.container.querySelector<HTMLElement>('[data-settings-pane="appearance"]')!
    appearance.scrollTop = 123
    const before = useAppStore.getState()
    await input('[aria-label="Search settings"]', 'diagnostics')
    const original = general()
    await input('[aria-label="Search settings"]', query)
    expect([...dom.container.querySelectorAll('nav[aria-label="Settings sections"] button')].map(node => node.textContent)).toEqual(['General'])
    expect([...dom.container.querySelectorAll<HTMLElement>('[data-settings-pane]')].filter(node => !node.hidden && !node.inert).map(node => node.dataset.settingsPane)).toEqual(['general'])
    expect(dom.container.querySelector('.settings-nav-empty')).toBeNull()
    expect(general()).toBe(original)
    expect(reveal).not.toHaveBeenCalled()
    await dom.click('[aria-label="Clear settings search"]')
    const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
    expect(document.activeElement).toBe(search)
    expect(search.value).toBe('')
    await input('[aria-label="Search settings"]', 'host')
    expect(dom.container.querySelector('.settings-content__header h2')!.textContent).toBe('Hosts')
    await dom.click('[aria-label="Clear settings search"]')
    const button = [...dom.container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings sections"] button')].find(node => node.textContent === 'Appearance')!
    expect(button.isConnected).toBe(true)
    await act(async () => button.click())
    expect(dom.container.querySelector('[data-settings-pane="appearance"]')).toBe(appearance)
    expect(appearance.hidden).toBe(false)
    expect(appearance.scrollTop).toBe(123)
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal font size in pixels"]')!.value).toBe('18')
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(close).not.toHaveBeenCalled()
  }
)
