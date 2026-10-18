// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { getThemeCatalog } from '@agentmux/client-ui/theme'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { NOTIFICATION_TIERS } from '../src/shared/notification-presentation'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: composerConfig, loading: false }))

it('the original Appearance pane follows the selected theme with its complete description and retains the draft', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(composerConfig)
  const close = () => {}
  await dom.render(<SettingsPanel initialSection="appearance" onClose={close} />)
  const themes = getThemeCatalog(composerConfig.appearance.customThemes).items
  expect(themes.length).toBeGreaterThan(1)
  const choice = themes[1]!
  await dom.click(`input[name][value="${choice.id}"]`)
  const summary = dom.container.querySelector('[data-theme-description]')!
  expect(summary?.getAttribute('data-theme-description')).toBe(choice.id)
  expect(summary.textContent).toContain(choice.value.description)
  expect(dom.container.querySelectorAll('[data-theme-description]')).toHaveLength(1)
  await dom.render(<SettingsPanel initialSection="overview" onClose={close} />)
  await dom.render(<SettingsPanel initialSection="appearance" onClose={close} />)
  expect(dom.container.querySelector('[data-theme-description]')).toBe(summary)
  expect(summary.textContent).toContain(choice.value.description)
  expect(dom.container.querySelector('[data-settings-save-bar]')?.textContent).toContain('Unsaved changes')
  expect(save).not.toHaveBeenCalled()
})

it('the original Notifications preview distinguishes a changed draft and the off choice without saving', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(composerConfig)
  await dom.render(<SettingsPanel initialSection="notifications" onClose={() => {}} />)
  const preview = dom.container.querySelector<HTMLElement>('[aria-label="Desktop banner preview"]')!
  expect(preview.textContent).toContain('Example desktop banner')
  expect(preview.textContent).toContain('Saved settings')
  const range = dom.container.querySelector<HTMLInputElement>('[aria-label="Desktop banner duration"]')!
  const off = NOTIFICATION_TIERS.findIndex(tier => tier.id === 'off')
  expect(off).toBeGreaterThanOrEqual(0)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, String(off))
    range.dispatchEvent(new Event('input', { bubbles: true }))
    range.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(preview.dataset.notificationMode).toBe('off')
  expect(preview.textContent).toContain('Unsaved preview')
  expect(preview.textContent).toContain('Agent status banners are off')
  expect(dom.container.querySelector<HTMLInputElement>('.notification-sound-toggle input')!.disabled).toBe(true)
  expect(save).not.toHaveBeenCalled()
})
