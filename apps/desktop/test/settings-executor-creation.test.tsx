// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentCatalogEntry } from '@agentmux/core'
import type { AgentExecutorConfig, AppConfig } from '../src/shared/contracts'
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
let config: AppConfig, catalog: AgentCatalogEntry[]
beforeEach(async () => {
  config = await api.config.get()
  catalog = await api.providers.list()
  expect(catalog.length).toBeGreaterThan(1)
  useAppStore.setState({ config, providerCatalog: catalog, executorDetections: {}, detectExecutors: vi.fn(async () => {}) })
})
function button(text: string) {
  const found = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)
  expect(found, `Actual connected button ${text}`).toBeDefined()
  return found!
}
async function click(text: string) { await act(async () => button(text).click()) }
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const editor = () => dom.container.querySelector<HTMLElement>('[data-resource-editor]')!
const name = () => editor().querySelector<HTMLInputElement>('[data-executor-name]')!
async function openProviders() { await dom.click('.settings-providers-toggle') }
async function render(onSave: (next: Record<string, AgentExecutorConfig>, expected: Record<string, AgentExecutorConfig>) => Promise<void> = async () => {}) {
  await dom.render(<AgentSettingsPane config={config} onSave={onSave} />)
}

it('entry: an unknown catalog keeps creation reachable and shows an actual failed lookup', async () => {
  useAppStore.setState({ providerCatalog: [] })
  const lookup = vi.spyOn(api.providers, 'list').mockRejectedValue(new Error('Original Host lookup unavailable'))
  await render()
  expect(button('Add executor').disabled, 'Unknown Provider lookup must keep the creation entry operable').toBe(false)
  await click('Add executor')
  expect(lookup).toHaveBeenCalledOnce()
  expect(dom.container.querySelector('[aria-label="Provider catalog"]')).not.toBeNull()
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('Original Host lookup unavailable')
  expect(dom.container.textContent).not.toContain('No providers registered')
  expect(dom.container.querySelector('.settings-resource-count')!.textContent, 'Unknown Provider lookup cannot be presented as a confirmed zero').toBe('Provider catalog')
  expect(dom.container.querySelector('.settings-provider-catalog__empty')).toBeNull()
  expect(dom.container.querySelectorAll('[data-provider-entry]')).toHaveLength(0)
  expect(button('Retry providers').disabled).toBe(false)
  expect(useAppStore.getState().config).toBe(config)
})

it('publication: retry publishes the confirmed catalog and creates the exact chosen Provider', async () => {
  useAppStore.setState({ providerCatalog: [] })
  const lookup = vi.spyOn(api.providers, 'list').mockRejectedValueOnce(new Error('Retry this read')).mockResolvedValueOnce(catalog)
  const save = vi.fn(async (_next: Record<string, AgentExecutorConfig>, _expected: Record<string, AgentExecutorConfig>) => {})
  await render(save); await click('Add executor'); await click('Retry providers')
  expect(lookup).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().providerCatalog, 'Confirmed Provider catalog is published for creation').toEqual(catalog)
  expect(dom.container.querySelectorAll('[data-provider-entry]')).toHaveLength(catalog.length)
  const selected = catalog[1]!
  await dom.click(`[data-provider-entry="${selected.id}"] button`)
  expect(name().isConnected).toBe(true); expect(document.activeElement).toBe(name())
  expect(name().selectionStart).toBe(0); expect(name().selectionEnd).toBe(name().value.length)
  const id = editor().dataset.resourceEditor!
  await click('Save executors')
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ [id]: expect.objectContaining({ providerId: selected.id, command: selected.executable }) }), config.executors)
  expect(useAppStore.getState().detectExecutors).toHaveBeenCalledOnce()
})

it('distinguishes a confirmed empty catalog from the unknown initial projection', async () => {
  useAppStore.setState({ providerCatalog: [] })
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  await render(); await click('Add executor')
  expect(dom.container.textContent).toContain('No providers registered')
  expect(dom.container.textContent).toContain('returned an empty provider catalog')
  expect(dom.container.querySelector('.settings-resource-count')!.textContent).toBe('0 providers')
  expect(dom.container.querySelectorAll('[data-provider-entry]')).toHaveLength(0)
  expect(button('Refresh providers').disabled).toBe(false)
})

it('browses all actual catalog identities without probing or claiming installed commands', async () => {
  const lookup = vi.spyOn(api.providers, 'list')
  await render(); await openProviders()
  expect(lookup).not.toHaveBeenCalled()
  for (const provider of catalog) {
    const entry = dom.container.querySelector(`[data-provider-entry="${provider.id}"]`)!
    expect(entry.textContent).toContain(provider.label)
    expect(entry.textContent).toContain(provider.executable)
    expect(entry.textContent).toContain(provider.capabilities.providerResume ? 'Native resume' : 'No native resume')
  }
  expect(dom.container.textContent).toContain('Command availability is checked separately')
  expect(dom.container.querySelectorAll('[data-resource-editor]')).toHaveLength(0)
  expect(useAppStore.getState().detectExecutors).toHaveBeenCalledOnce()
})

