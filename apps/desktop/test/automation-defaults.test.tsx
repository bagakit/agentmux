import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { applyConfigEdit } from '../src/shared/config-edit'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
const dom = composerDOM()
function field(label: string) {
  const node = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
  expect(node, label).not.toBeNull(); return node!
}
async function edit(label: string, value: string) {
  const node = field(label), prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function save() {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-settings-save-bar] button')].find(node => node.textContent === 'Save task defaults')!
  expect(button?.disabled).toBe(false); await act(async () => button.click())
}
it('the registered Automation editor saves only authored defaults and keeps continuation and tasks intact', async () => {
  const continuity = { continuationEnabled: false, reminderAppend: 'Original recovery text' }
  useAppStore.setState({ config: { ...composerConfig, continuity }, loading: false })
  const create = vi.spyOn(api.continuousProgress, 'create'), schedule = vi.spyOn(api.schedule, 'create')
  const saved = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const current = applyConfigEdit(useAppStore.getState().config!, expected, next); useAppStore.setState({ config: current }); return current
  })
  await dom.render(<SettingsPanel initialSection="automation" onClose={() => {}} />)
  expect(field('Default progress interval').value).toBe('30'); expect(field('Default progress prompt').value).toBe('')
  expect(field('Default arrangement timezone').value).toBe(''); expect(dom.container.textContent).toContain('system timezone')
  await edit('Default progress interval', '7'); await edit('Default progress prompt', 'An exact new periodic instruction.\nKeep the second line.')
  await edit('Default arrangement timezone', 'Europe/Berlin'); await edit('Quiet period starts', new Date(_batchFixtureEpoch(0, 23 * 60 * 60 + 15 * 60)).toISOString().slice(11, 16)); await edit('Quiet period ends', new Date(_batchFixtureEpoch(0, 7 * 60 * 60 + 45 * 60)).toISOString().slice(11, 16))
  await edit('Minimum silence before follow-up', '2'); await edit('Minimum follow-up interval', '3'); await edit('Daily follow-up budget', '2')
  await save()
  expect(saved).toHaveBeenCalledOnce()
  expect(useAppStore.getState().config?.automation).toEqual({ progressIntervalMs: 420000, progressPrompt: 'An exact new periodic instruction.\nKeep the second line.',
    calendarTimezone: 'Europe/Berlin', checkInQuietStart: new Date(_batchFixtureEpoch(0, 23 * 60 * 60 + 15 * 60)).toISOString().slice(11, 16), checkInQuietEnd: new Date(_batchFixtureEpoch(0, 7 * 60 * 60 + 45 * 60)).toISOString().slice(11, 16), checkInSilenceMs: 7200000, checkInMinIntervalMs: 10800000, checkInDailyBudget: 2 })
  expect(useAppStore.getState().config?.continuity).toEqual(continuity)
  expect(create).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled(); expect(dom.draft()).toBe('Keep my draft')
  await dom.click('[data-settings-target="overview"]')
  expect(dom.container.querySelector('[data-settings-section="automation"]')?.textContent).toContain('7 min')
})
it('pending saves preserve later input, external defaults and the original expected value', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const saved = vi.spyOn(api.config, 'save').mockImplementationOnce(async (next, expected) => {
    await gate
    const current = applyConfigEdit(useAppStore.getState().config!, expected, next); useAppStore.setState({ config: current }); return current
  }).mockImplementation(async (next, expected) => {
    const current = applyConfigEdit(useAppStore.getState().config!, expected, next); useAppStore.setState({ config: current }); return current
  })
  await dom.render(<SettingsPanel initialSection="automation" onClose={() => {}} />)
  await edit('Default progress prompt', 'Submitted original'); await save()
  await edit('Default progress prompt', 'Later unsaved input')
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, automation: { calendarTimezone: 'Asia/Tokyo' }, continuity: { continuationEnabled: false } } }))
  await act(async () => { release(); await gate })
  await vi.waitFor(() => expect(useAppStore.getState().config?.automation?.progressPrompt).toBe('Submitted original'))
  expect(field('Default progress prompt').value).toBe('Later unsaved input'); expect(field('Default arrangement timezone').value).toBe('Asia/Tokyo')
  expect(useAppStore.getState().config?.continuity?.continuationEnabled).toBe(false)
  await save()
  expect(saved.mock.calls[1]![1].automation?.progressPrompt).toBe('Submitted original')
  expect(useAppStore.getState().config?.automation).toEqual({ calendarTimezone: 'Asia/Tokyo', progressPrompt: 'Later unsaved input' })
})
