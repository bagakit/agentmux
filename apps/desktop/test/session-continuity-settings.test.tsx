// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONTINUITY_CONTINUATION, type AgentMuxContinuityPolicy } from '@agentmux/core'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { ContinuitySettingsPane } from '../src/renderer/src/components/settings/ContinuitySettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { applyConfigEdit } from '../src/shared/config-edit'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
const dom = composerDOM()
const field = (label: string) => {
  const node = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)
  expect(node, label).not.toBeNull(); expect(node!.isConnected).toBe(true); return node!
}
async function input(label: string, value: string) {
  const node = field(label), type = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement : node.tagName === 'SELECT' ? HTMLSelectElement : HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(type.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const save = () => dom.click('[data-settings-save-bar] button')
beforeEach(() => useAppStore.setState({ config: structuredClone(composerConfig), loading: false, mainSurface: 'workbench', detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) }))

it('the registered continuity module reaches Overview, search, narrow navigation and the real writable editor', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const row = dom.container.querySelector<HTMLElement>('[data-settings-section="continuity"]')!
  expect(row?.textContent).toContain('Execution'); expect(row?.textContent).toContain('Active fallback off')
  const search = dom.container.querySelector<HTMLInputElement>('input[placeholder="Search settings"]')!
  expect(search).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '会话')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(dom.container.querySelector('[data-settings-target="continuity"]')).not.toBeNull()
  await dom.click('[data-settings-target="continuity"]')
  expect(field('Recovery wait').value).toBe('0'); expect(field('Automatic recovery window').value).toBe('86400')
  expect((field('Use active state when interruption detection is unsupported') as HTMLInputElement).checked).toBe(false)
  expect((field('Continue interrupted work after recovery') as HTMLInputElement).checked).toBe(true)
  expect(dom.container.querySelector('[data-continuity-continuation-preview]')?.textContent).toBe(DEFAULT_AGENT_CONTINUITY_CONTINUATION)
  expect(dom.container.textContent).toContain('confirmed activity or idle start')
  const delivery = dom.container.querySelector('[aria-label="Recovery delivery preview"]')!.textContent
  expect(delivery).toContain('after native recovery succeeds')
  expect(delivery).toContain('may open one new model turn')
  expect(delivery).toContain('Unknown earlier input is never replayed')
  for (const label of ['Recovery reminder', 'Append to recovery reminder', 'Continuation prompt']) {
    expect(dom.container.querySelector(`[aria-label="${label}"]`)).toBeNull()
  }
  const saveSpy = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const saved = applyConfigEdit(useAppStore.getState().config!, expected, next)
    useAppStore.setState({ config: saved }); return saved
  })
  await input('Recovery wait', '2.125'); await save()
  expect(saveSpy).toHaveBeenCalledOnce()
  expect(useAppStore.getState().config?.continuity).toEqual({ activeRecoveryDelayMs: 2125 })
  expect(dom.container.querySelector('[data-settings-save-bar]')?.textContent).toContain('Changes saved')
  expect(dom.container.textContent).toContain('Custom saved value')
})

it('retry choices are discoverable, strictly authored and separate from rechecks without Session side effects', async () => {
  const recover = vi.spyOn(api.sessions, 'recover'), stop = vi.spyOn(api.sessions, 'stop'), submit = vi.spyOn(api.sessions, 'submitPrompt')
  const saveSpy = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const saved = applyConfigEdit(useAppStore.getState().config!, expected, next)
    useAppStore.setState({ config: saved }); return saved
  })
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const search = dom.container.querySelector<HTMLInputElement>('input[placeholder="Search settings"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Additional retries')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await dom.click('[data-settings-search-result="continuity:retryMaxAttempts"]')
  expect(field('First retry base delay').value).toBe('1'); expect(field('Maximum retry base delay').value).toBe('30')
  expect(field('Additional retries').value).toBe('3'); expect(field('Recheck count').value).toBe('3')
  expect(useAppStore.getState().config?.continuity).toBeUndefined()
  const section = dom.container.querySelector('[data-continuity-retry-settings]')!
  expect(section.textContent).toContain('Zero disables automatic retries')
  expect(section.textContent).toContain('at most one second and at most one quarter')
  expect(section.textContent).toContain('without resending earlier input')
  await input('First retry base delay', '2.125'); await input('Maximum retry base delay', '1')
  expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')?.disabled).toBe(true)
  expect(field('First retry base delay').value).toBe('2.125'); expect(saveSpy).not.toHaveBeenCalled()
  await input('Maximum retry base delay', '45.625'); await input('Additional retries', '0'); await save()
  expect(useAppStore.getState().config?.continuity).toEqual({ retryInitialDelayMs: 2125, retryMaxDelayMs: 45625, retryMaxAttempts: 0 })
  expect(field('Recheck count').value).toBe('3')
  expect(recover).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
})