it('a failed refresh preserves the exact last catalog and the authored Executor draft', async () => {
  vi.spyOn(api.providers, 'list').mockRejectedValue(new Error('Read failed after earlier success'))
  await render(); await fill(name(), 'Keep this authored name'); await openProviders()
  await click('Refresh providers')
  expect(useAppStore.getState().providerCatalog).toBe(catalog)
  expect(dom.container.querySelectorAll('[data-provider-entry]')).toHaveLength(catalog.length)
  expect(dom.container.textContent).toContain('last received providers remain')
  await click('Executors')
  expect(name().value).toBe('Keep this authored name')
  expect(button('Save executors').disabled).toBe(false)
})

const providerSelect = () => editor().querySelector<HTMLSelectElement>('[data-executor-provider]')!
async function changeProvider(id: string) {
  const node = providerSelect()
  await act(async () => { node.focus(); node.value = id; node.dispatchEvent(new Event('change', { bubbles: true })) })
}
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const node = [...editor().querySelectorAll('label')].find(node => node.querySelector('span')?.textContent?.startsWith(label))!
  return node.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!
}
async function openLaunch() {
  const details = editor().querySelector<HTMLDetailsElement>('.settings-launch-config')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
}

it('identity: new configurations use short Provider identities without reusing a removed sequence', async () => {
  await render()
  await click('Add executor'); const first = editor().dataset.resourceEditor!
  await click('Add executor'); const second = editor().dataset.resourceEditor!
  expect(second).not.toBe(first)
  await dom.click('.settings-executor-remove button')
  await click('Add executor'); const third = editor().dataset.resourceEditor!
  expect(third, 'New Executor identity must not reuse the removed Provider sequence').not.toBe(second)
  for (const id of [first, second, third]) expect(id).toMatch(new RegExp(`^${catalog[0]!.id}-[0-9a-f]{8}$`))
  await fill(name(), 'Renamed independent configuration')
  expect(editor().dataset.resourceEditor).toBe(third)
  await changeProvider(catalog[0]!.id)
  expect(editor().dataset.resourceEditor).toBe(third)
  await changeProvider(catalog[1]!.id)
  expect(editor().dataset.resourceEditor).toMatch(new RegExp(`^${catalog[1]!.id}-[0-9a-f]{8}$`))
  expect(name().value).toBe('Renamed independent configuration')
  expect(providerSelect().isConnected).toBe(true); expect(document.activeElement).toBe(providerSelect())
  expect(field('Command').value).toBe(catalog[1]!.executable)
  expect(Object.keys(config.executors)).not.toContain(first)
})

it('keeps the complete unsaved draft, custom command, disclosure and focus when changing Provider', async () => {
  const save = vi.fn(async (_next: Record<string, AgentExecutorConfig>, _expected: Record<string, AgentExecutorConfig>) => {})
  await render(save); await click('Add executor'); const oldId = editor().dataset.resourceEditor!
  await openLaunch(); await fill(name(), 'My authored agent')
  await fill(field('Command'), 'my-custom-command'); await fill(field('Arguments'), '--model "literal model"')
  await fill(field('Environment'), '{"LITERAL":"$HOME stays literal"}')
  await fill(editor().querySelector<HTMLInputElement>('input[type="color"]')!, '#112233')
  const badge = editor().querySelector<HTMLSelectElement>('[aria-label="My authored agent avatar icon"]')!
  await act(async () => { badge.value = badge.options[1]!.value; badge.dispatchEvent(new Event('change', { bubbles: true })) })
  await dom.click('.agent-guide-toggle input')
  await changeProvider(catalog[1]!.id); const nextId = editor().dataset.resourceEditor!
  expect(nextId).not.toBe(oldId); expect(name().value).toBe('My authored agent')
  expect(editor().querySelector<HTMLDetailsElement>('.settings-launch-config')!.open).toBe(true)
  expect(field('Command').value).toBe('my-custom-command')
  expect(field('Arguments').value).toBe('--model "literal model"')
  expect(field('Environment').value).toBe('{"LITERAL":"$HOME stays literal"}')
  expect(editor().querySelector<HTMLInputElement>('input[type="color"]')!.value).toBe('#112233')
  expect(document.activeElement).toBe(providerSelect())
  await openProviders(); await click('Executors')
  expect(document.activeElement).toBe(name()); expect(name().isConnected).toBe(true)
  await click('Save executors')
  expect(save.mock.calls[0]![0]).not.toHaveProperty(oldId)
  expect(save.mock.calls[0]![0]).toHaveProperty(nextId, expect.objectContaining({
    providerId: catalog[1]!.id, label: 'My authored agent', command: 'my-custom-command',
    args: ['--model', 'literal model'], env: { LITERAL: '$HOME stays literal' }, injectAgentMuxGuide: false,
    avatar: { tint: '#112233', badge: badge.options[1]!.value }
  }))
})

