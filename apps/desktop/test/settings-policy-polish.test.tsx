// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { buildCheatSheet } from '../src/renderer/src/lib/shortcut-cheat-sheet'
import { isMacPlatform } from '../src/renderer/src/lib/host-platform'
import { AGENTMUX_PROTOCOL_CATALOG } from '@agentmux/core/agent-message-render'
import { composerDOM } from './helpers/composer-dom-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const dom = composerDOM()
const page = () => dom.container.querySelector<HTMLElement>('.settings-page')!
const field = (name: string) => dom.container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function unit(label: string, value: string) {
  const select = dom.container.querySelector<HTMLSelectElement>(`select[aria-label="${label} unit"]`)!
  expect(select).not.toBeNull()
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function clickText(text: string) {
  const button = [...page().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
async function toggle(details: HTMLDetailsElement, open: boolean) {
  await act(async () => { details.open = open; details.dispatchEvent(new Event('toggle')) })
}
function saveOwner() {
  return vi.spyOn(api.config, 'save').mockImplementation(async next => { useAppStore.setState({ config: next }); return next })
}

it('keeps recovery drafts mounted through disclosures and saves exact seconds while explaining long durations', async () => {
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="continuity" onClose={() => {}} />)
  const window = field('Automatic recovery window')
  await unit('Automatic recovery window', 'seconds')
  await fill(window, '86400.125')
  expect(window.closest('[data-settings-field]')!.querySelector('output')!.textContent).toBe('24 hours 0.125 seconds')
  const retry = field('Additional retries'), details = retry.closest('details')!
  expect(details.open).toBe(false)
  await toggle(details, true)
  await fill(retry, '7')
  await toggle(details, false)
  expect(field('Additional retries')).toBe(retry)
  expect(retry.value).toBe('7')
  expect(details.querySelector('summary')!.textContent).not.toContain('Saved: 7 retries')
  await clickText('Save recovery preferences')
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]![0].continuity).toEqual(expect.objectContaining({ confirmedIdleWindowMs: 86_400_125, retryMaxAttempts: 7 }))
})

it('keeps quiet follow-up drafts through collapse and saves task defaults without publishing continuation edits', async () => {
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="automation" onClose={() => {}} />)
  const minimum = field('Minimum silence before follow-up'), details = minimum.closest('details')!
  expect(details.open).toBe(false)
  await toggle(details, true)
  await fill(minimum, '19.5')
  await toggle(details, false)
  expect(field('Minimum silence before follow-up')).toBe(minimum)
  const fallback = dom.container.querySelector<HTMLInputElement>('input[aria-label="Use active state when interruption detection is unsupported"]')
  expect(fallback).not.toBeNull()
  await toggle(fallback!.closest('details')!, true)
  await act(async () => fallback!.click())
  await clickText('Save task defaults')
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]![0].automation?.checkInSilenceMs).toBe(70_200_000)
  expect(save.mock.calls[0]![0].continuity).toBeUndefined()
})

it('opens global Notifications from A2A and restores the unsaved notification choice', async () => {
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="a2a" onClose={() => {}} />)
  const notify = dom.container.querySelector<HTMLInputElement>('[data-a2a-settings] input[value="notify"]')!
  await act(async () => notify.click())
  await clickText('Open Notifications')
  expect(page().dataset.settingsPage).toBe('notifications')
  await dom.click('[data-settings-target="a2a"]')
  expect(dom.container.querySelector('[data-a2a-settings] input[value="notify"]')).toBe(notify)
  expect(notify.checked).toBe(true)
  expect(save).not.toHaveBeenCalled()
})

it('General links open the original recovery and Host owners without saving its path draft', async () => {
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="general" onClose={() => {}} />)
  const path = page().querySelector<HTMLInputElement>('[data-settings-field="copy-paths"] input')!
  await act(async () => path.click())
  await clickText('Open Execution')
  expect(page().dataset.settingsPage).toBe('continuity')
  await dom.click('[data-settings-target="general"]')
  expect(page().querySelector('[data-settings-field="copy-paths"] input')).toBe(path)
  expect(path.checked).toBe(true)
  await clickText('Open Hosts')
  expect(page().dataset.settingsPage).toBe('hosts')
  expect(save).not.toHaveBeenCalled()
})

it('InApp destinations retain the original page owners without saving configuration', async () => {
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="inapp-conversation" onClose={() => {}} />)
  for (const [label, destination] of [['Open User Input', 'message-tool'], ['Open Appearance', 'appearance'], ['Open Keyboard shortcuts', 'keyboard-shortcuts'], ['Open amux Protocols', 'amux-protocols']]) {
    await clickText(label!)
    expect(page().dataset.settingsPage).toBe(destination)
    await dom.click('[data-settings-target="inapp-conversation"]')
  }
  expect(save).not.toHaveBeenCalled()
})

