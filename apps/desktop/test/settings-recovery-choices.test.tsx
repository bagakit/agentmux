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

it('compares recovery choices directly and saves the selected mode through the original owner', async () => {
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const config = applyConfigEdit(useAppStore.getState().config!, expected, next)
    useAppStore.setState({ config }); return config
  })
  const recover = vi.spyOn(api.sessions, 'recover')
  await dom.render(<SettingsPanel initialSection="continuity" onClose={() => {}} />)
  const group = dom.container.querySelector<HTMLFieldSetElement>('fieldset[data-settings-field="activeRecovery"]')!
  expect(group.querySelector('legend')?.textContent).toBe('Automatic native recovery')
  expect([...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(input => input.value)).toEqual(['automatic', 'manual'])
  const manual = group.querySelector<HTMLInputElement>('input[value="manual"]')!
  expect(manual.checked).toBe(false)
  await act(async () => manual.click())
  expect(manual.checked).toBe(true)
  expect(dom.container.querySelector('.recovery-mode-effect')?.textContent).toContain('Recovery waits for you')
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Automatic recovery window unit"]')?.value).toBe('hours')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Automatic recovery window"]')?.value).toBe('24')
  expect(save).not.toHaveBeenCalled()
  await dom.click('[data-settings-target="automation"]')
  await dom.click('[data-settings-target="continuity"]')
  expect(dom.container.querySelector('input[value="manual"]')).toBe(manual)
  expect(manual.checked).toBe(true)
  await dom.click('[data-settings-pane="continuity"] [data-settings-save-bar] button')
  expect(save).toHaveBeenCalledOnce()
  expect(useAppStore.getState().config?.continuity).toEqual({ activeRecovery: 'manual' })
  expect(save.mock.calls[0]![1].continuity?.activeRecovery).toBe('automatic')
  expect(recover).not.toHaveBeenCalled()
})
