// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { SettingsPanel, visibleSettingsSections } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: composerConfig, loading: false,
  detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) }))
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = dom.container.querySelector<T>(selector)
  expect(found, selector).not.toBeNull()
  expect(found!.isConnected).toBe(true)
  return found!
}
async function query(value: string) {
  const input = node<HTMLInputElement>('[aria-label="Search settings"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const group = (id: string) => node<HTMLButtonElement>(`[data-settings-group-toggle="${id}"]`)

it('priority entries reach the same original editor and never write configuration', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const shortcuts = [...dom.container.querySelectorAll<HTMLElement>('[data-settings-shortcut]')]
  expect(shortcuts.map(item => item.dataset.settingsShortcut)).toEqual(['appearance', 'agents', 'prompts'])
  const directory = node('[data-settings-directory]')
  expect([...directory.querySelectorAll<HTMLElement>('[data-settings-section]')].map(item => item.dataset.settingsSection))
    .toEqual(visibleSettingsSections('').map(item => item.id))
  expect(dom.container.querySelectorAll('[data-settings-pane]')).toHaveLength(0)
  for (const shortcut of shortcuts) {
    const id = shortcut.dataset.settingsShortcut!
    await dom.click(`[data-settings-shortcut="${id}"]`)
    const editor = node(`[data-settings-pane="${id}"]`)
    expect(editor.hidden).toBe(false)
    expect(editor.inert).toBe(false)
    await dom.click('[data-settings-overview-nav]')
    await dom.click(`[data-settings-directory] [data-settings-section="${id}"]`)
    expect(node(`[data-settings-pane="${id}"]`)).toBe(editor)
    await dom.click('[data-settings-overview-nav]')
  }
  expect(save).not.toHaveBeenCalled()
})

it('search temporarily reveals matching groups without replacing the chosen expansion state', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect(group('preferences').getAttribute('aria-expanded')).toBe('true')
  expect(group('message-tool').getAttribute('aria-expanded')).toBe('true')
  await act(async () => group('message-tool').click())
  await act(async () => group('preferences').click())
  expect(group('preferences').getAttribute('aria-expanded')).toBe('false')
  await query('font')
  expect(node('nav [data-settings-target="appearance"]').closest('[hidden], [inert]')).toBeNull()
  await dom.click('[aria-label="Clear settings search"]')
  expect(group('preferences').getAttribute('aria-expanded')).toBe('false')
  expect(group('message-tool').getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(node('[aria-label="Search settings"]'))
})

it('explicit navigation reveals a collapsed destination while keeping the existing draft', async () => {
  const onClose = vi.fn()
  await dom.render(<SettingsPanel onClose={onClose} initialSection="general" />)
  const toggle = node<HTMLInputElement>('[data-settings-pane="general"] input[type="checkbox"]')
  await act(async () => toggle.click())
  const draft = toggle.checked
  await act(async () => group('remote').click())
  expect(group('remote').getAttribute('aria-expanded')).toBe('false')
  await dom.render(<SettingsPanel onClose={onClose} initialSection="hosts" />)
  expect(group('remote').getAttribute('aria-expanded')).toBe('true')
  expect(node('nav [data-settings-target="hosts"]').getAttribute('aria-current')).toBe('page')
  await dom.render(<SettingsPanel onClose={onClose} initialSection="general" />)
  expect(node('[data-settings-pane="general"] input[type="checkbox"]')).toBe(toggle)
  expect(toggle.checked).toBe(draft)
  expect(onClose).not.toHaveBeenCalled()
})

it('visiting a search result and returning preserves both destination and origin group disclosure choices', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="general" />)
  const original = node('[data-settings-pane="general"]')
  await act(async () => group('preferences').click())
  expect(group('preferences').getAttribute('aria-expanded')).toBe('false')
  await act(async () => group('message-tool').click())
  expect(group('message-tool').getAttribute('aria-expanded')).toBe('false')
  await query('prompt')
  await dom.click('[data-settings-search-section="prompts"]')
  expect(node('[data-settings-pane="prompts"]').hidden).toBe(false)
  await dom.click('[aria-label="Clear settings search"]')
  expect(node('[data-settings-pane="general"]')).toBe(original)
  expect(original.hidden).toBe(false)
  expect(group('preferences').getAttribute('aria-expanded')).toBe('false')
  expect(group('message-tool').getAttribute('aria-expanded')).toBe('false')
})

