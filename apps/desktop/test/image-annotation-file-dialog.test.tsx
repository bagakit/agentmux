// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { AnnotationFileDialog, type AnnotationFileActionResult } from '../src/renderer/src/components/browser-screenshot/AnnotationFileDialog'

let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function deferred<T>() { let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function dialog(): HTMLElement { const found = document.querySelector<HTMLElement>('[role="dialog"]'); expect(found).not.toBeNull(); return found! }
function field(): HTMLInputElement { const found = dialog().querySelector('input'); expect(found).not.toBeNull(); return found! }
function button(name: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === name)
  expect(found, name).toBeDefined(); return found!
}
async function change(value: string) {
  const input = field()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function submit() { await act(async () => dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
async function mount(onSubmit: (path: string) => Promise<AnnotationFileActionResult>, onCheck?: (path: string) => Promise<AnnotationFileActionResult>) {
  const closed = vi.fn(), initialPath = ' annotation original.json '
  function Host() {
    const [opened, setOpened] = useState(false)
    return <><button aria-label="Original canvas action" onClick={() => setOpened(true)}>Open file dialog</button>
      {opened ? <AnnotationFileDialog mode="save" initialPath={initialPath} onSubmit={onSubmit} {...(onCheck ? { onCheck } : {})}
        onClose={() => { closed(); setOpened(false) }} /> : null}</>
  }
  await act(async () => root.render(<Host />))
  const original = node.querySelector('button')!
  const open = async () => { await act(async () => { original.focus(); original.click() }) }
  await open(); expect(field().value).toBe(initialPath)
  return { closed, open, original, initialPath }
}

describe('annotation file request dialog consumers', () => {
  it('submits the exact whitespace-bearing path once despite rapid repeated submit events', async () => {
    const pending = deferred<AnnotationFileActionResult>(), save = vi.fn(() => pending.promise)
    const { closed, initialPath } = await mount(save)
    await act(async () => {
      const form = dialog().querySelector('form')!
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(save).toHaveBeenCalledExactlyOnceWith(initialPath)
    expect(button('Cancel').disabled).toBe(false); expect(button('Saving…').disabled).toBe(true)
    await act(async () => pending.resolve({ status: 'done' }))
    expect(closed).toHaveBeenCalledOnce(); expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it.each(['Cancel', 'Escape'] as const)('keeps %s usable during a pending save and ignores its late result after another dialog opens', async method => {
    const pending = deferred<AnnotationFileActionResult>(), save = vi.fn(() => pending.promise)
    const { closed, open } = await mount(save)
    await submit(); expect(save).toHaveBeenCalledOnce()
    await act(async () => {
      if (method === 'Cancel') button('Cancel').click()
      else field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(closed).toHaveBeenCalledOnce(); expect(document.querySelector('[role="dialog"]')).toBeNull()
    await open(); const next = dialog()
    await change('another original.json')
    await act(async () => pending.resolve({ status: 'done' }))
    expect(dialog()).toBe(next); expect(field().value).toBe('another original.json')
    expect(closed).toHaveBeenCalledOnce(); expect(button('Save original').disabled).toBe(false)
  })

  it.each([{ isComposing: true }, { keyCode: 229 }])('keeps IME-owned Enter and Escape in the real input (%j)', async ownership => {
    const save = vi.fn(async () => ({ status: 'done' as const }))
    const { closed } = await mount(save)
    for (const key of ['Enter', 'Escape']) {
      const event = new KeyboardEvent('keydown', { key, ...ownership, bubbles: true, cancelable: true })
      await act(async () => field().dispatchEvent(event))
      expect(event.defaultPrevented).toBe(true); expect(dialog()).not.toBeNull()
    }
    expect(save).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled()
    await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(closed).toHaveBeenCalledOnce()
  })

  it.each(['unknown', 'conflict'] as const)('retains the exact %s path restriction until a successful read check, without closing or retrying the save', async status => {
    const save = vi.fn(async () => ({ status, message: 'Original file must be checked' })), check = vi.fn()
      .mockResolvedValueOnce({ status: 'error', message: 'Read unavailable' })
      .mockResolvedValueOnce({ status: 'done' })
    const { closed, initialPath } = await mount(save, check)
    await submit(); expect(save).toHaveBeenCalledExactlyOnceWith(initialPath)
    expect(button('Save original').disabled).toBe(true); expect(button('Check file').disabled).toBe(false)
    await submit(); expect(save).toHaveBeenCalledTimes(1)
    await change('new original.json'); expect(button('Save original').disabled).toBe(false)
    await change(initialPath); expect(button('Save original').disabled).toBe(true)
    await act(async () => button('Check file').click())
    expect(check).toHaveBeenNthCalledWith(1, initialPath); expect(button('Save original').disabled).toBe(true)
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe('Read unavailable')
    await act(async () => button('Check file').click())
    expect(check).toHaveBeenNthCalledWith(2, initialPath); expect(button('Save original').disabled).toBe(false)
    expect(dialog().querySelector('[role="status"]')!.textContent).toBe('File checked.')
    expect(save).toHaveBeenCalledTimes(1); expect(closed).not.toHaveBeenCalled()
  })
})
