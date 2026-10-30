// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { DEFAULT_COMPOSER_INPUT_CONFIG, type ComposerInputConfig } from '@agentmux/client-ui/composer-input-config'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const prompts = [{ id: 'review', keyword: 'review', label: 'Review changes', body: 'Inspect the original change.' }]
let fixture: Awaited<ReturnType<typeof configOwnerFixture>>
beforeEach(async () => {
  fixture = await configOwnerFixture({ composerShortcuts: prompts })
  fixture.owner.subscribe(config => useAppStore.setState({ config }))
  useAppStore.setState({ config: fixture.owner.current, providerCatalog: [] })
  vi.spyOn(api.config, 'save').mockImplementation((next, expected) => fixture.owner.edit(expected!, next))
})
const field = (name: string) => [...dom.container.querySelectorAll<HTMLLabelElement>('[data-prompt-editor] label')]
  .find(label => label.querySelector('span')?.textContent === name)!
const preview = () => dom.container.querySelector('[aria-label="Usage preview"]')!
const mount = () => dom.render(<SettingsPanel initialSection="prompts" onClose={() => {}} />)
const input = (command: string | null, keywords: boolean): ComposerInputConfig => ({ ...DEFAULT_COMPOSER_INPUT_CONFIG, command, keywords })

it.each([
  { name: 'default', config: undefined, library: '/review', example: '/review · review', hint: 'Type /review or review' },
  { name: 'custom prefix', config: input('!', true), library: '!review', example: '!review · review', hint: 'Type !review or review' },
  { name: 'command disabled', config: input(null, true), library: 'review', example: 'review', hint: 'Type review' },
  { name: 'keywords disabled', config: input('!', false), library: '!review', example: '!review', hint: 'Type !review' },
  { name: 'both disabled', config: input(null, false), library: 'Input toolbar', example: 'Input toolbar', hint: 'Choose this prompt from the input toolbar' }
])('the actual SettingsPanel shows only enabled saved Prompt usage: $name', async ({ config, library, example, hint }) => {
  if (config) await fixture.owner.update(current => ({ ...current, messageToolCompletion: config }))
  const before = useAppStore.getState(), bytes = await fixture.bytes()
  await mount()
  expect(dom.container.querySelector('[data-prompt-id="review"] code')?.textContent).toBe(library)
  expect(field('Keyword').querySelector('small')?.textContent).toContain(hint)
  expect(preview().querySelector('code')?.textContent).toBe(example)
  expect(preview().textContent).toContain(hint)
  expect(preview().querySelectorAll('button,input,select,textarea')).toHaveLength(0)
  if (config?.command !== undefined && config.command !== '/') {
    expect(field('Keyword').querySelector('small')?.textContent).not.toContain('/keyword')
    expect(preview().textContent).not.toContain('/review')
  }
  expect(api.config.save).not.toHaveBeenCalled()
  expect(await fixture.bytes()).toBe(bytes)
  expect(fixture.owner.current.composerShortcuts).toEqual(prompts)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(dom.draft()).toBe('Keep my draft')
})

it('saved input preferences refresh hints without replacing the original Prompt draft, expectation or explicit save', async () => {
  await fixture.owner.update(current => ({ ...current, messageToolCompletion: input('!', true) }))
  await mount()
  const instruction = field('Prompt').querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(instruction, 'Keep this exact local draft.')
    instruction.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await fixture.owner.update(current => ({ ...current, messageToolCompletion: input(null, false) })) })
  expect(field('Prompt').querySelector('textarea')).toBe(instruction)
  expect(instruction.value).toBe('Keep this exact local draft.')
  expect(preview().querySelector('code')?.textContent).toBe('Input toolbar')
  expect(api.config.save).not.toHaveBeenCalled()
  expect(fixture.owner.current.composerShortcuts).toEqual(prompts)
  await dom.click('[data-settings-save-bar] button')
  expect(api.config.save).toHaveBeenCalledOnce()
  await act(async () => { await vi.mocked(api.config.save).mock.results[0]!.value })
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.composerShortcuts).toEqual(prompts)
  expect((await fixture.disk()).composerShortcuts).toEqual([{ ...prompts[0], body: 'Keep this exact local draft.' }])
  expect(fixture.owner.current.messageToolCompletion).toEqual(input(null, false))
  expect(dom.draft()).toBe('Keep my draft')
})