it('an external exact route during a search visit reveals the new destination group', async () => {
  const onClose = vi.fn()
  await dom.render(<SettingsPanel onClose={onClose} />)
  await query('prompt')
  await dom.click('[data-settings-search-section="prompts"]')
  expect(node('[data-settings-pane="prompts"]').hidden).toBe(false)
  await dom.render(<SettingsPanel onClose={onClose} initialSection="hosts" />)
  expect(node<HTMLInputElement>('[aria-label="Search settings"]').value).toBe('')
  expect(node('[data-settings-pane="hosts"]').hidden).toBe(false)
  expect(group('remote').getAttribute('aria-expanded')).toBe('true')
  expect(node('nav [data-settings-target="hosts"]').getAttribute('aria-current')).toBe('page')
})

it('every sidebar group starts expanded with Agent CLIs and Session recovery together', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const toggles = [...dom.container.querySelectorAll('[data-settings-group-toggle]')]
  expect(toggles.length).toBeGreaterThan(0)
  expect(toggles.every(toggle => toggle.getAttribute('aria-expanded') === 'true')).toBe(true)
  const entries = [...dom.container.querySelectorAll<HTMLElement>('nav [data-settings-target]')]
  expect(entries.map(entry => entry.dataset.settingsTarget)).toEqual(['overview', ...visibleSettingsSections('').map(item => item.id)])
  expect(entries.every(entry => !entry.closest('[hidden]'))).toBe(true)
  expect(group('agents').getAttribute('aria-expanded')).toBe('true')
  expect([...node('#settings-nav-agents').querySelectorAll<HTMLElement>('[data-settings-target]')].map(item => item.dataset.settingsTarget)).toEqual(['agents', 'continuity'])
  expect([...node('[data-settings-directory] [data-settings-group="agents"]').querySelectorAll('[data-settings-section]')].map(item => item.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Agent CLIs'), expect.stringContaining('Session recovery')]))
  expect([...dom.container.querySelectorAll('[data-settings-group-toggle]')].slice(0,2).map(item => item.textContent)).toEqual(['Preferences','Agents'])
  expect(node('nav [data-settings-target="hosts"]').textContent).toBe('Hosts')
  expect(node('nav [data-settings-target="agents"]').textContent).toBe('Agent CLIs')
  expect(node('nav [data-settings-target="continuity"]').textContent).toBe('Session recovery')
  expect(dom.container.querySelector('[data-standalone]')).toBeNull()
  expect(dom.container.querySelector('nav')!.textContent).not.toMatch(/Resources|Environments/)
})

it('an exact field search reveals its original advanced disclosure and keeps the draft', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="continuity" />)
  const details = node<HTMLDetailsElement>('[data-continuity-retry-settings]')
  const field = node<HTMLElement>('[data-settings-field="retryMaxAttempts"]')
  const input = node<HTMLInputElement>('[aria-label="Additional retries"]')
  expect(details.open).toBe(false)
  await query('Additional retries')
  await dom.click('[data-settings-search-result="continuity:retryMaxAttempts"]')
  expect(node('[data-settings-field="retryMaxAttempts"]')).toBe(field)
  expect(details.open).toBe(true)
  expect(document.activeElement).toBe(field)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '7')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await dom.click('[aria-label="Clear settings search"]')
  expect(node('[aria-label="Additional retries"]')).toBe(input)
  expect(input.value).toBe('7')
  expect(details.open).toBe(true)
  await query('execution')
  expect(node('[data-settings-search-section="continuity"] strong').textContent).toBe('Session recovery')
  await dom.click('[data-settings-search-section="continuity"]')
  await dom.click('[aria-label="Clear settings search"]')
  expect(node('[aria-label="Additional retries"]')).toBe(input)
  expect(input.value).toBe('7')
  await query('agents')
  expect(node('[data-settings-search-section="agents"] strong').textContent).toBe('Agent CLIs')
  await dom.click('[data-settings-search-section="agents"]')
  expect(node('.settings-content__header h2').textContent).toBe('Agent CLIs')
  await dom.click('[aria-label="Clear settings search"]')
  expect(node('[aria-label="Additional retries"]')).toBe(input)
  expect(input.value).toBe('7')
  expect(group('agents').getAttribute('aria-expanded')).toBe('true')
  expect(save).not.toHaveBeenCalled()
})
