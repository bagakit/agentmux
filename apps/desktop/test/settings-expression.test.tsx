// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: { ...composerConfig, copyPathsAsAbsolute: false,
  profile: { displayName: 'Alex', about: 'Keep the context.', avatar: 'data:image/png;base64,YQ==', shareWithAgents: true },
  appearance: { terminalTheme: 'graphite', terminalFontSize: 17, appAppearance: 'dark' } }, loading: false,
  detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) }))
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = dom.container.querySelector<T>(selector)
  expect(found, selector).not.toBeNull()
  return found!
}
async function input(selector: string, value: string) {
  const field = node<HTMLInputElement>(selector)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function button(label: string) {
  const found = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
  expect(found, label).toBeDefined()
  await act(async () => found!.click())
}
const section = (id: string) => dom.click(`nav [data-settings-target="${id}"]`)

it('Overview explains saved appearance and ignores a retained unsaved editor draft', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const summary = () => node('[data-settings-shortcut="appearance"] small').textContent
  expect(summary()).toContain('17px')
  await section('appearance')
  await input('[aria-label="Terminal font size in pixels"]', '19')
  await section('overview')
  expect(summary()).toContain('17px')
  expect(summary()).not.toContain('19px')
  await section('appearance')
  expect(node<HTMLInputElement>('[aria-label="Terminal font size in pixels"]').value).toBe('19')
  expect(save).not.toHaveBeenCalled()
})

it('Profile photo removal preserves the other identity fields and waits for Save', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="profile" />)
  expect(node('[data-settings-field="profile-photo"] img')).toBeDefined()
  await button('Remove photo')
  expect(dom.container.querySelector('[data-settings-field="profile-photo"] img')).toBeNull()
  await section('overview'); await section('profile')
  expect(node<HTMLInputElement>('[aria-label="Display name"]').value).toBe('Alex')
  expect(node<HTMLTextAreaElement>('[aria-label="About you and how you work"]').value).toBe('Keep the context.')
  expect(node<HTMLInputElement>('[data-settings-field="profile-sharing"] input').checked).toBe(true)
  expect(dom.container.querySelector('[data-settings-field="profile-photo"] img')).toBeNull()
  expect(save).not.toHaveBeenCalled()
})

it('General path preview follows the original checkbox while the saved summary remains unchanged', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="general" />)
  expect(node('[aria-label="Project path draft preview"]').dataset.pathFormat).toBe('abbreviated')
  await dom.click('[data-settings-field="copy-paths"] input')
  expect(node('[aria-label="Project path draft preview"]').dataset.pathFormat).toBe('absolute')
  expect(node('[data-settings-field="copy-paths"] header').textContent).toContain('Saved: Abbreviated')
  await section('overview'); await section('general')
  expect(node('[aria-label="Project path draft preview"]').dataset.pathFormat).toBe('absolute')
  expect(save).not.toHaveBeenCalled()
})

it('Notification dwell keeps a single keyboard control with a matching label, preview and sound boundary', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="notifications" />)
  expect(dom.container.querySelectorAll('[data-settings-pane="notifications"] input[type="range"]')).toHaveLength(1)
  await input('[aria-label="Notification dwell"]', '0')
  expect(node('[aria-label="Notification preview"]').dataset.notificationMode).toBe('off')
  expect(node('.notification-dwell__tick[data-selected]').textContent).toBe('Off')
  expect(node<HTMLInputElement>('.notification-sound-toggle input').disabled).toBe(true)
  await input('[aria-label="Notification dwell"]', '1')
  expect(node('[aria-label="Notification preview"]').dataset.notificationMode).toBe('brief')
  expect(node('.notification-dwell__tick[data-selected]').textContent).toContain('Brief')
  expect(node<HTMLInputElement>('.notification-sound-toggle input').disabled).toBe(false)
  expect(save).not.toHaveBeenCalled()
})

it('Survey loads only requested image drafts, removes stale previews and lets a failed image retry', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="survey" />)
  const source = 'https://example.invalid/survey.png'
  await input('[aria-label="Start page icon"]', source)
  expect(dom.container.querySelector('.settings-survey__icon')).toBeNull()
  await button('Preview images')
  const original = node<HTMLImageElement>('.settings-survey__icon')
  expect(original.src).toBe(source)
  expect(original.referrerPolicy).toBe('no-referrer')
  await act(async () => original.dispatchEvent(new Event('error')))
  expect(original.hidden).toBe(true)
  expect(node('.settings-survey__image-notice').textContent).toContain('could not load')
  await button('Preview images')
  expect(node<HTMLImageElement>('.settings-survey__icon')).not.toBe(original)
  expect(node<HTMLImageElement>('.settings-survey__icon').hidden).toBe(false)
  await input('[aria-label="Start page icon"]', 'https://example.invalid/changed.png')
  expect(dom.container.querySelector('.settings-survey__icon')).toBeNull()
  await input('[aria-label="Start page icon"]', 'invalid-image')
  await button('Preview images')
  expect(dom.container.querySelector('.settings-survey__icon')).toBeNull()
  expect(node('.settings-survey__image-notice').textContent).toContain('Your draft is kept')
  expect(node<HTMLInputElement>('[aria-label="Start page icon"]').value).toBe('invalid-image')
  expect(save).not.toHaveBeenCalled()
})
