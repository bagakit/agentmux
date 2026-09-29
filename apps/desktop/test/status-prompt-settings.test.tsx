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
    await act(async () => { await new Promise((done) => setTimeout(done, 50)) })
    if (!dom.container.querySelector('.settings-pane-actions [role="status"]')?.textContent?.includes('Saving')) break
  }
  expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  expect(dom.container.querySelector('.settings-pane-actions [role="status"]')?.textContent).not.toContain('Saving')
}
describe('real Prompts Settings uses the same durable state bindings', () => {
  it('explains independent activity, process and input boundaries without changing saved bindings', async () => {
    await mount()
    const choices = [...dom.container.querySelectorAll<HTMLLabelElement>('.prompt-state-settings__choices label')]
    expect(choices).toHaveLength(9)
    expect(choices.map(label => label.querySelector('input')!.value)).toEqual([
      'starting', 'running', 'disconnected', 'working', 'waiting', 'blocked', 'done', 'exited', 'error'
    ])
    const choice = (state: string) => choices.find(label => label.querySelector('input')!.value === state)!
    expect(choice('running').querySelector('strong')!.textContent).toBe('Status unknown running')
    expect(choice('running').querySelector('small')!.textContent).toContain('current activity is unknown')
    expect(choice('running').querySelector('small')!.textContent).toContain('does not mean working, idle, or input ready')
    expect(choice('working').querySelector('small')!.textContent).toContain('activity statement, separate from input readiness')
    expect(choice('done').querySelector('strong')!.textContent).toBe('Turn ended done')
    expect(choice('done').querySelector('small')!.textContent).toContain('does not mean the process exited, the goal is complete')
    expect(choice('waiting').querySelector('small')!.textContent).toContain('permission or question is shown separately')
    expect(choice('blocked').querySelector('small')!.textContent).toContain('does not identify a specific request')
    expect(choice('error').querySelector('small')!.textContent).toContain('process may still be running')
    await act(async () => choice('running').querySelector<HTMLInputElement>('input')!.click())
    expect(choice('working').querySelector<HTMLInputElement>('input')!.checked).toBe(false)
    expect(dom.container.querySelector('.prompt-usage')!.textContent).toContain('receiving Agent avatar')
    expect(dom.container.querySelector('.prompt-usage')!.textContent).toContain('instruction only; pending permission or question requests queue it')
    expect(dom.container.querySelector('.prompt-usage')!.textContent).toContain('Your draft is kept')
    await save()
    expect((await new ConfigStore(f.store.filePath).get()).composerShortcuts).toEqual([{ ...original, states: ['running'] }])
  })
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
    expect(dom.container.querySelector('.prompt-usage')!.textContent).toContain('Click sends this instruction only')
    expect(dom.container.querySelector('.prompt-usage')!.textContent).toContain('draft instead of sending')
    expect(dom.container.querySelector('.prompt-usage')!.textContent).toContain('bare keyword')
  })
  it('adds multiple state prompts, unbinds one, and preserves deleting all through a fresh reader', async () => {
    await mount()
    await dom.click('.prompt-state-settings input[value="done"]')
    await dom.click('.settings-pane-toolbar button')
    expect(dom.container.querySelectorAll('[data-prompt-id]')).toHaveLength(2)
    const rows = dom.container.querySelectorAll('[data-prompt-editor]')
    expect(rows).toHaveLength(1)
    const newRow = rows[0]!
    await fill(newRow, 'Keyword', 'continue')
    await fill(newRow, 'Name', '继续优化')
    await fill(newRow, 'Prompt', '继续优化，并验证结果。')
    await act(async () => newRow.querySelector<HTMLInputElement>('input[value="done"]')!.click())
    await save()
    expect(f.owner.current.composerShortcuts!.map((prompt) => prompt.states)).toEqual([['done'], ['done']])
    await dom.click('[data-prompt-id="plain"]')
    await dom.click('.prompt-state-settings input[value="done"]')
    await save()
    expect((await new ConfigStore(f.store.filePath).get()).composerShortcuts![0]!.states).toEqual([])
    const ids = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-prompt-id]')].map((button) => button.dataset.promptId!)
    expect(ids).toHaveLength(2)
    for (const id of ids) {
      await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('[data-prompt-id]')].find((button) => button.dataset.promptId === id)!.click())
      await dom.click('.prompt-editor__remove button')
    }
    await save()
    expect(f.owner.current.composerShortcuts).toEqual([])
    expect((await new ConfigStore(f.store.filePath).get()).composerShortcuts).toEqual([])
  })
})
