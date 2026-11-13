// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
let f: Awaited<ReturnType<typeof configOwnerFixture>>
beforeEach(async () => {
  f = await configOwnerFixture()
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(saved => { publish(saved); useAppStore.setState({ config: saved }) })
  useAppStore.setState({ config: f.owner.current, detectExecutors: vi.fn(async () => {}), providerCatalog: await api.providers.list() })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => await f.owner.edit(expected!, next))
})
const pane = () => dom.container.querySelector<HTMLElement>('[data-settings-pane="derived-actions"]')!
const row = (id: string) => pane().querySelector<HTMLButtonElement>(`[data-derived-action-id="${id}"]`)!
const button = (label: string) => [...pane().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)!
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function save() {
  await act(async () => pane().querySelector<HTMLButtonElement>('.settings-pane-actions button')!.click())
  for (let tries = 0; tries < 300 && pane().querySelector('.settings-pane-actions [role="status"]')?.textContent?.includes('Saving'); tries++) await act(async () => { await new Promise(done => setTimeout(done, 10)) })
}

it('lists the official actions read only and saves a hidden one without touching other settings', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="derived-actions" />)
  expect([...pane().querySelectorAll<HTMLElement>('[data-derived-action-id]')].map(item => item.dataset.derivedActionId)).toEqual(['take-over', 'fork', 'pass-on-experience'])
  await act(async () => row('pass-on-experience').click())
  expect(pane().querySelector('[data-derived-editor="pass-on-experience"] textarea')).toBeNull()
  const before = await f.disk()
  await act(async () => pane().querySelector<HTMLInputElement>('[data-derived-editor="pass-on-experience"] input[type="checkbox"]')!.click())
  await save()
  const after = await f.disk()
  expect(after.agentDerivedActions).toEqual({ hidden: ['pass-on-experience'] })
  expect({ ...after, agentDerivedActions: undefined }).toEqual({ ...before, agentDerivedActions: undefined })
  // Showing it again returns to the default, which is not written to disk at all.
  await act(async () => pane().querySelector<HTMLInputElement>('[data-derived-editor="pass-on-experience"] input[type="checkbox"]')!.click())
  await save()
  expect(Object.hasOwn(await f.disk(), 'agentDerivedActions')).toBe(false)
})

it('adds a custom action from an example, edits it and saves it as the user\'s own', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="derived-actions" />)
  await act(async () => button('Review this work').click())
  const editor = pane().querySelector<HTMLElement>('[data-derived-editor]')!
  expect(editor.dataset.derivedEditor).toBe('review-this-work')
  await fill(editor.querySelector<HTMLTextAreaElement>('textarea')!, 'Review the changes. Do not edit files.')
  // The placement preview is the real derived group in miniature, with this action marked current.
  expect(pane().querySelector('.derived-actions__menu [data-current]')!.textContent).toBe('Review this work…')
  expect([...pane().querySelectorAll('.derived-actions__menu li')].map(item => item.textContent)).toEqual(['Take over', 'Fork current conversation…', 'Pass on experience', 'Review this work…'])
  await save()
  expect((await f.disk()).agentDerivedActions).toEqual({ actions: [{ id: 'review-this-work', label: 'Review this work', base: 'new-agent', instruction: 'Review the changes. Do not edit files.' }] })
  await act(async () => button('Delete action').click()); await save()
  // Deleting the last action keeps the explicit empty list; it never brings examples back.
  expect((await f.disk()).agentDerivedActions).toEqual({ actions: [] })
})

it('blocks saving an action without an instruction and names the problem', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="derived-actions" />)
  await act(async () => button('Add action').click())
  await fill(pane().querySelector<HTMLInputElement>('[data-derived-editor] .prompt-editor__name input')!, 'Explain')
  expect(pane().querySelector<HTMLButtonElement>('.settings-pane-actions button')!.disabled).toBe(true)
  expect(pane().querySelector('.settings-inline-error')!.textContent).toMatch(/instruction/i)
  expect((await f.disk()).agentDerivedActions).toBeUndefined()
})
