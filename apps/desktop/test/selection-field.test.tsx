// @vitest-environment happy-dom
import * as Dialog from '@radix-ui/react-dialog'
import { resolveOverlayContainer } from '../src/renderer/src/components/WindowOverlayHost'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SelectionField, type SelectionOption } from '../src/renderer/src/components/SelectionField'
import { chooseField } from './helpers/selection-field'

let container: HTMLElement, root: Root
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
const key = async (node: HTMLElement, key: string) => { await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))); await settle() }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
const choices: SelectionOption[] = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Bravo' }, { value: 'c', label: 'Charlie' }, { value: 'd', label: 'Disabled', disabled: true }]
async function mount({ value = 'b', options = choices } = {}) {
  const changed = vi.fn(), submitted = vi.fn()
  function Scene() { const [selected, setSelected] = useState(value); return <form onSubmit={event => { event.preventDefault(); submitted() }}><SelectionField label="Original choice" value={selected} options={options} onValueChange={value => { changed(value); setSelected(value) }} /></form> }
  await act(async () => root.render(<Scene />)); await settle()
  return { trigger: container.querySelector<HTMLButtonElement>('button')!, changed, submitted }
}
it('keyboard typeahead and choice preserve explicit form submission and original focus', async () => {
  const { trigger, changed, submitted } = await mount()
  expect(trigger.textContent).toContain('Bravo'); expect(trigger.type).toBe('button')
  trigger.focus(); await key(trigger, 'ArrowDown')
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu.closest('[data-overlay-host]')).not.toBeNull()
  expect(menu.querySelector('[aria-checked="true"]')?.textContent).toBe('Bravo')
  await key(menu, 'c')
  expect(document.activeElement?.textContent).toBe('Charlie')
  await key(document.activeElement as HTMLElement, 'Enter')
  expect(changed).toHaveBeenCalledExactlyOnceWith('c'); expect(submitted).not.toHaveBeenCalled()
  expect(trigger.textContent).toContain('Charlie'); expect(document.activeElement).toBe(trigger)
  await key(trigger, 'Enter'); expect(document.querySelector('[role="menu"]')).not.toBeNull()
  await key(document.activeElement as HTMLElement, 'Escape')
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger)
  expect(submitted).not.toHaveBeenCalled()
})
it('disabled options cannot alter the value or invoke the caller', async () => {
  const { trigger, changed, submitted } = await mount()
  await chooseField(trigger, 'd')
  expect(changed).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled(); expect(trigger.textContent).toContain('Bravo')
  expect(document.querySelector('[role="menu"] [data-value="d"]')?.getAttribute('aria-disabled')).toBe('true')
})
it('unknown current identity stays visible and never becomes the first choice', async () => {
  const { trigger, changed } = await mount({ value: 'original-unknown' })
  expect(document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent).toContain('original-unknown'); expect(trigger.title).toContain('original-unknown'); expect(trigger.textContent).toContain('not in current options')
  await key(trigger, 'ArrowDown')
  expect(document.querySelector('[aria-checked="true"]')?.textContent).toContain('Saved selection')
  expect(changed).not.toHaveBeenCalled()
  await chooseField(trigger, 'a'); expect(changed).toHaveBeenCalledExactlyOnceWith('a')
})
it('a removed selected option preserves its raw identity and requires a fresh explicit choice', async () => {
  const changed = vi.fn()
  await act(async () => root.render(<SelectionField label="Original choice" value="b" options={choices} onValueChange={changed} />)); await settle()
  const trigger = container.querySelector<HTMLButtonElement>('button')!
  await key(trigger, 'ArrowDown')
  await act(async () => root.render(<SelectionField label="Original choice" value="b" options={[choices[0]!]} onValueChange={changed} />)); await settle()
  expect(document.querySelector('[data-value="b"]')?.textContent).toContain('Saved selection')
  expect(changed).not.toHaveBeenCalled()
  await key(document.activeElement as HTMLElement, 'Escape'); expect(trigger.dataset.value).toBe('b')
})

it('disabling an already open field refuses new selection without submitting the form', async () => {
  const changed = vi.fn()
  await act(async () => root.render(<SelectionField label="Original choice" value="b" options={choices} onValueChange={changed} />)); await settle()
  const trigger = container.querySelector<HTMLButtonElement>('button')!
  await key(trigger, 'ArrowDown')
  await act(async () => root.render(<SelectionField label="Original choice" value="b" options={choices} onValueChange={changed} disabled />)); await settle()
  await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="a"]')!.click()); await settle()
  expect(trigger.disabled).toBe(true); expect(changed).not.toHaveBeenCalled(); expect(trigger.dataset.value).toBe('b')
})

it('pointer disclosure and choice never submit the executing form', async () => {
  const { trigger, changed, submitted } = await mount()
  await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })); trigger.click() }); await settle()
  expect(submitted).not.toHaveBeenCalled()
  await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="c"]')!.click()); await settle()
  expect(changed).toHaveBeenCalledExactlyOnceWith('c'); expect(submitted).not.toHaveBeenCalled()
})

it('a nested menu uses the original Dialog band and one Escape preserves its parent and focus', async () => {
  const dismissed = vi.fn()
  await act(async () => root.render(<Dialog.Root defaultOpen onOpenChange={open => { if (!open) dismissed() }}>
    <Dialog.Portal container={resolveOverlayContainer()}><div className="window-overlay-host__entry" data-overlay-layer="dialog">
      <Dialog.Content aria-describedby={undefined}><Dialog.Title>Original editor</Dialog.Title>
        <SelectionField label="Nested choice" value="b" options={choices} onValueChange={() => {}} />
      </Dialog.Content></div></Dialog.Portal>
  </Dialog.Root>)); await settle()
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Nested choice"]')!
  await key(trigger, 'ArrowDown')
  expect(document.querySelector('[role="menu"]')?.closest<HTMLElement>('[data-overlay-layer]')?.dataset.overlayLayer).toBe('dialog')
  await key(document.activeElement as HTMLElement, 'Escape')
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(dismissed).not.toHaveBeenCalled(); expect(document.activeElement).toBe(trigger)
})
