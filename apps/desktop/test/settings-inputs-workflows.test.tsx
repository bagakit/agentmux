// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { DEFAULT_USER_PROFILE } from '@agentmux/host/mote-model'

const dom = composerDOM()
const originalPrompt = { id: 'explain', label: 'Explain', keyword: 'explain', body: 'Explain the current work.' }

async function mount(section: 'profile' | 'prompts' | 'notes') {
  const f = await configOwnerFixture({
    profile: { ...DEFAULT_USER_PROFILE, displayName: 'Alex', about: 'Original context' },
    composerShortcuts: [originalPrompt]
  })
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(saved => { publish(saved); useAppStore.getState().setConfig(saved) })
  useAppStore.setState({ config: f.owner.current })
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected, next))
  await dom.render(<SettingsPanel initialSection={section} onClose={() => {}} />)
  return { ...f, uiSave: save }
}

function field<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(label: string) {
  const input = dom.container.querySelector<T>(`[aria-label="${label}"]`)
  expect(input, label).not.toBeNull()
  return input!
}

async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function description(input: Element) {
  return input.getAttribute('aria-describedby')?.split(' ').map(id => document.getElementById(id)?.textContent).join(' ')
}

it('edits the original Profile and sends its exact draft and expected profile through Settings', async () => {
  const f = await mount('profile')
  const name = field<HTMLInputElement>('Display name')
  const about = field<HTMLTextAreaElement>('About you and how you work')
  const sharing = field<HTMLInputElement>('Share with new agents')
  const save = dom.container.querySelector<HTMLButtonElement>('[data-settings-pane="profile"] [data-settings-save-bar] button')!
  expect(name.value).toBe('Alex')
  expect(description(about)).toContain('communication preferences')
  expect(sharing.type).toBe('checkbox')
  expect(sharing.getAttribute('role')).toBe('switch')
  await fill(name, 'Alex Chen')
  await fill(about, '内容保留\nOriginal line')
  await act(async () => sharing.click())
  expect(f.uiSave).not.toHaveBeenCalled()
  expect(save.disabled).toBe(false)
  await act(async () => { save.click(); await f.uiSave.mock.results[0]!.value })
  const [next, expected] = f.uiSave.mock.calls[0]!
  expect(expected.profile).toEqual({ ...DEFAULT_USER_PROFILE, displayName: 'Alex', about: 'Original context' })
  expect(next.profile).toEqual({ displayName: 'Alex Chen', about: '内容保留\nOriginal line', avatar: DEFAULT_USER_PROFILE.avatar, shareWithAgents: !DEFAULT_USER_PROFILE.shareWithAgents })
  expect((await f.disk()).profile).toEqual(next.profile)
})

it('uses the native Prompt scope and shared clear action with the remaining editor draft', async () => {
  const f = await mount('prompts')
  const query = field<HTMLInputElement>('Search prompts')
  const provider = field<HTMLSelectElement>('Prompt Provider scope')
  const body = dom.container.querySelector<HTMLTextAreaElement>('[data-prompt-editor] textarea')!
  const count = () => dom.container.querySelectorAll('[data-prompt-id]').length
  expect(query.type).toBe('search')
  expect(provider.tagName).toBe('SELECT')
  expect(description(provider)).toBe('Shared, or available to one Provider.')
  expect(count()).toBe(1)
  await fill(body, ' ')
  expect(body.getAttribute('aria-invalid')).toBe('true')
  expect(description(body)).toBeTruthy()
  await fill(query, 'no matching prompt')
  expect(count()).toBe(0)
  await dom.click('[aria-label="Clear prompt search"]')
  expect(document.activeElement).toBe(query)
  expect(count()).toBe(1)
  expect(body.value).toBe(' ')
  await fill(body, 'Explain what changed.\nThen verify it.')
  await act(async () => { provider.value = 'codex'; provider.dispatchEvent(new Event('change', { bubbles: true })) })
  const save = dom.container.querySelector<HTMLButtonElement>('[data-settings-pane="prompts"] [data-settings-save-bar] button')!
  await act(async () => { save.click(); await f.uiSave.mock.results[0]!.value })
  expect(f.uiSave.mock.calls[0]![1]!.composerShortcuts).toEqual([originalPrompt])
  expect((await f.disk()).composerShortcuts).toEqual([{ ...originalPrompt, providerId: 'codex', body: 'Explain what changed.\nThen verify it.' }])
})

it('keeps an invalid numeric Note preference editable and provides its field-specific cause', async () => {
  const f = await mount('notes')
  const size = field<HTMLInputElement>('Notes body text size')
  const slider = field<HTMLInputElement>('Adjust Notes body text size')
  const savedSize = slider.value
  expect(size.inputMode).toBe('numeric')
  await fill(size, '12.5')
  expect(size.value).toBe('12.5')
  expect(size.disabled).toBe(false)
  expect(size.getAttribute('aria-invalid')).toBe('true')
  expect(description(size)).toContain('Choose a whole-number font size')
  expect(slider.value).toBe(savedSize)
  expect(f.uiSave).not.toHaveBeenCalled()
  await fill(size, savedSize)
  expect(size.getAttribute('aria-invalid')).toBe('false')
  expect(description(size)).toContain('Applies to Notes')
})