it.each(['draft', 'config', 'expected'] as const)('rerolls a forced short code collision against %s without replacing its authored object', async kind => {
  const provider = catalog[0]!, reserved = `${provider.id}-deadbeef`, accepted = `${provider.id}-cafebabe`
  const uuid = (prefix: string) => `${prefix}-1111-4111-8111-111111111111` as `${string}-${string}-${string}-${string}-${string}`
  const random = vi.spyOn(crypto, 'randomUUID')
  if (kind === 'draft') {
    random.mockReturnValueOnce(uuid('deadbeef'))
    await render(); await click('Add executor'); await fill(name(), 'Keep the first authored draft')
  } else {
    config = { ...config, executors: { [reserved]: { ...Object.values(config.executors)[0]!, label: 'Keep the reserved configuration', providerId: provider.id } } }
    await render(); await dom.click('.settings-executor-remove button')
    if (kind === 'expected') {
      // A local deletion keeps its authored baseline when a concurrent writer removes the saved object.
      config = { ...config, executors: {} }; await render()
    }
  }
  random.mockReturnValueOnce(uuid('deadbeef')).mockReturnValueOnce(uuid('cafebabe'))
  await click('Add executor')
  expect(editor().dataset.resourceEditor).toBe(accepted)
  expect(random.mock.calls.length).toBe(kind === 'draft' ? 3 : 2)
  if (kind === 'draft') {
    await dom.click(`[data-resource-row="${reserved}"]`)
    expect(name().value).toBe('Keep the first authored draft')
  } else if (kind === 'config') expect(config.executors[reserved]!.label).toBe('Keep the reserved configuration')
})

it('fixes a newly captured Provider and identity while saving and retains later field edits', async () => {
  let resolve!: () => void
  const save = vi.fn(async (_next: Record<string, AgentExecutorConfig>, _expected: Record<string, AgentExecutorConfig>) => { await new Promise<void>(done => { resolve = done }) })
  await render(save); await click('Add executor'); const id = editor().dataset.resourceEditor!
  await fill(name(), 'Captured name'); await click('Save executors')
  expect(providerSelect().disabled).toBe(true); expect(button('Add executor').disabled).toBe(true)
  expect(save.mock.calls[0]![0][id]!.providerId).toBe(catalog[0]!.id)
  await fill(name(), 'After submission')
  await act(async () => resolve())
  expect(editor().dataset.resourceEditor).toBe(id); expect(name().value).toBe('After submission')
  expect(editor().querySelector('[data-executor-provider]')).toBeNull()
  expect(editor().querySelector('.settings-executor-identity')!.textContent).toContain(id)
})

it('preserves authored save baselines and post-submission edits while browsing Providers', async () => {
  let resolve!: () => void
  const pending = new Promise<void>(done => { resolve = done })
  const save = vi.fn(async (_next: Record<string, AgentExecutorConfig>, _expected: Record<string, AgentExecutorConfig>) => { await pending })
  await render(save); const originalId = editor().dataset.resourceEditor!
  await fill(name(), 'Submitted name'); await click('Save executors')
  await openProviders()
  expect(dom.container.querySelector('[aria-label="Provider catalog"]')).not.toBeNull()
  expect(dom.container.querySelector<HTMLButtonElement>('[data-provider-entry] button')!.disabled).toBe(true)
  await click('Executors'); await fill(name(), 'After submission')
  await act(async () => resolve())
  expect(name().value).toBe('After submission')
  await click('Save executors')
  expect(save.mock.calls[1]![1][originalId]!.label).toBe('Submitted name')
  expect(save.mock.calls[1]![0][originalId]!.label).toBe('After submission')
})

it('a fresh exact Executor navigation leaves Providers and preserves the original draft', async () => {
  const id = Object.keys(config.executors)[0]!
  await render(); await fill(name(), 'Exact original draft'); await openProviders()
  await dom.render(<AgentSettingsPane config={config} onSave={async () => {}} navigationRequest={{ section: 'agents', executorId: id }} />)
  expect(dom.container.querySelector('[aria-label="Provider catalog"]')).toBeNull()
  expect(editor().dataset.resourceEditor).toBe(id)
  expect(name().value).toBe('Exact original draft'); expect(document.activeElement).toBe(name())
})
