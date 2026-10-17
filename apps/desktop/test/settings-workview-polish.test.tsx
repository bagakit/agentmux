// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { applyConfigEdit } from '../src/shared/config-edit'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: structuredClone(composerConfig), detectExecutors: async () => {}, checkHost: async () => {} }))
async function input(selector: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement>(selector)!
  expect(node).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function transaction() {
  return vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const saved = applyConfigEdit(useAppStore.getState().config!, expected!, next)
    useAppStore.setState({ config: saved }); return saved
  })
}

it('Survey previews the original unsaved title and history choice without loading history, images or saving', async () => {
  const save = vi.spyOn(api.config, 'save'), history = vi.spyOn(api.browser, 'listInputHistory')
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="survey" />)
  const field = dom.container.querySelector<HTMLInputElement>('[aria-label="Start page title"]')!
  await input('[aria-label="Start page title"]', 'A research draft')
  await input('[aria-label="Start page icon"]', 'https://images.example.test/draft.png')
  expect(dom.container.querySelector('[aria-label="Start page draft preview"] h3')?.textContent).toBe('A research draft')
  await dom.click('[aria-label="Show recent input cards"]')
  expect(dom.container.querySelector('.settings-survey__history')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Start page draft preview"] img')).toBeNull()
  await dom.click('nav [data-settings-target="notes"]')
  await dom.click('nav [data-settings-target="survey"]')
  expect(dom.container.querySelector('[aria-label="Start page title"]')).toBe(field)
  expect(field.value).toBe('A research draft')
  expect(save).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled()
})

it('Survey still submits the original full draft and expected baseline, while Open Survey leaves it unsaved', async () => {
  const write = transaction(), close = vi.fn()
  await dom.render(<SettingsPanel onClose={close} initialSection="survey" />)
  await input('[aria-label="Start page title"]', 'Saved research')
  await dom.click('[data-settings-pane="survey"] [data-settings-save-bar] button')
  expect(write.mock.calls[0]?.[0].browser.startPage?.title).toBe('Saved research')
  expect(write.mock.calls[0]?.[1]?.browser.startPage?.title).toBe('AMUX - Survey')
  await input('[aria-label="Start page title"]', 'Keep later draft')
  await dom.click('.settings-survey > section > header button')
  expect(close).toHaveBeenCalledOnce()
  expect(useAppStore.getState().mainSurface).toBe('survey')
  expect(write).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Start page title"]')?.value).toBe('Keep later draft')
})

it('Recall places reading first while keeping storage controls reachable and its original size preview bound to the draft', async () => {
  const move = vi.spyOn(api.notesStorage, 'change'), write = vi.spyOn(api.config, 'save')
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="notes" />)
  const headings = [...dom.container.querySelectorAll('.settings-recall > section > header > span')].map(node => node.textContent)
  expect(headings).toEqual(['Reading', 'Notebook storage'])
  await input('[aria-label="Notes body text size"]', '20')
  expect(dom.container.querySelector<HTMLElement>('.settings-reading-preview > div')?.style.fontSize).toBe('20px')
  expect(dom.container.querySelector('[aria-label="Notes directory"]')).not.toBeNull()
  expect(dom.container.querySelector('.settings-recall__storage-actions')?.textContent).toContain('Refresh directory')
  expect(move).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
})

it('Mote avatar presets and range update the same size preview and original settings transaction', async () => {
  const write = transaction()
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="mote" />)
  await dom.click('[aria-label="32px avatar"]')
  expect(dom.container.querySelector<HTMLElement>('.settings-mote__avatar-preview > span')?.style.width).toBe('32px')
  await input('[aria-label="Avatar size"]', '40')
  expect(dom.container.querySelector<HTMLElement>('.settings-mote__avatar-preview > span')?.style.height).toBe('40px')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Avatar size"]')?.value).toBe('40')
  await dom.click('input[name="mote-directory-view"][value="list"]')
  await dom.click('[data-settings-pane="mote"] [data-settings-save-bar] button')
  expect(write.mock.calls[0]?.[0]).toMatchObject({ moteDirectoryView: 'list', moteDirectoryAvatarSize: 40 })
  expect(write.mock.calls[0]?.[1]).toMatchObject({ moteDirectoryView: 'collaborators', moteDirectoryAvatarSize: 45 })
})

it('Space commit-time preview follows the unsaved choice without changing saved preferences', async () => {
  const write = vi.spyOn(api.config, 'save')
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="space" />)
  expect(dom.container.querySelector('.settings-space__commit time')).not.toBeNull()
  await dom.click('[aria-label="Show commit time"]')
  expect(dom.container.querySelector('.settings-space__commit time')).toBeNull()
  expect(useAppStore.getState().config?.gitHistoryShowTime).toBeUndefined()
  expect(write).not.toHaveBeenCalled()
})
