// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConfirmationDialog } from '../src/renderer/src/components/ConfirmationDialog'

let root: Root
const cancel = vi.fn(), confirm = vi.fn(), secondary = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  cancel.mockClear(); confirm.mockClear(); secondary.mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
async function mount(busy = false) {
  await act(async () => root.render(<ConfirmationDialog open title="Stop Agent Session?"
    subject="Original Agent · /repo/long-retained-workspace" description="Stopping ends this Run. Keeping the Session leaves it running."
    confirmLabel="Stop & Close" secondaryLabel="Keep Session & Close" busy={busy}
    onCancel={cancel} onConfirm={confirm} onSecondary={secondary} />))
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === label)
  expect(found, label).toBeDefined(); return found!
}
it('focuses Cancel and keeps the target and distinct keep/stop actions in the mounted shared dialog', async () => {
  await mount()
  expect(document.activeElement).toBe(button('Cancel'))
  expect(document.querySelector('.confirmation-dialog__subject')?.textContent).toBe('Original Agent · /repo/long-retained-workspace')
  expect(document.querySelector('.confirmation-dialog__icon')).toBeNull()
  await act(async () => button('Keep Session & Close').click())
  expect(secondary).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
})
it('Escape cancels once without stopping and the explicit stop is its own callback', async () => {
  await mount()
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(cancel).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled()
  await act(async () => button('Stop & Close').click())
  expect(confirm).toHaveBeenCalledTimes(1)
})
it('removing only a project view uses a neutral action without a warning glyph', async () => {
  await act(async () => root.render(<ConfirmationDialog open intent="neutral" title="Remove project view?"
    description="Files and running Agents stay untouched." confirmLabel="Remove view" onCancel={cancel} onConfirm={confirm} />))
  expect(document.querySelector('.confirmation-dialog__heading svg')).toBeNull()
  expect(button('Remove view').className).toBe('small-button confirmation-dialog__confirm--neutral')
  expect(document.querySelector('.danger-button')).toBeNull()
})
it('busy blocks Escape, outside dismissal, and every action, retaining the original dialog and subject', async () => {
  await mount(true)
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true')
  const controls = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
  expect(button('Working…').dataset.confirmLabel).toBe('Stop & Close')
  expect(controls.map(node => [node.textContent, node.disabled])).toEqual([
    ['Cancel', true], ['Keep Session & Close', true], ['Working…', true]
  ])
  await act(async () => {
    document.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    controls.forEach(node => node.click())
  })
  expect(cancel).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(secondary).not.toHaveBeenCalled()
  expect(document.querySelector('.confirmation-dialog__subject')?.textContent).toBe('Original Agent · /repo/long-retained-workspace')
})
