// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { CLAUDE_LAUNCH_OPTIONS, CODEX_LAUNCH_OPTIONS, describeLaunchOptions, type LaunchOption, type LaunchOptionSelection } from '@agentmux/core'
import { LaunchRefine } from '../src/renderer/src/components/LaunchOptionControls'

const options: LaunchOption[] = [{ id: 'sandbox', label: 'Sandbox', choices: [{ id: 'read', label: 'Read only' }, { id: 'full', label: 'Full access', tier: 'danger' }] }]
let container: HTMLDivElement, root: Root
const selected = vi.fn()
const resetRequested = vi.fn()
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); selected.mockClear(); resetRequested.mockClear() })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
function Fixture({ declarations = options, naming = false, saved = {} }: { declarations?: LaunchOption[]; naming?: boolean; saved?: LaunchOptionSelection }) {
  const [expanded, setExpanded] = useState(false), [selection, setSelection] = useState<LaunchOptionSelection>(saved), [names, setNames] = useState({ agentName: '', tabName: '' })
  return <LaunchRefine options={declarations} selection={selection} expanded={expanded} active={true} onToggle={() => setExpanded(value => !value)} onSelect={(id, choice) => { selected(id, choice); setSelection(current => { const next = { ...current }; if (choice === null) delete next[id]; else next[id] = choice; return next }) }}
    onReset={() => { resetRequested(); setSelection({}) }}
    {...(naming ? { names, onNameChange: (field: 'agentName' | 'tabName', value: string) => setNames(current => ({ ...current, [field]: value })) } : {})} />
}
async function mount(declarations = options, naming = false) { await act(async () => root.render(<Fixture declarations={declarations} naming={naming} />)) }
async function click(selector: string) { const element = document.querySelector<HTMLButtonElement>(selector); expect(element).not.toBeNull(); await act(async () => element!.click()) }
async function change(_selector: string, value: string) { const field = document.querySelector<HTMLElement>('.launch-refine__row .selection-field')!; expect(field).not.toBeNull(); await act(async () => field.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ctrlKey: false }))); const choice = document.querySelector<HTMLElement>(`[role=menuitemradio][data-value="${value}"]`)!; expect(choice).not.toBeNull(); await act(async () => choice.click()) }