it('unsupported-only active fallback is opt in and preserves retained input while continuation stays independent', async () => {
  const retained = { reminderMode: 'default-plus-custom', reminderAppend: 'Keep the original acceptance criteria.\nDo not repeat unknown input.', continuationPrompt: 'An old authored continuation.' } as const
  useAppStore.setState({ config: { ...composerConfig, continuity: retained } })
  const saveSpy = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const saved = applyConfigEdit(useAppStore.getState().config!, expected, next)
    useAppStore.setState({ config: saved }); return saved
  })
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="continuity" />)
  const fallback = () => field('Use active state when interruption detection is unsupported') as HTMLInputElement
  expect(fallback().checked).toBe(false)
  expect(dom.container.querySelector('[data-settings-field="activeInterruptionFallback"]')?.textContent).toContain('Default: Off')
  expect(dom.container.querySelector('[data-settings-field="activeInterruptionFallback"]')?.textContent).toContain('supports detection but reports an unknown result never uses this fallback')
  expect(dom.container.querySelector('[data-continuity-continuation-preview]')?.textContent).toBe('<amux:continue />')
  expect(dom.container.textContent).not.toContain(retained.continuationPrompt)
  await dom.click('[aria-label="Use active state when interruption detection is unsupported"]')
  expect(fallback().checked).toBe(true)
  await save()
  expect(useAppStore.getState().config?.continuity).toEqual({ ...retained, activeInterruptionFallback: true })
  expect(saveSpy.mock.calls[0]?.[1].continuity?.activeInterruptionFallback).toBe(false)
  await dom.click('[aria-label="Continue interrupted work after recovery"]'); await save()
  expect(useAppStore.getState().config?.continuity).toEqual({ ...retained, activeInterruptionFallback: true, continuationEnabled: false })
  expect(fallback().checked).toBe(true)
  expect(dom.container.querySelector('[data-continuity-continuation-preview]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Recovery delivery preview"]')?.textContent).toContain('No continuation is sent after recovery')
  await dom.click('[aria-label="Use active state when interruption detection is unsupported"]'); await save()
  expect(useAppStore.getState().config?.continuity).toEqual({ ...retained, activeInterruptionFallback: false, continuationEnabled: false })
})

it('first concurrent fields merge through the real module adapter while pending input keeps its own next baseline', async () => {
  let release!: () => void
  const saveSpy = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    await new Promise<void>(resolve => { release = resolve })
    const saved = applyConfigEdit(useAppStore.getState().config!, expected, next)
    useAppStore.setState({ config: saved }); return saved
  })
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="continuity" />)
  await input('Recovery wait', '1.001'); await save()
  expect(saveSpy).toHaveBeenCalledOnce()
  await input('Recovery wait', '3.002')
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, continuity: { activeInterruptionFallback: true }, copyPathsAsAbsolute: true } })))
  await act(async () => release())
  expect(useAppStore.getState().config?.continuity).toEqual({ activeRecoveryDelayMs: 1001, activeInterruptionFallback: true })
  expect(field('Recovery wait').value).toBe('3.002')
  expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')?.disabled).toBe(false)
  await save(); await act(async () => release())
  expect(useAppStore.getState().config?.continuity).toEqual({ activeRecoveryDelayMs: 3002, activeInterruptionFallback: true })
  expect(useAppStore.getState().config?.copyPathsAsAbsolute).toBe(true)
  expect(saveSpy.mock.calls[1]?.[1].continuity?.activeRecoveryDelayMs).toBe(1001)
})

it('a same-field conflict preserves the draft and original expectation without taking any session action', async () => {
  const onSave = vi.fn(async (value: AgentMuxContinuityPolicy, expected: AgentMuxContinuityPolicy) => {
    applyConfigEdit({ ...composerConfig, continuity: { activeRecoveryDelayMs: 5000 } },
      { ...composerConfig, continuity: expected }, { ...composerConfig, continuity: value })
  })
  await dom.render(<ContinuitySettingsPane preferences={undefined} onSave={onSave} />)
  await input('Recovery wait', '2'); await save()
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('continuity.activeRecoveryDelayMs')
  expect(field('Recovery wait').value).toBe('2')
  await save(); expect(onSave.mock.calls.map(call => call[1].activeRecoveryDelayMs)).toEqual([0, 0])
})

it('validates only the authored numeric operation and round trips full safe millisecond precision', async () => {
  const onSave = vi.fn(async (_value: AgentMuxContinuityPolicy, _expected: AgentMuxContinuityPolicy) => {})
  await dom.render(<ContinuitySettingsPane preferences={{ activeRecoveryDelayMs: Number.MAX_SAFE_INTEGER }} onSave={onSave} />)
  expect(field('Recovery wait').value).toBe('9007199254740.991')
  await input('Recheck count', '4'); await save()
  expect(onSave.mock.calls[0]?.[0].activeRecoveryDelayMs).toBe(Number.MAX_SAFE_INTEGER)
  await dom.render(<ContinuitySettingsPane preferences={onSave.mock.calls[0]![0]} onSave={onSave} />)
  await input('Recovery wait', '-1')
  expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')?.disabled).toBe(true)
  expect(field('Recovery wait').value).toBe('-1')
  await input('Recovery wait', '1.001'); await save()
  expect(onSave.mock.calls.at(-1)?.[0]).toMatchObject({ activeRecoveryDelayMs: 1001, recheckMaxAttempts: 4 })
})
