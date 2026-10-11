// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONTINUITY_REMINDER, type AgentMuxContinuityPolicy } from '@agentmux/core'
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
  expect(row?.textContent).toContain('Session continuity'); expect(row?.textContent).toContain('Reminder on')
  const search = dom.container.querySelector<HTMLInputElement>('input[placeholder="Search settings"]')!
  expect(search).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '会话')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(dom.container.querySelector('[data-settings-target="continuity"]')).not.toBeNull()
  await dom.click('[data-settings-target="continuity"]')
  expect(field('Recovery wait').value).toBe('0'); expect(field('Authoritative idle window').value).toBe('86400')
  expect(dom.container.querySelector('[data-continuity-reminder-preview]')?.textContent).toBe(DEFAULT_AGENT_CONTINUITY_REMINDER)
  const delivery = dom.container.querySelector('[aria-label="Recovery delivery preview"]')!.textContent
  expect(delivery).toContain('platform note and joins the continuation prompt')
  expect(delivery).toContain('Selected nonempty content is sent in one new input')
  expect(delivery).toContain('If neither part has content, no input is sent')
  expect(delivery).toContain('same original input key and actual transport or delivery receipt')
  expect(delivery).toContain('native launch argument receipt confirms Runtime carriage only; Provider consumption requires separate evidence')
  expect(delivery).toContain('ordinary User role and open one turn')
  expect(delivery).toContain('delivery does not mean the model completed the task')
  expect(delivery).toContain('Only the initial recovery input carries the selected reminder and continuation')
  expect(delivery).toContain('Later supervised retries restore context only; they resend neither these parts nor any earlier input')
  expect(delivery).not.toContain('follows confirmed native resume')
  expect(delivery).not.toContain('current input readiness')
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

it('reminder and continuation remain independent with complete effective preview and preserved custom text', async () => {
  const onSave = vi.fn(async (_value: AgentMuxContinuityPolicy, _expected: AgentMuxContinuityPolicy) => {})
  await dom.render(<ContinuitySettingsPane preferences={undefined} onSave={onSave} />)
  await input('Recovery reminder', 'default-plus-custom'); await input('Append to recovery reminder', 'Keep the original acceptance criteria.\nDo not repeat unknown input.')
  expect(dom.container.querySelector('[data-continuity-reminder-preview]')?.textContent).toBe(DEFAULT_AGENT_CONTINUITY_REMINDER + '\n\nKeep the original acceptance criteria.\nDo not repeat unknown input.')
  await dom.click('[aria-label="Continue interrupted work after recovery"]')
  await save()
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({ reminderMode: 'default-plus-custom', continuationEnabled: false, reminderAppend: 'Keep the original acceptance criteria.\nDo not repeat unknown input.' })
  await dom.render(<ContinuitySettingsPane preferences={onSave.mock.calls[0]![0]} onSave={onSave} />)
  await input('Recovery reminder', 'off')
  expect(dom.container.querySelector('[data-continuity-reminder-preview]')?.textContent).toBe('No reminder will be sent.')
  await dom.click('[aria-label="Continue interrupted work after recovery"]')
  await input('Continuation prompt', ' \n '); await save()
  expect(onSave.mock.calls.at(-1)?.[0]).toMatchObject({ reminderMode: 'off', continuationEnabled: true, continuationPrompt: ' \n ' })
  await dom.render(<ContinuitySettingsPane preferences={onSave.mock.calls.at(-1)![0]} onSave={onSave} />)
  expect(field('Continuation prompt').value).toBe(' \n ')
  expect(dom.container.querySelector('[aria-label="Recovery delivery preview"]')?.textContent).toContain('If neither part has content, no input is sent')
  await input('Recovery reminder', 'default-plus-custom')
  expect(field('Append to recovery reminder').value).toContain('Keep the original acceptance')
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
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, continuity: { reminderMode: 'off' }, copyPathsAsAbsolute: true } })))
  await act(async () => release())
  expect(useAppStore.getState().config?.continuity).toEqual({ activeRecoveryDelayMs: 1001, reminderMode: 'off' })
  expect(field('Recovery wait').value).toBe('3.002')
  expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')?.disabled).toBe(false)
  await save(); await act(async () => release())
  expect(useAppStore.getState().config?.continuity).toEqual({ activeRecoveryDelayMs: 3002, reminderMode: 'off' })
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
