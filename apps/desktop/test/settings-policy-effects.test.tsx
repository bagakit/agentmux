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
async function input(label: string, value: string) {
  const control = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(control).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
function saveOwner() {
  return vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const config = applyConfigEdit(useAppStore.getState().config!, expected, next)
    useAppStore.setState({ config }); return config
  })
}

it('combines quiet follow-up draft conditions without saving or creating work', async () => {
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="automation" onClose={() => {}} />)
  await act(async () => { dom.container.querySelector<HTMLDetailsElement>('[data-automation-quiet-defaults]')!.open = true })
  await input('Minimum silence before follow-up', '21')
  await input('Minimum follow-up interval', '25')
  await input('Daily follow-up budget', '2')
  await input('Quiet period starts', [[23,0]].map(parts => parts.map(value => String(value).padStart(2, '0')).join(':')).join(' to '))
  const example = () => dom.container.querySelector('[aria-label="Quiet follow-up example"]')!
  expect(example().textContent).toContain('21 hours')
  expect(example().textContent).toContain('25 hours')
  expect(example().textContent).toContain('2 attempts per local day')
  expect(example().textContent).toContain([[23,0],[8,0]].map(parts => parts.map(value => String(value).padStart(2, '0')).join(':')).join(' to '))
  expect(example().textContent).toContain('confirmed reply')
  expect(save).not.toHaveBeenCalled()
  await dom.click('[data-settings-target="continuity"]')
  await dom.click('[data-settings-target="automation"]')
  expect(example().textContent).toContain('21 hours')
  await input('Minimum silence before follow-up', '0.1')
  expect(example().textContent).toContain('6 minutes')
  await input('Minimum silence before follow-up', '21')
  await input('Daily follow-up budget', '0')
  expect(example()).toBeNull()
  await input('Daily follow-up budget', '2')
  await dom.click('.automation-defaults [data-settings-save-bar] button')
  expect(save).toHaveBeenCalledOnce()
  expect(useAppStore.getState().config?.automation).toMatchObject({ checkInSilenceMs: 21 * 3_600_000, checkInMinIntervalMs: 25 * 3_600_000, checkInDailyBudget: 2, checkInQuietStart: [[23,0]].map(parts => parts.map(value => String(value).padStart(2, '0')).join(':')).join(' to ') })
  expect(useAppStore.getState().config?.continuity).toBeUndefined()
})

it('shows draft retry bases, bounded examples and same-operation rechecks through Settings', async () => {
  const save = saveOwner(), recover = vi.spyOn(api.sessions, 'recover')
  await dom.render(<SettingsPanel initialSection="continuity" onClose={() => {}} />)
  await input('Maximum retry base delay', '5')
  await input('Additional retries', '7')
  const retry = () => dom.container.querySelector('[aria-label="Recovery retry example"]')!
  expect([...retry().querySelectorAll('li strong')].map(n => n.textContent)).toEqual(['1 second', '2 seconds', '4 seconds', '5 seconds', '5 seconds', '5 seconds'])
  expect(retry().textContent).toContain('First 6 of 7')
  expect(retry().textContent).toContain('If recovery still fails')
  expect(retry().textContent).toContain('frontend reconnection uses the base alone')
  await input('Recheck count', '4')
  await input('Recheck interval', '2')
  const recheck = dom.container.querySelector('[aria-label="Recovery recheck example"]')!
  expect(recheck.textContent).toContain('4 follow-up checks, 2 seconds apart')
  expect(recheck.textContent).toContain('does not start a new attempt')
  await input('Additional retries', '0')
  expect(retry().querySelectorAll('li')).toHaveLength(0)
  expect(retry().textContent).toContain('Automatic retries are off')
  await input('Additional retries', '9007199254740991')
  expect(retry().querySelectorAll('li')).toHaveLength(6)
  await input('Additional retries', '7')
  expect(save).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
  await dom.click('[data-settings-pane="continuity"] [data-settings-save-bar] button')
  expect(save).toHaveBeenCalledOnce()
  expect(useAppStore.getState().config?.continuity).toMatchObject({ retryMaxDelayMs: 5000, retryMaxAttempts: 7, recheckIntervalMs: 2000, recheckMaxAttempts: 4 })
})
