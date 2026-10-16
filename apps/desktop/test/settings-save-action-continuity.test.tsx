// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { GeneralSettingsPane } from '../src/renderer/src/components/settings/GeneralSettingsPane'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it('keeps the original save action while its actual draft moves through saving, failure and retry', async () => {
  let reject!: (error: Error) => void
  const onSave = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
  await dom.render(<GeneralSettingsPane copyPathsAsAbsolute={false} onSave={onSave} />)
  const button = dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
  expect(button.textContent).toBe('Save')
  expect(button.getAttribute('aria-busy')).toBe('false')
  expect(button.disabled).toBe(true)
  await dom.click('input[type="checkbox"]')
  await dom.click('[data-settings-save-bar] button')
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ copyPathsAsAbsolute: true }, { copyPathsAsAbsolute: false })
  expect(button.textContent).toBe('Save')
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.disabled).toBe(true)
  expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('Saving changes')
  await act(async () => reject(new Error('Preferences could not be saved')))
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('Preferences could not be saved')
  expect(dom.container.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  expect(button.textContent).toBe('Save')
  expect(button.getAttribute('aria-busy')).toBe('false')
  expect(button.disabled).toBe(false)
  onSave.mockImplementation(async () => {})
  await dom.click('[data-settings-save-bar] button')
  await dom.render(<GeneralSettingsPane copyPathsAsAbsolute onSave={onSave} />)
  expect(dom.container.querySelector('[data-settings-save-bar] button')).toBe(button)
  expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('Changes saved')
  expect(button.textContent).toBe('Save')
  expect(button.getAttribute('aria-busy')).toBe('false')
  expect(button.disabled).toBe(true)
})
