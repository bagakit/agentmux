// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SelectionField } from '../src/renderer/src/components/SelectionField'

let container: HTMLElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Bravo' }]
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })

it('does not infer a saved selection from a missing option', async () => {
  await act(async () => root.render(<SelectionField label="Original choice" value="unsaved-draft" options={options} onValueChange={() => {}} />)); await settle()
  const trigger = container.querySelector<HTMLButtonElement>('button')!
  expect(trigger.textContent).toContain('Not in current options')
  expect(trigger.textContent).not.toContain('Saved selection')
  expect(trigger.title).toContain('unsaved-draft')
})

it('uses the caller-provided missing identity and field description without replacing its raw value', async () => {
  await act(async () => root.render(<><span id="field-label">Node to manage</span><span id="runtime-hint">Identity not confirmed</span><SelectionField label="Original choice" value="host-original" options={options} onValueChange={() => {}} labelledBy="field-label" describedBy="runtime-hint" missingOptionLabel="Previous Agent selection unavailable" missingOptionDescription="Unsaved draft · identity not confirmed" /></>)); await settle()
  const trigger = container.querySelector<HTMLButtonElement>('button')!
  expect(trigger.textContent).toContain('Previous Agent selection unavailable')
  expect(trigger.getAttribute('aria-labelledby')).toBe('field-label')
  const ids = trigger.getAttribute('aria-describedby')!.split(' ')
  expect(ids).toContain('runtime-hint')
  expect(ids.length).toBeGreaterThan(1)
  const internalId = ids.find(id => id !== 'runtime-hint')!
  expect(document.getElementById(internalId)?.textContent).toContain('Unsaved draft · identity not confirmed')
  expect(trigger.title).toContain('host-original')
})

it('keeps an unknown missing value visible and selectable without marking it disabled', async () => {
  await act(async () => root.render(<SelectionField label="Original choice" value="unsaved-draft" options={options} onValueChange={() => {}} />)); await settle()
  const trigger = container.querySelector<HTMLButtonElement>('button')!
  expect(trigger.disabled).toBe(false)
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))); await settle()
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  const missing = document.querySelector<HTMLElement>('.selection-field__menu [role="menuitemradio"][aria-checked="true"]')!
  expect(missing.getAttribute('aria-disabled')).not.toBe('true')
  expect(missing.textContent).toContain('Not in current options')
  expect(missing.querySelector('span[title]')?.getAttribute('title')).toBe('unsaved-draft')
})
