// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { COMPOSER_PROMPT_STATES } from '../src/shared/composer-shortcut-library'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const prompts = [
  { id: 'one', keyword: 'one', label: 'One', body: 'First instruction.\nSecond paragraph.' },
  { id: 'two', keyword: 'two', label: 'Two', body: 'Review the changes carefully.', providerId: 'codex', states: ['done'] as ['done'] }
]
let f: Awaited<ReturnType<typeof configOwnerFixture>>
beforeEach(async () => {
  f = await configOwnerFixture({ composerShortcuts: prompts })
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation((saved) => { publish(saved); useAppStore.setState({ config: saved }) })
  useAppStore.setState({ config: f.owner.current, providerCatalog: await api.providers.list() })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => await f.owner.edit(expected!, next))
})
const field = (name: string) => [...dom.container.querySelectorAll<HTMLLabelElement>('[data-prompt-editor] label')]
  .find((label) => label.querySelector('span')?.textContent === name)!.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!
const search = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Search prompts"]')!
const editor = () => dom.container.querySelector<HTMLElement>('[data-prompt-editor]')!
const ids = () => [...dom.container.querySelectorAll<HTMLElement>('[data-prompt-id]')].map((node) => node.dataset.promptId)
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  expect(node).not.toBeNull()
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function open(id: string) { await dom.click(`[data-prompt-id="${id}"]`) }
async function mount() { await dom.render(<SettingsPanel initialSection="prompts" onClose={() => {}} />) }
async function add() { await dom.click('.prompt-workbench__toolbar button') }
async function save() {
  await dom.click('[data-settings-save-bar] button')
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise((done) => setTimeout(done, 5)) })
    if (!dom.container.querySelector('[data-settings-save-bar] [role="status"]')?.textContent?.includes('Saving')) return
  }
  throw new Error('Save did not settle')
}

