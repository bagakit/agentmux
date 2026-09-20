// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { SettingsPanel, type SettingsSectionId } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
function section(id: SettingsSectionId, title: string, description: string) {
  const header = dom.container.querySelector('.settings-content__header')!
  const pane = dom.container.querySelector(`[data-settings-pane="${id}"]`)!
  expect(header.isConnected).toBe(true)
  expect(pane.isConnected).toBe(true)
  expect(pane.hasAttribute('hidden')).toBe(false)
  expect(header.querySelectorAll('h2')).toHaveLength(1)
  expect(header.querySelector('h2')!.textContent).toBe(title)
  expect(header.querySelectorAll('p')).toHaveLength(1)
  expect(header.querySelector('p')!.textContent).toBe(description)
  return pane
}

it.each([false, true])('Browser has one introduction and preserves full scope with remembered=%s', async remembered => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(composerConfig)
  useAppStore.setState({ config: { ...composerConfig, browser: { ...composerConfig.browser,
    appLinkSchemes: remembered ? { 'tool-a': 'allow', 'tool-b': 'deny' } : {} } } })
  await dom.render(<SettingsPanel initialSection="browser" onClose={() => {}} />)
  const pane = section('browser', 'Browser', 'Choose how agents interact with your pages.')
  expect(pane.querySelector('.settings-lead')).toBeNull()
  expect(pane.querySelectorAll('.settings-group')).toHaveLength(remembered ? 2 : 1)
  expect(pane.querySelector('.settings-group header span')!.textContent).toBe('Agent automation')
  expect(pane.querySelector('.settings-group header small')!.textContent).toBe('Saved: Off')
  expect(pane.querySelectorAll('input[type=checkbox]')).toHaveLength(1)
  expect(pane.querySelector('label strong')!.textContent).toBe('Let agents interact with browser pages')
  expect(pane.querySelector('label small')!.textContent).toBe('Off by default. When enabled, agents can read pages, follow links and submit forms using your signed-in accounts, including actions that spend money. This applies to all open browsers.')
  if (remembered) {
    expect(pane.querySelector('.settings-group-note')!.textContent!.trim()).toBe('Your choices apply to each link type across all sites. Forget a choice to be asked again next time.')
    expect(pane.querySelectorAll('.app-link-scheme-list li')).toHaveLength(2)
    expect(pane.querySelectorAll('.app-link-scheme-list button')).toHaveLength(2)
  }
  await dom.click('input[type=checkbox]')
  expect(pane.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true)
  expect(pane.querySelector('.settings-group header small')!.textContent).toBe('Saved: Off')
  expect(pane.querySelector('[role=status]')!.textContent).toBe('Unsaved changes')
  expect(save).not.toHaveBeenCalled()
})

it('Notifications retains its complete trigger conditions and real controls', async () => {
  await dom.render(<SettingsPanel initialSection="notifications" onClose={() => {}} />)
  const pane = section('notifications', 'Notifications', 'Choose when and how agents get your attention.')
  expect(pane.querySelectorAll('.settings-lead')).toHaveLength(1)
  expect(pane.querySelector('.settings-lead')!.textContent).toBe('Get a notification when an agent finishes, needs your attention or runs into trouble while you are elsewhere.')
  expect(pane.querySelectorAll('input[type=range]')).toHaveLength(1)
  expect(pane.querySelectorAll('input[type=checkbox]')).toHaveLength(1)
  expect(pane.querySelector('[aria-label="Notification preview"]')!.isConnected).toBe(true)
})

it.each([false, true])('Prompts retains usage and user decision with resources=%s', async resources => {
  useAppStore.setState({ config: { ...composerConfig, composerShortcuts: resources
    ? [{ id: 'read', keyword: 'read', label: 'Read', body: 'Read the selected text.' }] : [] } })
  await dom.render(<SettingsPanel initialSection="prompts" onClose={() => {}} />)
  const pane = section('prompts', 'Prompts', 'Keep your everyday instructions close at hand.')
  expect(pane.querySelectorAll('.settings-lead')).toHaveLength(1)
  expect(pane.querySelector('.settings-lead')!.textContent).toBe('Type / to choose one in the composer, or use its keyword in your draft. You decide what to send.')
  expect(pane.querySelector('.settings-lead code')!.textContent).toBe('/')
  expect(pane.querySelectorAll('.settings-pane-toolbar button')).toHaveLength(1)
  expect(pane.querySelector('.settings-pane-toolbar button')!.textContent!.trim()).toBe('Add prompt')
  expect(pane.querySelectorAll('.prompt-settings-card')).toHaveLength(resources ? 1 : 0)
  if (!resources) expect(pane.querySelector('.agent-catalog__empty')!.textContent).toBe('No prompts. Add one, or leave this empty — the composer just won’t offer any.')
})
