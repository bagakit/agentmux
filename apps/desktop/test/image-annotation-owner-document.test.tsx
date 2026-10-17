// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'

it('uses the actual image document for keyboard ownership and exposes the host attachment action', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const frame = document.createElement('iframe'); document.body.append(frame)
  const foreign = frame.contentDocument!, owner = foreign.defaultView!
  const container = foreign.createElement('div'); foreign.body.append(container)
  vi.spyOn(owner, 'requestAnimationFrame').mockReturnValue(1)
  vi.spyOn(owner, 'cancelAnimationFrame').mockImplementation(() => {})
  const root = createClientUiRoot(container), cancel = vi.fn(), complete = vi.fn()
  const props = { image: { dataUrl: 'data:image/png;base64,AA==', width: 400, height: 300 }, busy: false,
    ownerDocument: foreign, title: 'Captured image', completeLabel: 'Attach processed image', onCancel: cancel, onComplete: complete }
  try {
    await act(async () => root.render(<ImageAnnotationEditor {...props} />))
    expect(foreign.querySelector('[aria-label="Captured image"]')).not.toBeNull()
    expect([...foreign.querySelectorAll('button')].some(button => button.textContent?.includes('Attach processed image'))).toBe(true)
    const canvas = foreign.querySelector('canvas')!; canvas.focus()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(cancel).not.toHaveBeenCalled()
    await act(async () => canvas.dispatchEvent(new owner.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })))
    expect(cancel).not.toHaveBeenCalled()
    await act(async () => canvas.dispatchEvent(new owner.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(cancel).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<ImageAnnotationEditor {...props} active={false} />))
    await act(async () => canvas.dispatchEvent(new owner.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(cancel).toHaveBeenCalledTimes(1); expect(complete).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); frame.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})
