// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { ConfigStore } from '../src/main/config-store'
import { COMPOSER_PROMPT_STATES } from '../src/shared/composer-shortcut-library'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const original = { id: 'plain', keyword: 'plain', label: 'Explain simply', body: 'Explain this in plain words.' }
let f: Awaited<ReturnType<typeof configOwnerFixture>>
beforeEach(async () => {
  f = await configOwnerFixture({ composerShortcuts: [original] })
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation((saved) => { publish(saved); useAppStore.setState({ config: saved }) })
  useAppStore.setState({ config: f.owner.current, detectExecutors: vi.fn(async () => {}), providerCatalog: await api.providers.list() })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => await f.owner.edit(expected!, next))
})
async function mount() { await dom.render(<SettingsPanel initialSection="prompts" onClose={() => {}} />) }
async function fill(row: Element, name: string, value: string) {
  const label = [...row.querySelectorAll('label')].find((node) => node.querySelector('span')?.textContent === name)!
  const input = label.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!
  expect(input).not.toBeNull()
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function save() {
  await dom.click('.settings-pane-actions button')
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise((done) => setTimeout(done, 5)) })
    if (!dom.container.querySelector('.settings-pane-actions [role="status"]')?.textContent?.includes('Saving')) break
  }
  expect(dom.container.querySelector('.settings-pane-actions [role="status"]')?.textContent).not.toContain('Saving')
  expect(dom.container.querySelector('[role="alert"]')).toBeNull()
}
describe('real Prompts Settings uses the same durable state bindings', () => {
  it('selects all display states, edits content and Provider, then reads them through a new ConfigStore', async () => {
    await mount()
    const choices = [...dom.container.querySelectorAll<HTMLInputElement>('.prompt-state-settings input')]
    expect(choices.map((input) => input.value)).toEqual([...COMPOSER_PROMPT_STATES])
    expect(choices).toHaveLength(9)
    for (const input of choices) await act(async () => input.click())
    await fill(dom.container, 'Name', '大白话说说做了什么')
    await fill(dom.container, 'Prompt', '大白话说清楚\n1. 做了什么\n2. 下一步继续优化')
    const provider = dom.container.querySelector<HTMLSelectElement>('.prompt-settings-card select')!
    await act(async () => { provider.value = 'codex'; provider.dispatchEvent(new Event('change', { bubbles: true })) })
    await save()
    const expected = [{ ...original, label: '大白话说说做了什么', body: '大白话说清楚\n1. 做了什么\n2. 下一步继续优化', providerId: 'codex', states: [...COMPOSER_PROMPT_STATES] }]
    expect(f.owner.current.composerShortcuts).toEqual(expected)
    expect((await new ConfigStore(f.store.filePath).get()).composerShortcuts).toEqual(expected)
    expect(dom.container.querySelector('.settings-lead')!.textContent).toContain('one-click buttons that send')
    expect(dom.container.querySelector('.settings-lead')!.textContent).toContain('draft instead')
  })
  it('adds multiple state prompts, unbinds one, and preserves deleting all through a fresh reader', async () => {
    await mount()
    await dom.click('.prompt-state-settings input[value="done"]')
    await dom.click('.settings-pane-toolbar button')
    const rows = dom.container.querySelectorAll('.prompt-settings-card')
    expect(rows).toHaveLength(2)
    const newRow = rows[1]!
    await fill(newRow, 'Keyword', 'continue')
    await fill(newRow, 'Name', '继续优化')
    await fill(newRow, 'Prompt', '继续优化，并验证结果。')
    await act(async () => newRow.querySelector<HTMLInputElement>('input[value="done"]')!.click())
    await save()
    expect(f.owner.current.composerShortcuts!.map((prompt) => prompt.states)).toEqual([['done'], ['done']])
    await dom.click('.prompt-state-settings input[value="done"]')
    await save()
    expect((await new ConfigStore(f.store.filePath).get()).composerShortcuts![0]!.states).toEqual([])
    const deletes = [...dom.container.querySelectorAll<HTMLButtonElement>('.prompt-settings-card button')].filter((button) => button.textContent?.includes('Delete prompt'))
    expect(deletes).toHaveLength(2)
    for (const button of deletes) await act(async () => button.click())
    await save()
    expect(f.owner.current.composerShortcuts).toEqual([])
    expect((await new ConfigStore(f.store.filePath).get()).composerShortcuts).toEqual([])
  })
})
