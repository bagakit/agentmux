// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const dom = composerDOM()
const page = () => dom.container.querySelector<HTMLElement>('.settings-page')!
async function clickText(text: string) {
  const button = [...page().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
async function fill(label: string, value: string) {
  const input = page().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function saveOwner() {
  return vi.spyOn(api.config, 'save').mockImplementation(async next => { useAppStore.setState({ config: next }); return next })
}

it('A2A preview follows the effective global rule and the unsaved local choice without notifying or saving', async () => {
  useAppStore.setState({ config: { ...composerConfig, notifications: { mode: 'off', sound: true } } })
  const save = saveOwner(), notify = vi.spyOn(api.ui, 'notifyAgentAttention')
  await dom.render(<SettingsPanel initialSection="a2a" onClose={() => {}} />)
  const preview = () => page().querySelector<HTMLElement>('[data-a2a-preview]')!
  expect(preview().dataset.a2aPreview).toBe('off')
  expect(preview().textContent).toContain('No system banner')
  await dom.click('[data-a2a-settings] input[value="notify"]')
  expect(preview().dataset.a2aPreview).toBe('standard')
  expect(preview().textContent).toContain('Sound on')
  expect(preview().textContent).toContain('Unsaved preview')
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, notifications: { mode: 'patient', sound: false } } }))
  expect(preview().dataset.a2aPreview).toBe('patient')
  expect(preview().textContent).toContain('Sound off')
  await clickText('Open Notifications')
  await dom.click('[data-settings-target="a2a"]')
  expect(preview().dataset.a2aPreview).toBe('patient')
  await dom.click('[data-a2a-settings] input[value="silent"]')
  expect(preview().dataset.a2aPreview).toBe('off')
  expect(save).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
})

it('User Input previews its literal prefix drafts and saves layout independently from shortcut input', async () => {
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="message-tool" onClose={() => {}} />)
  await dom.click('[data-message-tool-settings] input[value="two-line"]')
  await fill('Commands prefix', '!')
  await fill('Skills prefix', '')
  const preview = () => page().querySelector<HTMLElement>('.message-tool-preview')!
  expect(preview().querySelector<HTMLElement>('[data-layout]')!.dataset.layout).toBe('two-line')
  expect(preview().querySelector('[data-preview-prefix="command"] kbd')!.textContent).toBe('!')
  expect(preview().querySelector('[data-preview-prefix="skill"] kbd')!.textContent).toBe('Off')
  expect(preview().textContent).toContain('Unsaved preview')
  expect(save).not.toHaveBeenCalled()
  await clickText('Save layout')
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]![0].messageToolInitialLayout).toBe('two-line')
  expect(save.mock.calls[0]![0].messageToolCompletion).toEqual(composerConfig.messageToolCompletion)
  expect(preview().textContent).toContain('Unsaved preview')
  await clickText('Save shortcut input')
  expect(save.mock.calls[1]![0].messageToolCompletion).toEqual(expect.objectContaining({ command: '!', skill: null }))
  expect(preview().textContent).toContain('Saved settings')
  const details = page().querySelector<HTMLDetailsElement>('.message-tool-shortcuts')!
  expect(details.open).toBe(false)
  expect(details.querySelector('[data-binding-id]')).not.toBeNull()
})

it('InApp reads saved input and appearance preferences beside shared message examples without creating a Session', async () => {
  useAppStore.setState({ config: { ...composerConfig, messageToolInitialLayout: 'two-line', messageToolCompletion: { command: '!', skill: null, reference: '@', keywords: false }, appearance: { ...composerConfig.appearance, appAppearance: 'light' } } })
  const save = saveOwner(), submit = vi.spyOn(api.sessions, 'submitPrompt'), read = vi.spyOn(api.sessions, 'readHistory')
  await dom.render(<SettingsPanel initialSection="inapp-conversation" onClose={() => {}} />)
  expect(page().querySelector('[data-inapp-input-summary]')!.textContent).toContain('Two lines')
  expect(page().querySelector('[data-inapp-input-summary]')!.textContent).toContain('Commands !')
  expect(page().querySelector('[data-inapp-input-summary]')!.textContent).toContain('Skills Off')
  expect(page().querySelector('[data-inapp-appearance-summary]')!.textContent).toContain('Light appearance')
  expect(page().querySelectorAll('[data-example-view="activity"] .log-turn')).toHaveLength(2)
  expect(page().querySelector('[data-example-view="terminal"]')!.textContent).toContain('Summarize the proposed changes.')
  for (const [label, destination] of [['Open User Input', 'message-tool'], ['Open Appearance', 'appearance'], ['Open Keyboard shortcuts', 'keyboard-shortcuts'], ['Open amux Protocols', 'amux-protocols']]) {
    await clickText(label!)
    expect(page().dataset.settingsPage).toBe(destination)
    await dom.click('[data-settings-target="inapp-conversation"]')
  }
  expect(save).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('Protocols pairs each exact original wire with its original shared reader after explicit expansion', async () => {
  const { AGENTMUX_PROTOCOL_CATALOG } = await import('@agentmux/core/agent-message-render')
  const save = saveOwner(), open = vi.spyOn(api.ui, 'openObjectLink')
  await dom.render(<SettingsPanel initialSection="amux-protocols" onClose={() => {}} />)
  expect(page().querySelector('[data-protocol-example]')).toBeNull()
  await clickText('View first example')
  const first = page().querySelector<HTMLDetailsElement>('.amux-protocols__row')!
  await act(async () => first.dispatchEvent(new Event('toggle')))
  expect(first.open).toBe(true)
  const comparisons = [...first.querySelectorAll('.amux-protocols__comparison')]
  expect(comparisons.length).toBe(AGENTMUX_PROTOCOL_CATALOG[0]!.examples.length)
  comparisons.forEach((comparison, index) => {
    expect(comparison.querySelector('.amux-protocols__wire pre')!.textContent).toBe(AGENTMUX_PROTOCOL_CATALOG[0]!.examples[index]!.wire)
    expect(comparison.querySelector('[data-protocol-example] .log-turn')).not.toBeNull()
    expect(comparison.querySelector('details.amux-protocols__wire')).toBeNull()
  })
  expect(save).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it('Keyboard contexts preserve registry rows while command searches and clearing remain composable', async () => {
  const { buildCheatSheet } = await import('../src/renderer/src/lib/shortcut-cheat-sheet')
  const { isMacPlatform } = await import('../src/renderer/src/lib/host-platform')
  const save = saveOwner()
  await dom.render(<SettingsPanel initialSection="keyboard-shortcuts" onClose={() => {}} />)
  const groups = buildCheatSheet(isMacPlatform())
  const rows = () => [...page().querySelectorAll<HTMLElement>('[data-binding-id]')].map(row => row.dataset.bindingId)
  await clickText('Workbench')
  const workbench = groups.find(group => group.id === 'workbench')!.rows.map(row => row.id)
  expect(rows()).toEqual(workbench)
  await fill('Find a command or shortcut', 'tab')
  expect(rows().length).toBeGreaterThan(0)
  expect(rows().every(id => workbench.includes(id!))).toBe(true)
  await dom.click('[aria-label="Clear shortcut search"]')
  expect(document.activeElement).toBe(page().querySelector('[aria-label="Find a command or shortcut"]'))
  expect(rows()).toEqual(workbench)
  await clickText('All contexts')
  expect(rows()).toEqual(groups.flatMap(group => group.rows.map(row => row.id)))
  expect(save).not.toHaveBeenCalled()
})
