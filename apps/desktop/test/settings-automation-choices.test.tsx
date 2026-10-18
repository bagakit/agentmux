// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { applyConfigEdit } from '../src/shared/config-edit'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: structuredClone(composerConfig), loading: false }))

it('keeps optional prompt edits through disclosure and saves task defaults separately from continuation', async () => {
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const config = applyConfigEdit(useAppStore.getState().config!, expected, next)
    useAppStore.setState({ config }); return config
  })
  await dom.render(<SettingsPanel initialSection="automation" onClose={() => {}} />)
  const details = dom.container.querySelector<HTMLDetailsElement>('.automation-prompt-disclosure')!
  expect(details.open).toBe(false)
  expect(details.querySelector('summary')?.textContent).toContain('Optional')
  const input = details.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    details.open = true
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Review the next bounded step.')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    details.open = false
  })
  expect(details.querySelector('summary')?.textContent).toContain('Custom instruction')
  expect(details.querySelector('textarea')).toBe(input)
  expect(input.value).toBe('Review the next bounded step.')
  await dom.click('[aria-label="Continue interrupted work after recovery"]')
  expect(dom.container.querySelector('.continuation-effect')?.textContent).toContain('without sending a continuation')
  expect(dom.container.querySelector('.continuation-settings .automation-save-scope')?.textContent).toContain('continuation and interruption detection only')
  expect(dom.container.querySelector('.automation-defaults .automation-save-scope')?.textContent).toContain('progress, calendar and quiet follow-up defaults')
  await dom.click('.automation-defaults [data-settings-save-bar] button')
  expect(save).toHaveBeenCalledOnce()
  expect(useAppStore.getState().config?.automation?.progressPrompt).toBe('Review the next bounded step.')
  expect(useAppStore.getState().config?.continuity).toBeUndefined()
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Continue interrupted work after recovery"]')?.checked).toBe(false)
  await dom.click('.continuation-settings [data-settings-save-bar] button')
  expect(useAppStore.getState().config?.continuity?.continuationEnabled).toBe(false)
  expect(useAppStore.getState().config?.automation?.progressPrompt).toBe('Review the next bounded step.')
})
