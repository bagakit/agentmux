// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { ComposerShortcut } from '../src/shared/contracts'
import { composerShortcutsForProvider } from '@agentmux/client-ui/composer-command-candidates'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const prompts: ComposerShortcut[] = [
  { id: 'shared', keyword: 'shared', label: 'Shared instruction', body: 'A shared instruction.' },
  { id: 'codex-only', keyword: 'codex-only', label: 'Codex review', body: 'Review this exact change.', providerId: 'codex', states: ['running'], reactionIcon: 'check' },
  { id: 'custom', keyword: 'custom', label: 'Custom adapter instruction', body: 'Keep this unlisted Provider.', providerId: 'custom-harness' }
]
let owner: Awaited<ReturnType<typeof configOwnerFixture>>
beforeEach(async () => {
  owner = await configOwnerFixture({ composerShortcuts: prompts })
  const publish = owner.publish.getMockImplementation()!
  owner.publish.mockImplementation(saved => { publish(saved); useAppStore.setState({ config: saved }) })
  useAppStore.setState({ config: owner.owner.current, providerCatalog: [] })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => await owner.owner.edit(expected!, next))
})
const ids = () => [...dom.container.querySelectorAll<HTMLElement>('[data-prompt-id]')].map(node => node.dataset.promptId)
const editor = () => dom.container.querySelector<HTMLElement>('[data-prompt-editor]')!
const field = (name: string) => [...editor().querySelectorAll<HTMLLabelElement>('label')]
  .find(label => label.querySelector('span')?.textContent === name)!.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!
const provider = () => dom.container.querySelector<HTMLSelectElement>('[aria-label="Prompt Provider scope"]')!
const currentScope = () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Prompt authoring scope"] [aria-pressed="true"]')!
async function mount() { await dom.render(<SettingsPanel initialSection="prompts" onClose={() => {}} />) }
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function selectScope(scope: string) {
  await dom.click(scope === 'all' || scope === 'shared' ? `[data-prompt-scope="${scope}"]` : `[data-prompt-scope-provider="${scope}"]`)
}
async function bind(value: string) { await act(async () => { provider().value = value; provider().dispatchEvent(new Event('change', { bubbles: true })) }) }
async function save() {
  await dom.click('[data-settings-save-bar] button')
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(done => setTimeout(done, 5)) })
    if (!dom.container.querySelector('[data-settings-save-bar] [role="status"]')?.textContent?.includes('Saving')) return
  }
  throw new Error('The original ConfigOwner save did not settle')
}

it('filters exact authoring scopes without replacing runtime applicability or hiding unknown Provider bindings', async () => {
  await mount()
  expect(ids()).toEqual(['shared', 'codex-only', 'custom'])
  await selectScope('shared')
  expect(ids()).toEqual(['shared'])
  await selectScope('codex')
  expect(ids(), 'Authoring lists only explicitly bound Prompts').toEqual(['codex-only'])
  expect(composerShortcutsForProvider(owner.owner.current.composerShortcuts!, 'codex').map(item => item.id), 'Runtime still offers shared plus matching Prompts').toEqual(['shared', 'codex-only'])
  await selectScope('custom-harness')
  expect(ids()).toEqual(['custom'])
  expect(currentScope().textContent).toContain('custom-harness')
  expect(api.config.save).not.toHaveBeenCalled()
})

it('inherits a specific scope only on explicit Add and preserves Shared creation from All or Shared', async () => {
  await mount()
  const created: Array<{ id: string; providerId?: string }> = []
  for (const scope of ['custom-harness', 'shared', 'all']) {
    await selectScope(scope)
    await dom.click('.prompt-workbench__toolbar button')
    const id = editor().dataset.promptEditor!
    expect(document.activeElement).toBe(field('Name'))
    expect(provider().value).toBe(scope === 'custom-harness' ? scope : '')
    expect(dom.container.querySelector(`[data-prompt-id="${id}"] [data-prompt-list-status="invalid"]`)).not.toBeNull()
    created.push({ id, ...(scope === 'custom-harness' ? { providerId: scope } : {}) })
    await fill(field('Keyword'), `added-${created.length}`)
    await fill(field('Prompt'), `Exact instruction ${created.length}`)
  }
  expect(new Set(created.map(item => item.id)).size).toBe(3)
  await save()
  const saved = (await owner.disk()).composerShortcuts!
  expect(saved.slice(0, 3)).toEqual(prompts)
  for (const item of created) {
    const actual = saved.find(prompt => prompt.id === item.id)!
    expect(actual.providerId).toBe(item.providerId)
  }
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.composerShortcuts).toEqual(prompts)
})

