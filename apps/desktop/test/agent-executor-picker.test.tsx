// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentExecutorPicker } from '../src/renderer/src/components/AgentExecutorPicker'
import type { ExecutorChoice } from '../src/renderer/src/lib/executors'
import { chooseField } from './helpers/selection-field'

const input = { executorId: 'local-cli', providerId: 'codex', command: 'unused', host: { id: 'local', kind: 'local' as const, label: 'Local' } }
const choices: ExecutorChoice[] = [
  { id: 'ready', label: 'Research partner', providerId: 'codex', command: 'unused', detection: { state: 'ready', input } },
  { id: 'unknown', label: 'Quiet colleague', providerId: 'claude', command: 'unused', detection: { state: 'error', input, detail: 'Probe unavailable' } },
  { id: 'missing', label: 'Writing partner', providerId: 'codex', command: 'unused', detection: { state: 'missing', input } }
]
let container: HTMLDivElement, root: Root
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
const key = async (node: HTMLElement, key: string) => { await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))); await settle() }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
async function mount(selected = 'ready', executors = choices, disabled = false) {
  const changed = vi.fn(), submitted = vi.fn()
  function Scene() { const [value, setValue] = useState(selected); return <form onSubmit={event => { event.preventDefault(); submitted() }}>
    <AgentExecutorPicker presentation="field" label="Executor for new chat" selected={value} executors={executors} disabled={disabled}
      unsetLabel="Use normal Launcher choice" onSelect={id => { changed(id); setValue(id) }} />
  </form> }
  await act(async () => root.render(<Scene />)); await settle()
  return { changed, submitted, trigger: container.querySelector<HTMLButtonElement>('button')! }
}
it('shows the original Provider and honest availability and keeps configuration selection separate from launch', async () => {
  const { trigger, changed, submitted } = await mount()
  expect(trigger.textContent).toContain('Research partner'); expect(trigger.title).toContain('Available')
  await key(trigger, 'ArrowDown')
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu.textContent).toContain('Codex · Available'); expect(menu.textContent).toContain('Claude · Check failed'); expect(menu.textContent).toContain('Codex · Not found')
  expect(menu.querySelector('[aria-checked="true"]')?.dataset.value).toBe('ready')
  await key(menu, 'q'); expect(document.activeElement?.textContent).toContain('Quiet colleague')
  await key(document.activeElement as HTMLElement, 'Enter')
  expect(changed).toHaveBeenCalledExactlyOnceWith('unknown'); expect(submitted).not.toHaveBeenCalled(); expect(document.activeElement).toBe(trigger)
})
it('retains an unavailable saved configuration by exact ID and permits clearing it', async () => {
  const { trigger, changed, submitted } = await mount('saved-remote-executor')
  expect(trigger.textContent).toContain('saved-remote-executor'); expect(trigger.title).toContain('Configuration unavailable')
  await chooseField(trigger, '')
  expect(changed).toHaveBeenCalledExactlyOnceWith(''); expect(trigger.textContent).toContain('Use normal Launcher choice'); expect(submitted).not.toHaveBeenCalled()
})
it('can save an installed-later preference without pretending that a missing command can run', async () => {
  const { trigger, changed } = await mount()
  await chooseField(trigger, 'missing'); expect(changed).toHaveBeenCalledExactlyOnceWith('missing')
  expect(trigger.dataset.value).toBe('missing'); expect(trigger.title).toContain('Not found')
})
it('a removed option cannot manufacture a new selection and a disabled field cannot change one', async () => {
  const changed = vi.fn()
  const scene = (executors: ExecutorChoice[], disabled = false) => <AgentExecutorPicker presentation="field" label="Executor for new chat" selected="ready" executors={executors} disabled={disabled} unsetLabel="Normal choice" onSelect={changed} />
  await act(async () => root.render(scene(choices))); await settle()
  const trigger = container.querySelector<HTMLButtonElement>('button')!; await key(trigger, 'ArrowDown')
  const removed = document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="unknown"]')!
  await act(async () => root.render(scene([choices[0]!]))); await settle()
  await act(async () => removed.click()); expect(changed).not.toHaveBeenCalled()
  await act(async () => root.render(scene(choices, true))); await settle()
  expect(trigger.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="ready"]')?.click()); expect(changed).not.toHaveBeenCalled()
})
it('preserves the original Launcher catalog eligibility and selection', async () => {
  const changed = vi.fn(); await act(async () => root.render(<AgentExecutorPicker executors={choices} selected="unknown" onSelect={changed} />)); await settle()
  expect(container.querySelector('[data-executor-id="unknown"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelector('[data-executor-id="missing"]')).toBeNull()
  await act(async () => (container.querySelector('[data-executor-id="ready"]') as HTMLElement).click())
  expect(changed).toHaveBeenCalledExactlyOnceWith('ready')
})

it('all missing causes keep factual guidance and the original launch eligibility', async () => {
  const unavailable: ExecutorChoice[] = ['EXECUTABLE_NOT_FILE', 'EXECUTABLE_NOT_FOUND'].map((code, index) => {
    const original = { ...input, executorId: 'unavailable-' + index }
    return { id: original.executorId, label: 'Unavailable ' + index, providerId: 'codex', command: original.command,
      detection: { state: 'missing', input: original, result: { input: original, availability: 'missing',
        executable: original.command, cause: { code, message: code === 'EXECUTABLE_NOT_FILE' ? 'Path is a directory.' : 'Exact executable not found.' } } } }
  })
  const changed = vi.fn()
  await act(async () => root.render(<AgentExecutorPicker executors={unavailable} selected={null} onSelect={changed} />))
  expect(container.querySelector('.agent-catalog__empty')!.textContent).toContain('Check their configuration and unavailable details, then refresh.')
  expect(container.querySelector('.agent-catalog__empty')!.textContent).not.toMatch(/install|commands were not found/i)
  expect(container.querySelectorAll('[data-executor-id]')).toHaveLength(0)
  await act(async () => container.querySelector<HTMLButtonElement>('.launcher-other-agents')!.click())
  expect(container.querySelector('.launcher-unavailable-agents')!.textContent).toContain('Not available')
  expect(container.querySelector('.launcher-unavailable-agents')!.textContent).toContain('Not found')
  expect(changed).not.toHaveBeenCalled()
})
