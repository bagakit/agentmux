// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { executeSettingsResourcesControl as execute } from '../src/main/settings-resources-control'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const prompts = [
  { id: 'a', keyword: 'a', label: 'A', body: 'First instruction' },
  { id: 'b', keyword: 'b', label: 'B', body: 'Second instruction' },
  { id: 'c', keyword: 'c', label: 'C', body: 'Third instruction' }
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
const ids = () => [...dom.container.querySelectorAll<HTMLElement>('[data-prompt-id]')].map((node) => node.dataset.promptId)
const summary = () => dom.container.querySelector('.prompt-save-summary')!.textContent
const undo = () => dom.container.querySelector<HTMLButtonElement>('.prompt-pending-delete button')
const saveButton = () => dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
async function mount() { await dom.render(<SettingsPanel initialSection="prompts" onClose={() => {}} />) }
async function open(id: string) { await dom.click(`[data-prompt-id="${id}"]`) }
async function remove(id: string) { await open(id); await dom.click('.prompt-editor__remove button') }
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  expect(node).not.toBeNull()
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function settled() {
  for (let attempt = 0; attempt < 300; attempt++) {
    await act(async () => { await new Promise((done) => setTimeout(done, 10)) })
    if (!dom.container.querySelector('[data-settings-save-bar] [role="status"]')?.textContent?.includes('Saving')) return
  }
  throw new Error('Durable Prompt save did not settle')
}
async function save() { await dom.click('[data-settings-save-bar] button'); await settled() }
async function external(id: string, changes: Record<string, string>) {
  await act(async () => { await execute({ requestId: 'external', schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'settings.resource.update', resource: 'prompts', id, changes }, f.owner) })
}