describe('compact actual launch options', () => {
  it('hides an empty Provider declaration and draws no empty panel', async () => { await mount([]); expect(container.textContent).toBe(''); expect(document.querySelector('[role="dialog"]')).toBeNull() })
  it('uses one compact action without duplicate count/default copy, opening only on explicit click', async () => {
    await mount(); expect(container.textContent).toBe('Options'); expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click('[aria-label="Launch options"]'); expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Sandbox')
    expect(document.querySelector<HTMLElement>('[role="dialog"]')!.style.visibility).toBe('visible')
    expect(document.querySelector('[data-overlay-host] [role="dialog"]')).not.toBeNull()
    expect(document.querySelectorAll('.launch-refine__row .selection-field')).toHaveLength(1); expect(document.querySelector<HTMLElement>('.launch-refine__row .selection-field')!.dataset.value).toBe('')
  })
  it('passes the exact choice, keeps dangerous posture in the compact summary, and clears to defaults', async () => {
    await mount(); await click('[aria-label="Launch options"]'); await change('select', 'full')
    expect(selected).toHaveBeenLastCalledWith('sandbox', 'full'); expect(document.querySelector('.launch-refine__row')?.getAttribute('data-tier')).toBe('danger')
    await click('[aria-label="Close launch options"]'); expect(container.querySelector('.launch-refine__summary [data-tier="danger"]')?.textContent).toBe('Full access')
    expect(container.querySelector('.launch-refine__count')?.getAttribute('data-tier')).toBe('danger'); expect(container.querySelector('.launch-refine__count')?.textContent).toBe('1Risk'); expect(container.querySelector('.launch-refine__count')?.getAttribute('aria-label')).toBe('1 options set · danger')
    await click('[aria-label="Launch options"]'); await change('select', ''); expect(selected).toHaveBeenLastCalledWith('sandbox', null)
    await click('[aria-label="Close launch options"]'); expect(container.textContent).toBe('Options')
  })
  it('renders original Provider fields and all choices in the shared menu without exposing argv', async () => {
    await mount(describeLaunchOptions(CLAUDE_LAUNCH_OPTIONS)); await click('[aria-label="Launch options"]')
    expect([...document.querySelectorAll('.launch-refine__row .selection-field')].map(element => element.getAttribute('aria-label'))).toEqual(['Model', 'Effort', 'Permission mode'])
    await act(async () => document.querySelector<HTMLElement>('[aria-label="Effort"].selection-field')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ctrlKey: false }))); expect(document.querySelector('.selection-field__menu')!.textContent).toContain('Max'); expect(document.querySelector('.selection-field__menu')!.textContent).toContain('Highest reasoning effort')
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('--model')
  })
  it('can configure optional names even when the Provider declares no choices', async () => {
    await mount([], true); await click('[aria-label="Launch options"]'); expect(document.querySelector('[aria-label="Agent name"]')).not.toBeNull(); expect(document.querySelector('[aria-label="Tab name"]')).not.toBeNull()
  })
  it('does not invent model/effort for a Provider whose declaration has neither', async () => {
    const declarations = describeLaunchOptions(CODEX_LAUNCH_OPTIONS); expect(declarations.map(option => option.id)).toEqual(['sandbox', 'approval'])
    await mount(declarations); await click('[aria-label="Launch options"]'); expect([...document.querySelectorAll('.launch-refine__row .selection-field')].map(element => element.getAttribute('aria-label'))).toEqual(['Sandbox', 'Approval policy'])
  })
  it('shows retained missing fields and choices without silently clearing or disabling them', async () => {
    await act(async () => root.render(<Fixture saved={{ sandbox: 'legacy-mode', retired: 'original-value' }} />))
    expect(selected).not.toHaveBeenCalled(); expect(resetRequested).not.toHaveBeenCalled()
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Launch options"]')!
    expect(trigger.disabled).toBe(false); expect(trigger.textContent).toContain('2Review')
    await click('[aria-label="Launch options"]')
    expect(document.querySelector('[role="status"]')!.textContent).toContain('Sandbox: legacy-mode')
    expect(document.querySelector('[role="status"]')!.textContent).toContain('retired: original-value')
    expect(document.querySelector<HTMLElement>('.launch-refine__row .selection-field')!.dataset.value).toBe('legacy-mode')
    await act(async () => document.querySelector<HTMLElement>('.launch-refine__row .selection-field')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ctrlKey: false })))
    const retained = document.querySelector('[role=menuitemradio][data-disabled]')!; expect(retained.textContent).toContain('Saved selection'); expect(retained.getAttribute('aria-disabled')).toBe('true')
    await act(async () => retained.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true})))
    await change('select', 'read'); expect(document.querySelector('[role="status"]')!.textContent).not.toContain('legacy-mode')
    expect(document.querySelector('[role="status"]')!.textContent).toContain('original-value')
  })
  it('keeps the retained choices accessible when the Provider removes every declared field', async () => {
    await act(async () => root.render(<Fixture declarations={[]} saved={{ retired: 'original-value' }} />))
    await click('[aria-label="Launch options"]'); expect(document.querySelector('[role="status"]')!.textContent).toContain('retired: original-value')
    expect(document.querySelectorAll('.launch-refine__row .selection-field')).toHaveLength(0)
    const reset = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use Agent defaults')!
    await act(async () => reset.click()); expect(resetRequested).toHaveBeenCalledOnce(); expect(container.textContent).toBe('')
  })
  it('resets only on explicit intent and keeps custom names in the panel', async () => {
    await act(async () => root.render(<Fixture naming saved={{ sandbox: 'full', retired: 'original-value' }} />))
    await click('[aria-label="Launch options"]')
    const name = document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Keep this name'); name.dispatchEvent(new Event('input', { bubbles: true })) })
    const reset = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use Agent defaults')!
    await act(async () => reset.click()); expect(resetRequested).toHaveBeenCalledOnce()
    expect(document.querySelector<HTMLElement>('.launch-refine__row .selection-field')!.dataset.value).toBe(''); expect(document.querySelector('[role="status"]')).toBeNull()
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe('Keep this name')
  })
})

it('keeps field guidance available without changing values or duplicating it in every row', async () => {
  await mount(describeLaunchOptions(CLAUDE_LAUNCH_OPTIONS)); await click('[aria-label="Launch options"]')
  const help = document.querySelector<HTMLDetailsElement>('.launch-refine__help')!
  expect(help.open).toBe(false)
  expect(document.querySelector('.launch-refine__row small')).toBeNull()
  const fields = [...document.querySelectorAll<HTMLElement>('.launch-refine__row .selection-field')].map(node => node.dataset.value)
  await act(async () => { help.open = true; help.dispatchEvent(new Event('toggle')) })
  expect(help.textContent).toContain('Which Claude model this session runs on.')
  expect(help.textContent).toContain('Model support and configured limits can cap the level.')
  expect([...document.querySelectorAll<HTMLElement>('.launch-refine__row .selection-field')].map(node => node.dataset.value)).toEqual(fields)
  expect(selected).not.toHaveBeenCalled(); expect(resetRequested).not.toHaveBeenCalled()
})
