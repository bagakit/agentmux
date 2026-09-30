// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { CLAUDE_LAUNCH_OPTIONS, CODEX_LAUNCH_OPTIONS, describeLaunchOptions, type LaunchOption, type LaunchOptionSelection } from '@agentmux/core'
import { LaunchRefine } from '../src/renderer/src/components/LaunchOptionControls'

const options: LaunchOption[] = [{ id: 'sandbox', label: 'Sandbox', choices: [{ id: 'read', label: 'Read only' }, { id: 'full', label: 'Full access', tier: 'danger' }] }]
let container: HTMLDivElement, root: Root
const selected = vi.fn()
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); selected.mockClear() })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
function Fixture({ declarations = options, naming = false }: { declarations?: LaunchOption[]; naming?: boolean }) {
  const [expanded, setExpanded] = useState(false), [selection, setSelection] = useState<LaunchOptionSelection>({}), [names, setNames] = useState({ agentName: '', tabName: '' })
  return <LaunchRefine options={declarations} selection={selection} expanded={expanded} active={true} onToggle={() => setExpanded(value => !value)} onSelect={(id, choice) => { selected(id, choice); setSelection(choice === null ? {} : { [id]: choice }) }}
    {...(naming ? { names, onNameChange: (field: 'agentName' | 'tabName', value: string) => setNames(current => ({ ...current, [field]: value })) } : {})} />
}
async function mount(declarations = options, naming = false) { await act(async () => root.render(<Fixture declarations={declarations} naming={naming} />)) }
async function click(selector: string) { const element = document.querySelector<HTMLButtonElement>(selector); expect(element).not.toBeNull(); await act(async () => element!.click()) }
async function change(selector: string, value: string) { const input = document.querySelector<HTMLSelectElement>(selector); expect(input).not.toBeNull(); await act(async () => { input!.value = value; input!.dispatchEvent(new Event('change', { bubbles: true })) }) }

describe('compact actual launch options', () => {
  it('hides an empty Provider declaration and draws no empty panel', async () => { await mount([]); expect(container.textContent).toBe(''); expect(document.querySelector('[role="dialog"]')).toBeNull() })
  it('uses one compact action without duplicate count/default copy, opening only on explicit click', async () => {
    await mount(); expect(container.textContent).toBe('Options'); expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click('[aria-label="Launch options"]'); expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Sandbox')
    expect(document.querySelector<HTMLElement>('[role="dialog"]')!.style.visibility).toBe('visible')
    expect(document.querySelector('[data-overlay-host] [role="dialog"]')).not.toBeNull()
    expect(document.querySelectorAll('select')).toHaveLength(1); expect(document.querySelector('select')!.value).toBe('')
  })
  it('passes the exact choice, keeps dangerous posture in the compact summary, and clears to defaults', async () => {
    await mount(); await click('[aria-label="Launch options"]'); await change('select', 'full')
    expect(selected).toHaveBeenLastCalledWith('sandbox', 'full'); expect(document.querySelector('select')?.dataset.tier).toBe('danger')
    await click('[aria-label="Close launch options"]'); expect(container.querySelector('.launch-refine__summary [data-tier="danger"]')?.textContent).toBe('Full access')
    expect(container.querySelector('.launch-refine__count')?.getAttribute('data-tier')).toBe('danger'); expect(container.querySelector('.launch-refine__count')?.textContent).toBe('1Risk'); expect(container.querySelector('.launch-refine__count')?.getAttribute('aria-label')).toBe('1 options set · danger')
    await click('[aria-label="Launch options"]'); await change('select', ''); expect(selected).toHaveBeenLastCalledWith('sandbox', null)
    await click('[aria-label="Close launch options"]'); expect(container.textContent).toBe('Options')
  })
  it('renders every Provider choice in native compact selectors without exposing argv', async () => {
    await mount(describeLaunchOptions(CLAUDE_LAUNCH_OPTIONS)); await click('[aria-label="Launch options"]')
    expect([...document.querySelectorAll('select')].map(element => element.getAttribute('aria-label'))).toEqual(['Model', 'Effort', 'Permission mode'])
    expect([...document.querySelector('select[aria-label="Effort"]')!.querySelectorAll('option')].map(element => element.textContent)).toContain('Max')
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('--model')
  })
  it('can configure optional names even when the Provider declares no choices', async () => {
    await mount([], true); await click('[aria-label="Launch options"]'); expect(document.querySelector('[aria-label="Agent name"]')).not.toBeNull(); expect(document.querySelector('[aria-label="Tab name"]')).not.toBeNull()
  })
  it('does not invent model/effort for a Provider whose declaration has neither', async () => {
    const declarations = describeLaunchOptions(CODEX_LAUNCH_OPTIONS); expect(declarations.map(option => option.id)).toEqual(['sandbox', 'approval'])
    await mount(declarations); await click('[aria-label="Launch options"]'); expect([...document.querySelectorAll('select')].map(element => element.getAttribute('aria-label'))).toEqual(['Sandbox', 'Approval policy'])
  })
})
