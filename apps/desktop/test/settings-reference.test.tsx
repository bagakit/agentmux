// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
let ids: string[]
beforeEach(async () => {
  const config = await api.config.get()
  ids = Object.keys(config.executors)
  expect(ids.length).toBeGreaterThan(1)
  useAppStore.setState({ config, providerCatalog: await api.providers.list(), executorDetections: {}, detectExecutors: vi.fn(async () => {}) })
})
async function fill(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const name = () => dom.container.querySelector<HTMLInputElement>('[data-executor-name]')!
const provider = (id: string) => dom.click(`[aria-label="Providers"] [data-resource-row="provider:${id}"]`)
async function scope(value: 'templates' | 'host') {
  const node = dom.container.querySelector<HTMLSelectElement>('[aria-label="Executor configuration scope"]')!
  await act(async () => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })) })
}
it('sidebar: named groups and exact routes remain available through the registered Settings shell', async () => {
  const close = vi.fn()
  await dom.render(<SettingsPanel initialSection="agents" onClose={close} />)
  expect([...dom.container.querySelectorAll('[data-settings-group]')].map(node => node.textContent)).toEqual(['Preferences', 'Message Tool', 'Connections', 'Mods', 'Resources', 'Work', 'Mote'])
  await dom.click('[data-settings-target="general"]')
  expect(dom.container.querySelector('.settings-page')!.getAttribute('data-settings-page')).toBe('general')
  expect(dom.container.querySelector('.settings-content__breadcrumb')!.textContent).toBe('Preferences')
  await dom.click('[aria-label="Close settings"]'); expect(close).toHaveBeenCalledOnce()
})
it('selection: horizontal Provider context and vertical Executor selection reach one exact editor', async () => {
  await dom.render(<SettingsPanel initialSection="agents" onClose={() => {}} />)
  expect(dom.container.querySelector('[aria-label="Providers"]')!.getAttribute('aria-orientation')).toBe('horizontal')
  const list = dom.container.querySelector('[aria-label="Executors"]')!
  expect(list.getAttribute('aria-orientation')).toBe('vertical')
  const rows = list.querySelectorAll<HTMLButtonElement>('[data-resource-row]')
  rows[0]!.focus()
  await act(async () => rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement).toBe(rows[1])
  expect(rows[0]!.getAttribute('aria-selected')).toBe('true')
  await act(async () => rows[1]!.click())
  expect(dom.container.querySelectorAll('[data-resource-editor]')).toHaveLength(1)
  expect(dom.container.querySelector<HTMLElement>('[data-resource-editor]')!.dataset.resourceEditor).toBe(ids[1])
  expect(document.activeElement).toBe(name())
})
it('drafts: Provider scope and sidebar roundtrips preserve authored objects and whole-library save', async () => {
  const save = vi.spyOn(api.config, 'save'), config = useAppStore.getState().config!
  await dom.render(<SettingsPanel initialSection="agents" onClose={() => {}} />)
  await fill(name(), 'Authored before browsing')
  const other = useAppStore.getState().providerCatalog.find(entry => entry.id !== config.executors[ids[0]!]!.providerId)!
  await provider(other.id)
  expect(dom.container.querySelectorAll('[aria-label="Executors"] [data-resource-row]')).toHaveLength(Object.values(config.executors).filter(entry => entry.providerId === other.id).length)
  await dom.click('[data-settings-target="general"]'); await dom.click('[data-settings-target="agents"]')
  await provider(config.executors[ids[0]!]!.providerId)
  expect(name().value).toBe('Authored before browsing')
  await dom.click('[data-settings-save-bar] button')
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ executors: expect.objectContaining({ [ids[0]!]: expect.objectContaining({ label: 'Authored before browsing' }) }) }), expect.anything())
  expect(Object.keys(save.mock.calls[0]![0].executors)).toEqual(ids)
})
it('creation: a selected Provider creates its precise launch configuration in the same workbench', async () => {
  await dom.render(<SettingsPanel initialSection="agents" onClose={() => {}} />)
  const chosen = useAppStore.getState().providerCatalog[1]!
  await provider(chosen.id)
  await dom.click('.settings-executor-toolbar .small-button')
  expect(dom.container.querySelector<HTMLSelectElement>('[data-executor-provider]')!.value).toBe(chosen.id)
  expect(name().value).toContain(chosen.label)
  expect(document.activeElement).toBe(name())
  expect(dom.container.querySelector('[aria-label="Providers"] [aria-selected="true"]')!.getAttribute('data-resource-row')).toBe(`provider:${chosen.id}`)
})
it('Host registration retains its own draft and does not inherit the global Provider filter', async () => {
  await dom.render(<SettingsPanel initialSection="agents" onClose={() => {}} />)
  await scope('host')
  const register = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Register command'))!
  await act(async () => register.click())
  await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Host Executor name"]')!, 'Authored Host wrapper')
  await scope('templates'); await provider(useAppStore.getState().providerCatalog[1]!.id); await scope('host')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Host Executor name"]')!.value).toBe('Authored Host wrapper')
  expect(dom.container.querySelector('[aria-label="Provider catalog"]')!.closest('[hidden]')).not.toBeNull()
})