describe('Prompts library and one editor through the real SettingsPanel', () => {
  it('identifies each instruction and searches every object fact without replacing a dirty selected editor', async () => {
    await mount()
    expect(ids()).toEqual(['one', 'two'])
    const second = dom.container.querySelector('[data-prompt-id="two"]')!
    expect(second.textContent).toContain('Two')
    expect(second.textContent).toContain('/two')
    expect(second.textContent).toContain('Review the changes carefully.')
    expect(second.textContent).toContain('Codex only')
    expect(second.textContent).toContain('Done')
    expect(dom.container.querySelectorAll('[data-prompt-editor]')).toHaveLength(1)
    await fill(field('Name'), 'Local name')
    for (const query of ['Two', 'two', 'changes', 'Codex', 'done']) {
      await fill(search(), query)
      expect(ids()).toEqual(['two'])
      expect(editor().dataset.promptEditor).toBe('one')
      expect(field('Name').value).toBe('Local name')
      expect(dom.container.querySelector('.prompt-editor__filtered')!.textContent).toContain('outside your search')
    }
    await open('two')
    expect(field('Prompt').value).toBe(prompts[1]!.body)
    await dom.click('[aria-label="Clear prompt search"]')
    expect(document.activeElement).toBe(search())
    await open('one')
    expect(field('Name').value).toBe('Local name')
    expect(f.owner.current.composerShortcuts).toEqual(prompts)
    expect(api.config.save).not.toHaveBeenCalled()
  })

  it('creates two different objects under a fixed clock, focuses Name and cancels only the latest blank draft', async () => {
    await mount()
    await fill(field('Name'), 'Old dirty name')
    await fill(search(), 'no match')
    vi.spyOn(Date, 'now').mockReturnValue(100)
    await add()
    const first = editor().dataset.promptEditor!
    expect(first).not.toBe('one')
    expect(search().value).toBe('')
    expect(document.activeElement).toBe(field('Name'))
    await fill(field('Name'), 'New draft')
    await add()
    const second = editor().dataset.promptEditor!
    expect(second).not.toBe(first)
    expect(document.activeElement).toBe(field('Name'))
    expect(ids()).toEqual(['one', 'two', first, second])
    await dom.click('.prompt-editor__remove button')
    expect(ids()).toEqual(['one', 'two', first])
    await open(first)
    expect(field('Name').value).toBe('New draft')
    await open('one')
    expect(field('Name').value).toBe('Old dirty name')
    expect(f.owner.current.composerShortcuts).toEqual(prompts)
  })

  it('keeps query, library reading position and all authored fields through Back and Settings section changes', async () => {
    await mount()
    await fill(search(), 'two')
    const list = dom.container.querySelector<HTMLElement>('.prompt-library__items')!
    list.scrollTop = 72
    await open('two')
    await fill(field('Prompt'), '  中文草稿\nsecond line  ')
    await dom.click('.prompt-editor__back')
    expect(dom.container.querySelector<HTMLElement>('.prompt-workbench')!.dataset.view).toBe('library')
    expect(search().value).toBe('two')
    expect(list.scrollTop).toBe(72)
    expect(document.activeElement).toBe(dom.container.querySelector('[data-prompt-id="two"]'))
    await open('two')
    expect(field('Prompt').value).toBe('  中文草稿\nsecond line  ')
    await dom.click('[data-settings-target="general"]')
    await dom.click('[data-settings-target="prompts"]')
    expect(search().value).toBe('two')
    expect(field('Prompt').value).toBe('  中文草稿\nsecond line  ')
    expect(f.owner.current.composerShortcuts).toEqual(prompts)
  })

  it('shows draft expansion and state-button meaning from the same draft without an executable preview', async () => {
    await mount()
    const preview = dom.container.querySelector('[aria-label="Usage preview"]')!
    expect(preview.querySelectorAll('button,input,select,textarea')).toHaveLength(0)
    expect(preview.textContent).toContain('/one')
    expect(preview.textContent).toContain('add your instruction to a draft')
    expect(preview.textContent).toContain('Draft shortcut only')
    const choices = [...dom.container.querySelectorAll<HTMLInputElement>('.prompt-state-settings input')]
    expect(choices.map((input) => input.value)).toEqual([...COMPOSER_PROMPT_STATES])
    await dom.click('.prompt-state-settings input[value="done"]')
    await fill(field('Name'), '大白话说说')
    expect(preview.textContent).toContain('大白话说说')
    expect(preview.textContent).toContain('Button at Done')
    expect(preview.textContent).toContain('Click sends this instruction')
    expect(preview.textContent).toContain('pending questions queue it')
    expect(preview.querySelectorAll('button,input,select,textarea')).toHaveLength(0)
    expect(api.config.save).not.toHaveBeenCalled()
    expect(dom.draft()).toBe('Keep my draft')
  })

  it('removes literal prototype-key identities without reading inherited records as a Prompt', async () => {
    for (const id of ['__proto__', 'constructor']) {
      await act(async () => f.owner.update((current) => ({ ...current, composerShortcuts: [{ id, keyword: id, label: id, body: 'Literal identity' }] })))
      await mount()
      await open(id)
      expect(editor().dataset.promptEditor).toBe(id)
      await dom.click('.prompt-editor__remove button')
      expect(ids()).toEqual([])
      expect(dom.container.querySelector('[data-prompt-editor]')).toBeNull()
      await save()
      expect((await f.disk()).composerShortcuts).toEqual([])
    }
  })

  it('names invalid fields outside a filter and preserves whole-library uniqueness across Provider scopes', async () => {
    await mount()
    await add()
    const addedId = editor().dataset.promptEditor!
    expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.disabled).toBe(true)
    expect(dom.container.querySelector('.prompt-validation')!.textContent).toContain('Keyword: Add a keyword')
    expect(dom.container.querySelector('.prompt-validation')!.textContent).toContain('Prompt: Write the instruction')
    expect(field('Prompt').getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(field('Prompt').getAttribute('aria-describedby')!)!.textContent).toContain('Write the instruction')
    await fill(field('Keyword'), 'one')
    await fill(field('Prompt'), 'A different instruction')
    await fill(search(), 'two')
    const problem = [...dom.container.querySelectorAll<HTMLButtonElement>('.prompt-validation button')].find((button) => button.textContent?.startsWith('one · Keyword:'))!
    expect(problem).not.toBeNull()
    await act(async () => problem.click())
    expect(editor().dataset.promptEditor).toBe(addedId)
    expect(field('Keyword').getAttribute('aria-invalid')).toBe('true')
    expect(field('Keyword').value).toBe('one')
    expect(api.config.save).not.toHaveBeenCalled()
    await fill(field('Keyword'), '  third  ')
    await fill(field('Prompt'), '  exact body\nlast line  ')
    await save()
    expect(f.owner.current.composerShortcuts).toEqual([...prompts, { id: addedId, keyword: 'third', label: 'third', body: '  exact body\nlast line  ' }])
    const [, expected] = vi.mocked(api.config.save).mock.calls[0]!
    expect(expected!.composerShortcuts).toEqual(prompts)
  })
})