it('shortcut contexts and chord queries compose from every original registry binding', async () => {
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="keyboard-shortcuts" onClose={() => {}} />)
  const groups = buildCheatSheet(isMacPlatform())
  const rows = () => [...page().querySelectorAll<HTMLElement>('[data-binding-id]')].map(row => row.dataset.bindingId)
  await clickText('Workbench')
  expect(rows()).toEqual(groups.find(group => group.id === 'workbench')!.rows.map(row => row.id))
  await fill(field('Find a command or shortcut'), 'tab')
  expect(rows().length).toBeGreaterThan(0)
  expect(rows().every(id => groups.find(group => group.id === 'workbench')!.rows.some(row => row.id === id))).toBe(true)
  await dom.click('[aria-label="Clear shortcut search"]')
  expect(document.activeElement).toBe(field('Find a command or shortcut'))
  expect(rows()).toEqual(groups.find(group => group.id === 'workbench')!.rows.map(row => row.id))
  await clickText('All contexts')
  expect(rows()).toEqual(groups.flatMap(group => group.rows.map(row => row.id)))
  expect(save).not.toHaveBeenCalled()
})

it('opens the first protocol example explicitly through the shared reader and keeps wire content exact', async () => {
  const save = saveOwner()
  const openObject = vi.spyOn(api.ui, 'openObjectLink')
  await dom.render(<SettingsPanel initialSection="amux-protocols" onClose={() => {}} />)
  const first = page().querySelector<HTMLDetailsElement>('.amux-protocols__row')!
  expect(first.open).toBe(false)
  expect(page().querySelector('[data-protocol-example]')).toBeNull()
  await clickText('View first example')
  await act(async () => first.dispatchEvent(new Event('toggle')))
  expect(first.open).toBe(true)
  expect(document.activeElement).toBe(first.querySelector('summary'))
  expect([...first.querySelectorAll('.amux-protocols__wire pre')].map(wire => wire.textContent)).toEqual(AGENTMUX_PROTOCOL_CATALOG[0]!.examples.map(example => example.wire))
  expect(first.querySelectorAll('[data-protocol-example]')).toHaveLength(AGENTMUX_PROTOCOL_CATALOG[0]!.examples.length)
  expect(save).not.toHaveBeenCalled()
  expect(openObject).not.toHaveBeenCalled()
})


it('duration units explain the natural default without changing the draft and round trip repeating decimals losslessly', async () => {
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="continuity" onClose={() => {}} />)
  const window = field('Automatic recovery window')
  const saveButton = () => page().querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
  expect(window.value).toBe('24')
  expect(saveButton().disabled).toBe(true)
  await unit('Automatic recovery window', 'seconds')
  expect(window.value).toBe('86400')
  expect(saveButton().disabled).toBe(true)
  await fill(window, '86400.125')
  await clickText('Save recovery preferences')
  expect(saveButton().disabled).toBe(true)
  await unit('Automatic recovery window', 'hours')
  expect(window.closest('[data-settings-field]')!.querySelector('output')!.textContent).toContain('≈')
  expect(window.closest('[data-settings-field]')!.querySelector('output')!.textContent).toContain('Exact: 86400.125 seconds')
  expect(saveButton().disabled).toBe(true)
  await fill(field('Additional retries'), '8')
  await clickText('Save recovery preferences')
  expect(save.mock.calls.at(-1)![0].continuity?.confirmedIdleWindowMs).toBe(86_400_125)
  await unit('Automatic recovery window', 'seconds')
  expect(window.value).toBe('86400.125')
  await unit('Automatic recovery window', 'hours')
  await fill(window, '1.5')
  await clickText('Save recovery preferences')
  expect(save.mock.calls.at(-1)![0].continuity?.confirmedIdleWindowMs).toBe(5_400_000)
})

it('duration unit editing rejects sub-millisecond input and preserves the full safe original value during conversion', async () => {
  useAppStore.setState(state => ({ config: { ...state.config!, continuity: { activeRecoveryDelayMs: Number.MAX_SAFE_INTEGER } } }))
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="continuity" onClose={() => {}} />)
  const wait = field('Recovery wait')
  await unit('Recovery wait', 'hours')
  await fill(field('Recheck count'), '8')
  await clickText('Save recovery preferences')
  expect(save.mock.calls.at(-1)![0].continuity?.activeRecoveryDelayMs).toBe(Number.MAX_SAFE_INTEGER)
  await unit('Recovery wait', 'seconds')
  expect(wait.value).toBe('9007199254740.991')
  await unit('Recovery wait', 'hours')
  await fill(wait, '0.000000001')
  expect(wait.getAttribute('aria-invalid')).toBe('true')
  expect(page().querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.disabled).toBe(true)
  expect(wait.value).toBe('0.000000001')
  await fill(wait, '0.0000025')
  expect(wait.getAttribute('aria-invalid')).toBe('false')
  await clickText('Save recovery preferences')
  expect(save.mock.calls.at(-1)![0].continuity?.activeRecoveryDelayMs).toBe(9)
})
