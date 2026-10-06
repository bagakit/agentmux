// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: { ...composerConfig,
  composerShortcuts: [{ id: 'original', keyword: 'review', label: 'Review changes', body: 'Review the changes.' }]
} }))
async function fill(selector: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  expect(node).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('groups Input & Mailbox and the original Prompts once across the real catalog, Overview, navigation and search', async () => {
  const groups = settingsNavGroups('')
  const messageTool = groups.find(group => group.id === 'message-tool')!
  expect(messageTool.title).toBe('Message Tool')
  expect(messageTool.items.map(item => item.id)).toEqual(['message-tool', 'prompts'])
  expect(groups.filter(group => group.id !== 'message-tool').flatMap(group => group.items).some(item => item.id === 'prompts')).toBe(false)
  expect(groups.find(group => group.id === 'preferences')!.items.some(item => item.id === 'notifications')).toBe(true)
  const save = vi.spyOn(api.config, 'save')
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect(dom.container.querySelectorAll('[data-settings-section="message-tool"]')).toHaveLength(1)
  await dom.click('[data-settings-section="message-tool"]')
  expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe('Input & Mailbox')
  expect(dom.container.querySelectorAll('[data-message-tool-settings]')).toHaveLength(1)
  for (const query of ['mailbox', '立即发送', 'initial layout']) {
    await fill('[aria-label="Search settings"]', query)
    expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe('Input & Mailbox')
    expect(dom.container.querySelector('[data-message-tool-settings] [aria-label="Mailbox"]')?.textContent).toContain('Each Agent keeps its own records')
  }
  expect(save).not.toHaveBeenCalled()
})

it('moves the sole layout editor out of General and preserves the same dirty Prompt and layout nodes across navigation', async () => {
  const save = vi.spyOn(api.config, 'save')
  await dom.render(<SettingsPanel initialSection="prompts" onClose={() => {}} />)
  await dom.click('[data-prompt-id="original"]')
  await fill('[data-prompt-editor] textarea', 'Unsaved original instruction 中文')
  const prompt = dom.container.querySelector<HTMLTextAreaElement>('[data-prompt-editor] textarea')!
  await act(async () => { prompt.focus(); prompt.setSelectionRange(3, 9) })
  await dom.click('[data-settings-target="message-tool"]')
  const layout = dom.container.querySelector<HTMLInputElement>('[data-message-tool-settings] input[value="two-line"]')!
  await act(async () => layout.click())
  expect(layout.checked).toBe(true)
  await dom.click('[data-settings-target="general"]')
  expect(dom.container.querySelector('[data-settings-pane="general"] input[type="radio"]')).toBeNull()
  await dom.click('[data-settings-target="prompts"]')
  expect(dom.container.querySelector('[data-prompt-editor] textarea')).toBe(prompt)
  expect(prompt.value).toBe('Unsaved original instruction 中文')
  expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([3, 9])
  await dom.click('[data-settings-target="message-tool"]')
  expect(dom.container.querySelector('[data-message-tool-settings] input[value="two-line"]')).toBe(layout)
  expect(layout.checked).toBe(true)
  expect(save).not.toHaveBeenCalled()
})

it('keeps the captured layout baseline while merging current unrelated configuration and retains a failed choice', async () => {
  const save = vi.spyOn(api.config, 'save').mockRejectedValue(new Error('Concurrent edit; keep this choice.'))
  await dom.render(<SettingsPanel initialSection="message-tool" onClose={() => {}} />)
  await dom.click('[data-message-tool-settings] input[value="two-line"]')
  const edited = { ...useAppStore.getState().config!, copyPathsAsAbsolute: true }
  await act(async () => useAppStore.getState().setConfig(edited))
  await dom.click('[data-message-tool-settings] [data-settings-save-bar] button')
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...edited, messageToolInitialLayout: 'two-line' }, { ...edited, messageToolInitialLayout: 'one-line' })
  expect(dom.container.querySelector<HTMLInputElement>('[data-message-tool-settings] input[value="two-line"]')!.checked).toBe(true)
  expect(dom.container.textContent).toContain('Concurrent edit; keep this choice.')
  expect(dom.container.querySelector<HTMLButtonElement>('[data-message-tool-settings] [data-settings-save-bar] button')!.disabled).toBe(false)
})