describe('whole-library Prompt saves and the most recent local deletion', () => {
  it('derives changed and pending-deletion facts from the entire library and undoes the exact authored object', async () => {
    await mount()
    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(summary()).toBe('Save prompts updates the whole library. 0 changed · 0 pending deletions.')
    await fill(field('Name'), 'Local A')
    await fill(field('Prompt'), '  authored A\nlast line  ')
    await remove('a')
    await open('c'); await fill(field('Name'), 'Local C')
    expect(summary()).toContain('1 changed · 1 pending deletion.')
    expect(dom.container.querySelector('.prompt-pending-delete')!.textContent).toContain('Recently removed “Local A”.')
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
    await dom.click('.prompt-pending-delete button')
    expect(ids()).toEqual(['b', 'c', 'a'])
    expect(field('Name').value).toBe('Local A')
    expect(field('Prompt').value).toBe('  authored A\nlast line  ')
    expect(summary()).toContain('2 changed · 0 pending deletions.')
    expect(undo()).toBeNull()
    await open('c'); expect(field('Name').value).toBe('Local C')
    await save()
    expect(f.owner.current.composerShortcuts).toEqual([{ ...prompts[0], label: 'Local A', body: '  authored A\nlast line  ' }, prompts[1], { ...prompts[2], label: 'Local C' }])
    expect(vi.mocked(api.config.save).mock.calls[0]![1]!.composerShortcuts).toEqual(prompts)
    expect(summary()).toContain('0 changed · 0 pending deletions.')
  })

  it('keeps only the latest deletion available without turning Cancel new prompt into a saved deletion', async () => {
    await mount(); await remove('a'); await remove('b')
    expect(ids()).toEqual(['c'])
    expect(summary()).toContain('0 changed · 2 pending deletions.')
    expect(dom.container.querySelector('.prompt-pending-delete')!.textContent).toContain('“B”')
    await dom.click('.prompt-workbench__toolbar button')
    expect(dom.container.querySelector('.prompt-editor__remove')!.textContent).toContain('Cancel new prompt')
    await dom.click('.prompt-editor__remove button')
    expect(ids()).toEqual(['c'])
    expect(dom.container.querySelector('.prompt-pending-delete')!.textContent).toContain('“B”')
    await dom.click('.prompt-pending-delete button')
    expect(ids()).toEqual(['c', 'b'])
    expect(summary()).toContain('0 changed · 1 pending deletion.')
    await save()
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1], prompts[2]])
    expect(undo()).toBeNull()
  })

  it('retains deletion and its original whole-library expectation after failure, then clears only committed deletion', async () => {
    await mount(); await remove('a')
    vi.mocked(api.config.save).mockRejectedValueOnce(new Error('disk unavailable'))
    await save()
    expect(ids()).toEqual(['b', 'c'])
    expect(undo()).not.toBeNull()
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toBe('disk unavailable')
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
    await save()
    expect(vi.mocked(api.config.save).mock.calls.map(([, expected]) => expected!.composerShortcuts)).toEqual([prompts, prompts])
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1], prompts[2]])
    expect(undo()).toBeNull()
    expect(saveButton().disabled).toBe(true)
  })

  it('commits A deletion while preserving B deletion, its Undo and C input authored during the pending reply', async () => {
    await mount(); await remove('a')
    const pending = deferred<void>(), published = deferred<void>(), realSave = vi.mocked(api.config.save).getMockImplementation()!
    vi.mocked(api.config.save).mockImplementationOnce(async (next, expected) => { const result = await realSave(next, expected); published.resolve(); await pending.promise; return result })
    await dom.click('[data-settings-save-bar] button')
    await act(async () => { await published.promise })
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1], prompts[2]])
    await remove('b'); await open('c'); await fill(field('Prompt'), '  later C\nexact bytes  ')
    expect(saveButton().disabled).toBe(true)
    expect(summary()).toContain('1 changed · 2 pending deletions.')
    await act(async () => pending.resolve()); await settled()
    expect(ids()).toEqual(['c'])
    expect(summary()).toContain('1 changed · 1 pending deletion.')
    expect(undo()).not.toBeNull()
    expect(dom.container.querySelector('.prompt-pending-delete')!.textContent).toContain('“B”')
    expect(saveButton().disabled).toBe(false)
    expect(field('Prompt').value).toBe('  later C\nexact bytes  ')
    await dom.click('.prompt-pending-delete button')
    expect(ids()).toEqual(['c', 'b'])
    await open('c'); expect(field('Prompt').value).toBe('  later C\nexact bytes  ')
    await save()
    expect(vi.mocked(api.config.save).mock.calls[1]![1]!.composerShortcuts).toEqual([prompts[1], prompts[2]])
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1], { ...prompts[2], body: '  later C\nexact bytes  ' }])
  }, 15_000)

  it('keeps Undo performed during saving as a new unsaved restoration after Main has deleted the original', async () => {
    await mount(); await fill(field('Name'), 'Authored A'); await remove('a')
    const pending = deferred<void>(), published = deferred<void>(), realSave = vi.mocked(api.config.save).getMockImplementation()!
    vi.mocked(api.config.save).mockImplementationOnce(async (next, expected) => { const result = await realSave(next, expected); published.resolve(); await pending.promise; return result })
    await dom.click('[data-settings-save-bar] button'); await act(async () => { await published.promise })
    await dom.click('.prompt-pending-delete button')
    await fill(field('Prompt'), 'Edited after restoration')
    await act(async () => pending.resolve()); await settled()
    expect(ids()).toEqual(['b', 'c', 'a'])
    expect(field('Name').value).toBe('Authored A')
    expect(field('Prompt').value).toBe('Edited after restoration')
    expect(summary()).toContain('1 changed · 0 pending deletions.')
    expect(saveButton().disabled).toBe(false)
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1], prompts[2]])
    await save()
    expect(vi.mocked(api.config.save).mock.calls[1]![1]!.composerShortcuts).toEqual([prompts[1], prompts[2]])
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1], prompts[2], { ...prompts[0], label: 'Authored A', body: 'Edited after restoration' }])
  }, 15_000)

  it('accepts disjoint publication fields after Undo while retaining the authored Name baseline', async () => {
    await mount(); await fill(field('Name'), 'Local A'); await remove('a')
    await external('a', { body: 'External body' })
    await dom.click('.prompt-pending-delete button')
    expect(field('Name').value).toBe('Local A')
    expect(field('Prompt').value).toBe('External body')
    await save()
    expect(vi.mocked(api.config.save).mock.calls[0]![1]!.composerShortcuts).toEqual([{ ...prompts[0], body: 'External body' }, prompts[1], prompts[2]])
    expect((await f.disk()).composerShortcuts).toEqual([{ ...prompts[0], label: 'Local A', body: 'External body' }, prompts[1], prompts[2]])
  })

  it('keeps same-field publication conflict after Undo instead of blessing the external value as its expectation', async () => {
    await mount(); await fill(field('Name'), 'Local A'); await remove('a')
    await external('a', { label: 'External A' }); const bytes = await f.bytes()
    await dom.click('.prompt-pending-delete button'); await save()
    expect(field('Name').value).toBe('Local A')
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('composerShortcuts.a.label')
    expect(await f.bytes()).toBe(bytes)
    await save()
    expect(vi.mocked(api.config.save).mock.calls.map(([, expected]) => expected!.composerShortcuts)).toEqual([prompts, prompts])
  })

  it('does not revive an externally deleted authored object after Undo and retains the original failed expectation', async () => {
    await mount(); await fill(field('Name'), 'Local A'); await remove('a')
    await act(async () => { await execute({ requestId: 'delete', schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'settings.resource.remove', resource: 'prompts', id: 'a' }, f.owner) })
    const bytes = await f.bytes()
    await dom.click('.prompt-pending-delete button'); await save()
    expect(field('Name').value).toBe('Local A')
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('composerShortcuts.a')
    expect(await f.bytes()).toBe(bytes)
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1], prompts[2]])
    expect(vi.mocked(api.config.save).mock.calls[0]![1]!.composerShortcuts).toEqual(prompts)
  })

  it('does not overwrite a current same-ID object reached through pending Undo, redelete and a public resource add', async () => {
    const observed = await execute({ requestId: 'observe-id', schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'settings.resource.get', resource: 'prompts', id: 'a' }, f.owner)
    expect(observed.operation).toBe('settings.resource.get')
    if (observed.operation !== 'settings.resource.get') throw new Error('Expected public get')
    const originalId = observed.item.id
    expect(originalId).toBe('a')
    await mount(); await remove(originalId)
    const pending = deferred<void>(), published = deferred<void>(), realSave = vi.mocked(api.config.save).getMockImplementation()!
    vi.mocked(api.config.save).mockImplementationOnce(async (next, expected) => { const result = await realSave(next, expected); published.resolve(); await pending.promise; return result })
    await dom.click('[data-settings-save-bar] button'); await act(async () => { await published.promise })
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1], prompts[2]])
    await dom.click('.prompt-pending-delete button'); await fill(field('Name'), 'Restored authored A'); await remove(originalId)
    await act(async () => pending.resolve()); await settled()
    expect(ids()).toEqual(['b', 'c'])
    expect(summary()).toContain('0 changed · 0 pending deletions.')
    expect(undo()).not.toBeNull()
    expect(dom.container.querySelector('.prompt-pending-delete')!.textContent).toContain('Recently removed “Restored authored A”.')

    const added = { keyword: 'new-a', label: 'Published new A', body: 'Publicly authored new instruction' }
    await act(async () => {
      const result = await execute({ requestId: 'explicit-known-id-add', schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'settings.resource.add', resource: 'prompts', id: originalId, value: added }, f.owner)
      expect(result.operation).toBe('settings.resource.add')
    })
    expect(ids()).toEqual(['b', 'c', originalId])
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1], prompts[2], { id: originalId, ...added }])
    expect(undo()).not.toBeNull()
    await open(originalId); await fill(field('Prompt'), 'Further local edit of the new object')
    await dom.click('.prompt-pending-delete button')
    expect(field('Name').value).toBe('Published new A')
    expect(field('Keyword').value).toBe('new-a')
    expect(field('Prompt').value).toBe('Further local edit of the new object')
    expect(undo()).toBeNull()
    expect(summary()).toContain('1 changed · 0 pending deletions.')
    await save()
    expect(vi.mocked(api.config.save).mock.calls[1]![1]!.composerShortcuts).toEqual([prompts[1], prompts[2], { id: originalId, ...added }])
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1], prompts[2], { id: originalId, ...added, body: 'Further local edit of the new object' }])
  }, 15_000)
})
