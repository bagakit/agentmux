// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { BrowserSettingsPane } from '../src/renderer/src/components/settings/BrowserSettingsPane'
import { SettingsSaveBar, useSettingsSave } from '../src/renderer/src/components/settings/SettingsSaveBar'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

// An unsaved draft that cannot be saved is still unsaved: the bar names why and never reports
// "All changes saved". `dirty` and the reason are separate facts.
const dom = composerDOM()
const status = () => dom.container.querySelector('[data-settings-save-bar] [role="status"]')!.textContent
const saveButton = () => dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
async function type(selector: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement>(selector)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function Bar({ dirty, blocked }: { dirty: boolean; blocked?: string }) {
  const save = useSettingsSave()
  return <SettingsSaveBar save={save} dirty={dirty} blocked={blocked} onSave={() => {}} />
}

it('names the reason a dirty draft cannot be saved, and stays quiet when nothing is unsaved', async () => {
  await dom.render(<Bar dirty blocked="add a name." />)
  expect(status()).toBe('Can’t save yet — add a name.')
  expect(saveButton().disabled).toBe(true)
  expect(dom.container.querySelector('[data-settings-save-blocked]')).not.toBeNull()

  // A reason without an unsaved draft is not shown: there is nothing waiting to be saved.
  await dom.render(<Bar dirty={false} blocked="add a name." />)
  expect(status()).toBe('All changes saved')
  expect(dom.container.querySelector('[data-settings-save-blocked]')).toBeNull()

  await dom.render(<Bar dirty />)
  expect(status()).toBe('Unsaved changes')
  expect(saveButton().disabled).toBe(false)
})

it('keeps a Browser draft with an invalid exit check address unsaved, with the reason, instead of reporting it saved', async () => {
  const onSave = vi.fn(async () => {})
  await dom.render(<BrowserSettingsPane active={false} browser={composerConfig.browser} onSave={onSave} onForget={async () => {}} />)
  await dom.click('[data-settings-field="agent-automation"] input[type="checkbox"]')
  await type('[aria-label="Exit check address"]', 'http://user:secret@example.com')
  expect(status()).not.toContain('All changes saved')
  expect(status()).toContain('Can’t save yet')
  expect(status()).toContain('https://')
  expect(saveButton().disabled).toBe(true)
  expect(onSave).not.toHaveBeenCalled()

  // Fixing the address returns the same draft to an ordinary unsaved state; nothing was lost.
  await type('[aria-label="Exit check address"]', 'https://example.com/ip')
  expect(status()).toBe('Unsaved changes')
  await dom.click('[data-settings-save-bar] button')
  expect(onSave).toHaveBeenCalledWith(
    { agentAutomation: true, automaticMemoryRelease: true, exitCheckUrl: 'https://example.com/ip' },
    { agentAutomation: false, automaticMemoryRelease: true, exitCheckUrl: '' })
})
