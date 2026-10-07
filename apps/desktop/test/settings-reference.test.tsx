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
it('selection: horizontal focus and exact object selection reach a single detail through SettingsPanel', async () => {
  await dom.render(<SettingsPanel initialSection="agents" onClose={() => {}} />)
  const list = dom.container.querySelector('[aria-label="Executors"]')!
  expect(list.getAttribute('aria-orientation')).toBe('horizontal')
  const rows = list.querySelectorAll<HTMLButtonElement>('[data-resource-row]')
  rows[0]!.focus()
  await act(async () => rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(document.activeElement).toBe(rows[1])
  expect(rows[0]!.getAttribute('aria-selected')).toBe('true')
  await act(async () => rows[1]!.click())
  expect(dom.container.querySelectorAll('[data-resource-editor]')).toHaveLength(1)
  expect(dom.container.querySelector<HTMLElement>('[data-resource-editor]')!.dataset.resourceEditor).toBe(ids[1])
  expect(document.activeElement).toBe(name())
})
it('drafts: sidebar and Provider navigation keep the authored exact Executor and whole-library save', async () => {
  const save = vi.spyOn(api.config, 'save')
  const close = vi.fn()
  await dom.render(<SettingsPanel initialSection="agents" onClose={close} />)
  await fill(name(), 'Authored before browsing')
  await dom.click('.settings-providers-toggle')
  await dom.click('[data-settings-target="general"]')
  await dom.click('[data-settings-target="agents"]')
  const back = [...dom.container.querySelectorAll<HTMLButtonElement>('.settings-agent-navigation button')].find(node => node.textContent === 'Executors')!
  await act(async () => back.click())
  expect(name().value, 'Cross-view navigation retains authored drafts').toBe('Authored before browsing')
  await dom.click('[data-settings-save-bar] button')
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ executors: expect.objectContaining({ [ids[0]!]: expect.objectContaining({ label: 'Authored before browsing' }) }) }), expect.anything())
  await dom.click('[aria-label="Close settings"]')
  expect(close).toHaveBeenCalledOnce()
})
it('creation: Provider object selection creates the precise adapter configuration', async () => {
  await dom.render(<SettingsPanel initialSection="agents" onClose={() => {}} />)
  const scope = dom.container.querySelector<HTMLSelectElement>('[aria-label="Executor configuration scope"]')!
  await act(async () => { scope.value = 'host'; scope.dispatchEvent(new Event('change', { bubbles: true })) })
  await dom.click('.settings-providers-toggle')
  const providers = useAppStore.getState().providerCatalog
  expect(providers.length).toBeGreaterThan(1)
  await dom.click(`[aria-label="Providers"] [data-resource-row="${providers[1]!.id}"]`)
  expect(dom.container.querySelectorAll('[data-provider-entry]')).toHaveLength(1)
  await dom.click(`[aria-label="Create executor with ${providers[1]!.label}"]`)
  const select = dom.container.querySelector<HTMLSelectElement>('[data-executor-provider]')!
  expect(select.value, 'Creation uses selected Provider identity').toBe(providers[1]!.id)
  expect(scope.value, 'Creating a global template returns to its visible configuration scope').toBe('templates')
  expect(select.closest('[hidden]')).toBeNull()
  expect(name().value).toContain(providers[1]!.label)
  expect(document.activeElement).toBe(name())
})

it('retains an authored Host registration across Provider browsing without changing its scope', async () => {
  await dom.render(<SettingsPanel initialSection="agents" onClose={() => {}} />)
  const scope = dom.container.querySelector<HTMLSelectElement>('[aria-label="Executor configuration scope"]')!
  await act(async () => { scope.value = 'host'; scope.dispatchEvent(new Event('change', { bubbles: true })) })
  const register = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Register command'))!
  await act(async () => register.click())
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Host Executor name"]')!
  await fill(input, 'Authored Host wrapper')
  await dom.click('.settings-providers-toggle')
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.settings-agent-navigation button')!.click())
  expect(scope.value).toBe('host')
  expect(dom.container.querySelector('[aria-label="Host Executor name"]')).toBe(input)
  expect(input.value).toBe('Authored Host wrapper')
  expect(input.closest('[hidden]')).toBeNull()
})
