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
  const pane = section('browser', 'Browser', 'Manage browser resources and agent access.')
  expect(pane.querySelector('.settings-lead')).toBeNull()
  expect([...pane.querySelectorAll('.settings-browser__preferences > .settings-group')].map(node => node.getAttribute('data-settings-field'))).toEqual(['agent-automation', 'automatic-memory-release', 'exit-check'])
  expect(pane.querySelectorAll('.app-link-scheme-list')).toHaveLength(remembered ? 1 : 0)
  expect(pane.querySelector('.settings-group header span')!.textContent).toBe('Agent automation')
  expect(pane.querySelector('.settings-group header small')!.textContent).toBe('Saved: Off')
  expect(pane.querySelectorAll('input[type=checkbox]')).toHaveLength(2)
  expect(pane.querySelector('label strong')!.textContent).toBe('Let agents interact with browser pages')
  expect(pane.querySelector('label small')!.textContent).toBe('Read pages, follow links and submit forms in all open browsers.')
  expect(pane.querySelector('.settings-browser__permission-note')!.textContent).toBe('Uses your signed-in accounts, including actions that spend money. Off by default.')
  if (remembered) {
    expect(pane.querySelector('.app-link-scheme-list')!.closest('section')!.querySelector('.settings-group-note')!.textContent!.trim()).toBe('Your choices apply to each link type across all sites. Forget a choice to be asked again next time.')
    expect(pane.querySelectorAll('.app-link-scheme-list li')).toHaveLength(2)
    expect(pane.querySelectorAll('.app-link-scheme-list button')).toHaveLength(2)
  }
  await dom.click('input[type=checkbox]')
  expect(pane.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true)
  expect(pane.querySelector('.settings-group header small')!.textContent).toBe('Saved: Off')
  expect(pane.querySelector('[data-settings-save-bar] [role=status]')!.textContent).toBe('Unsaved changes')
  expect(save).not.toHaveBeenCalled()
})

it('Notifications retains its complete trigger conditions and real controls', async () => {
  await dom.render(<SettingsPanel initialSection="notifications" onClose={() => {}} />)
  const pane = section('notifications', 'Notifications', 'Desktop banner duration and sound. In-app issues and Focus requests stay available.')
  expect(pane.querySelector('.settings-hint')!.textContent).toContain('Current issues in the notification center and requests in Focus stay available when banners are off')
  expect(pane.querySelectorAll('input[type=range]')).toHaveLength(1)
  expect(pane.querySelectorAll('input[type=checkbox]')).toHaveLength(1)
  expect(pane.querySelector('[aria-label="Desktop banner preview"]')!.isConnected).toBe(true)
})

it.each([false, true])('Prompts retains usage and user decision with resources=%s', async resources => {
  useAppStore.setState({ config: { ...composerConfig, composerShortcuts: resources
    ? [{ id: 'read', keyword: 'read', label: 'Read', body: 'Read the selected text.' }] : [] } })
  await dom.render(<SettingsPanel initialSection="prompts" onClose={() => {}} />)
  const pane = section('prompts', 'Prompts', 'Keep your everyday instructions close at hand.')
  expect(pane.querySelectorAll('.settings-lead')).toHaveLength(0)
  expect([...pane.querySelectorAll('.settings-pane-toolbar button')].map(node => node.textContent!.trim())).toEqual(['Add prompt', 'Add quick replies'])
  expect(pane.querySelectorAll('[data-prompt-id]')).toHaveLength(resources ? 1 : 0)
  if (resources) {
    await dom.click('[data-prompt-id="read"]')
    expect(pane.querySelector('[aria-label="Usage preview"]')!.textContent).toContain('add your instruction to a draft instead of sending')
    expect(pane.querySelector('[aria-label="Usage preview"] code')!.textContent).toBe('/read · read')
  } else {
    expect(pane.querySelectorAll('[data-prompt-starting-point]').length).toBeGreaterThan(0)
    expect(pane.querySelector('.settings-starting-points__note')!.textContent).toBe('Examples open as unsaved drafts. You choose when to save or send them.')
  }
})