it('retains an empty explicit scope, exact outside-filter editor and whole-library baseline after rebinding', async () => {
  await mount()
  await selectScope('custom-harness')
  await dom.click('[data-prompt-id="custom"]')
  const body = field('Prompt')
  await fill(body, '  中文 draft\nkeep literal body  ')
  await bind('')
  expect(ids()).toEqual([])
  expect(currentScope().dataset.promptScopeProvider).toBe('custom-harness')
  expect(currentScope().textContent).toContain('0')
  expect(editor().dataset.promptEditor).toBe('custom')
  expect(field('Prompt')).toBe(body)
  expect(body.value).toBe('  中文 draft\nkeep literal body  ')
  expect(dom.container.querySelector('.prompt-editor__filtered')!.textContent).toContain('outside your search or scope')
  await dom.click('.prompt-editor__filtered button')
  expect(currentScope().dataset.promptScope).toBe('all')
  expect(ids()).toEqual(['shared', 'codex-only', 'custom'])
  expect(document.activeElement).toBe(dom.container.querySelector('[data-prompt-id="custom"]'))
  await save()
  expect((await owner.disk()).composerShortcuts).toEqual([prompts[0], prompts[1], { id: 'custom', keyword: 'custom', label: 'Custom adapter instruction', body: '  中文 draft\nkeep literal body  ' }])
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.composerShortcuts).toEqual(prompts)
})

it('keeps full-library edits, status/reply bindings and exact ID when deleting and undoing inside a Provider scope', async () => {
  await mount()
  await fill(field('Name'), 'Shared authored name')
  expect(dom.container.querySelector('[data-prompt-id="shared"] [data-prompt-list-status="unsaved"]')).not.toBeNull()
  await selectScope('codex')
  await dom.click('[data-prompt-id="codex-only"]')
  await fill(field('Prompt'), 'Authored reply and status instruction')
  await dom.click('.prompt-editor__remove button')
  expect(ids()).toEqual([])
  expect(currentScope().dataset.promptScopeProvider).toBe('codex')
  await dom.click('.prompt-pending-delete button')
  expect(editor().dataset.promptEditor).toBe('codex-only')
  expect(ids()).toEqual(['codex-only'])
  expect(field('Prompt').value).toBe('Authored reply and status instruction')
  await save()
  expect((await owner.disk()).composerShortcuts).toEqual([{ ...prompts[0], label: 'Shared authored name' }, { ...prompts[1], body: 'Authored reply and status instruction' }, prompts[2]])
  expect(dom.container.querySelector('[data-prompt-list-status]')).toBeNull()
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.composerShortcuts).toEqual(prompts)
})

it('preserves each Prompt disclosure choice and the connected instruction node across object selection', async () => {
  await mount()
  const body = field('Prompt')
  const details = () => editor().querySelector<HTMLDetailsElement>('.prompt-editor__usage')!
  expect(details().open).toBe(false)
  await act(async () => { details().open = true; details().dispatchEvent(new Event('toggle', { bubbles: true })) })
  await dom.click('[data-prompt-id="codex-only"]')
  expect(details().open).toBe(false)
  expect(field('Prompt')).toBe(body)
  await dom.click('[data-prompt-id="shared"]')
  expect(details().open).toBe(true)
  expect(field('Prompt')).toBe(body)
  expect(api.config.save).not.toHaveBeenCalled()
})
