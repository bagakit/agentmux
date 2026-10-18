// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { applyConfigEdit } from '../src/shared/config-edit'
import { COMPOSER_PROMPT_STATES } from '../src/shared/composer-shortcut-library'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
// Only Monaco's code surface is substituted here; native capture loads the actual editor.
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: ({ value, onChange }: { value: string; onChange(value: string): void }) => <textarea aria-label="Script test field" value={value} onChange={event => onChange(event.target.value)} /> }))
const dom = composerDOM()
beforeEach(async () => useAppStore.setState({ config: { ...structuredClone(composerConfig), composerShortcuts: [{ id: 'review', label: 'Review', keyword: 'review', body: 'Review the current changes.' }] }, loading: false,
  providerCatalog: await api.providers.list(), detectExecutors: vi.fn(async () => {}) }))

async function fill(selector: string, value: string) {
  const input = dom.container.querySelector<HTMLInputElement>(selector)!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function configOwner() {
  return vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const config = applyConfigEdit(useAppStore.getState().config!, expected, next)
    useAppStore.setState({ config }); return config
  })
}

it('edits the Executor identity in its header and returns to the same library draft before saving', async () => {
  const save = configOwner()
  await dom.render(<SettingsPanel initialSection="agents" onClose={() => {}} />)
  await dom.click('[aria-label="Executors"] [data-resource-row="codex"]')
  expect(dom.container.querySelector('.settings-agent-pane')?.getAttribute('data-editor-view')).toBe('editor')
  expect(dom.container.querySelectorAll('[data-executor-name]')).toHaveLength(1)
  const name = dom.container.querySelector<HTMLInputElement>('.settings-resource-editor__header [data-executor-name]')!
  expect(name).not.toBeNull()
  await fill('[data-executor-name]', 'Review executor')
  await dom.click('.settings-resource-back')
  expect(dom.container.querySelector('.settings-agent-pane')?.getAttribute('data-editor-view')).toBe('library')
  expect(document.activeElement?.getAttribute('data-resource-row')).toBe('codex')
  await dom.click('[aria-label="Executors"] [data-resource-row="codex"]')
  expect(dom.container.querySelector('[data-executor-name]')).toBe(name)
  expect(name.value).toBe('Review executor')
  expect(save).not.toHaveBeenCalled()
  await dom.click('.settings-agent-save button')
  expect(useAppStore.getState().config?.executors.codex?.label).toBe('Review executor')
  expect(save.mock.calls[0]![1].executors.codex?.label).toBe('Codex')
})

it('keeps concise Prompt choices linked to complete state meanings and saves the exact selected state', async () => {
  const save = configOwner()
  await dom.render(<SettingsPanel initialSection="prompts" onClose={() => {}} />)
  await dom.click('[data-prompt-id="review"]')
  const choices = [...dom.container.querySelectorAll<HTMLInputElement>('.prompt-state-settings input[type="checkbox"]')]
  expect(choices.map(input => input.value)).toEqual([...COMPOSER_PROMPT_STATES])
  expect(dom.container.querySelector<HTMLDetailsElement>('.prompt-state-reference')?.open).toBe(false)
  for (const choice of choices) {
    const detail = document.getElementById(choice.getAttribute('aria-describedby')!)
    expect(detail?.textContent?.length).toBeGreaterThan(0)
  }
  await dom.click('.prompt-state-settings input[value="done"]')
  expect(dom.container.querySelector('[aria-label="Usage preview"]')?.textContent).toContain('Turn ended')
  await dom.click('.prompt-editor__back')
  expect(dom.container.querySelector('.prompt-workbench')?.getAttribute('data-view')).toBe('library')
  await dom.click('[data-prompt-id="review"]')
  expect(dom.container.querySelector<HTMLInputElement>('input[value="done"]')?.checked).toBe(true)
  expect(save).not.toHaveBeenCalled()
  await dom.click('.prompt-save-footer button')
  expect(useAppStore.getState().config?.composerShortcuts?.[0]?.states).toEqual(['done'])
})

it('names the missing tool fields and writes the completed original draft without running it', async () => {
  const add = vi.spyOn(api.toolkit, 'add').mockRejectedValue(new Error('Controlled write refusal'))
  const run = vi.spyOn(api.toolkit, 'run')
  await dom.render(<SettingsPanel initialSection="toolkit" onClose={() => {}} />)
  await dom.click('.toolkit-workbench__toolbar .toolkit-workbench__create')
  const save = () => dom.container.querySelector<HTMLButtonElement>('.toolkit-editor__footer [data-settings-save-bar] button')!
  const reason = () => dom.container.querySelector('.toolkit-editor__save-requirements')?.textContent
  expect(save().disabled).toBe(true)
  expect(reason()).toContain('a name')
  expect(reason()).toContain('a fixed working directory')
  await fill('.toolkit-editor__directory input', fixturePath('tool-work'))
  expect(save().disabled).toBe(true)
  expect(reason()).toContain('a name')
  expect(reason()).not.toContain('a fixed working directory')
  await fill('.toolkit-editor__name input', 'Review tool')
  expect(save().disabled).toBe(false)
  expect(reason()).toBeUndefined()
  const id = dom.container.querySelector<HTMLElement>('[data-tool-editor]')!.dataset.toolEditor!
  await act(async () => save().click())
  expect(add).toHaveBeenCalledOnce()
  expect(add).toHaveBeenCalledWith(id, expect.objectContaining({ name: 'Review tool', workspacePath: fixturePath('tool-work') }))
  expect(dom.container.querySelector('.toolkit-editor__footer [role="alert"]')?.textContent).toContain('Controlled write refusal')
  expect(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')?.value).toBe('Review tool')
  expect(run).not.toHaveBeenCalled()
})
