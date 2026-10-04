// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ProfileSettingsPane } from '../src/renderer/src/components/settings/ProfileSettingsPane'
import { ConversationMessageAvatar } from '../src/renderer/src/components/ConversationMessageAvatar'
import { ConversationSpeakerAvatar } from '../src/renderer/src/components/ConversationSpeakerAvatar'
import { useAppStore } from '../src/renderer/src/store'
import { DEFAULT_USER_PROFILE } from '../src/shared/user-profile'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { renderToStaticMarkup } from 'react-dom/server'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: composerConfig, loading: false }))
async function input(label: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="' + label + '"]')!
  expect(node?.isConnected).toBe(true)
  await act(async () => {
    Object.getOwnPropertyDescriptor(node.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('preserves typed input after an awaited save and keeps conflicting drafts', async () => {
  let release!: () => void
  const onSave = vi.fn(async () => new Promise<void>(resolve => { release = resolve }))
  await dom.render(<ProfileSettingsPane profile={undefined} onSave={onSave} />)
  await input('Display name', 'Alex')
  await input('About you and how you work', 'Original context')
  const save = dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
  await act(async () => save.click())
  expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_USER_PROFILE, displayName: 'Alex', about: 'Original context' }, DEFAULT_USER_PROFILE)
  await input('About you and how you work', 'Typed while saving')
  await act(async () => release())
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Typed while saving')
  expect(save.disabled).toBe(false)
  onSave.mockRejectedValueOnce(new Error('profile.about changed since editing'))
  await act(async () => save.click())
  expect(dom.container.querySelector('[role=alert]')?.textContent).toContain('profile.about')
  expect(save.disabled).toBe(false)
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Typed while saving')
})

it('saved external clean fields refresh while dirty fields retain their authored baseline', async () => {
  const onSave = vi.fn(async () => {})
  await dom.render(<ProfileSettingsPane profile={undefined} onSave={onSave} />)
  await input('Display name', 'My draft')
  await dom.render(<ProfileSettingsPane profile={{ ...DEFAULT_USER_PROFILE, displayName: 'External name', about: 'External context' }} onSave={onSave} />)
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Display name"]')!.value).toBe('My draft')
  expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('External context')
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.click())
  expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_USER_PROFILE, displayName: 'My draft', about: 'External context' }, { ...DEFAULT_USER_PROFILE, about: 'External context' })
})

it('the real message consumer observes the human avatar, preserves recorded identity, and keeps other roles pure', async () => {
  const avatar = 'data:image/png;base64,controlled-image'
  useAppStore.setState({ config: { ...composerConfig, profile: { ...DEFAULT_USER_PROFILE, avatar } } })
  const speaker = { role: 'human' as const, id: 'human' }
  await dom.render(<ConversationMessageAvatar speaker={speaker} name="You" />)
  expect(dom.container.querySelector('img')?.getAttribute('src')).toBe(avatar)
  expect(dom.container.querySelector('[data-speaker-id]')?.getAttribute('data-speaker-id')).toBe('human')
  expect(dom.container.querySelector('[role=img]')?.getAttribute('aria-label')).toBe('You')
  for (const role of ['unknown', 'system'] as const) {
    const html = renderToStaticMarkup(<ConversationSpeakerAvatar speaker={{ role, id: role }} name={role} humanAvatar={avatar} />)
    expect(html).not.toContain(avatar)
    expect(html).toContain('data-speaker-id="' + role + '"')
  }
})
