// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ImageContent } from '../src/ui/ImageContent'

it('keeps file zoom controls and cancels only the pointer that owns the pan', async () => {
  let resize: (() => void) | undefined
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ImageContent src="https://fixture.test/atlas.svg" name="Atlas" />))
    const viewport = container.querySelector<HTMLDivElement>('[aria-label="Image Atlas"]')!
    const image = viewport.querySelector('img')!
    const level = container.querySelector('output')!
    const captured = new Set<number>()
    Object.defineProperties(viewport, {
      clientWidth: { value: 232 }, clientHeight: { value: 232 },
      scrollWidth: { value: 832 }, scrollHeight: { value: 832 },
      setPointerCapture: { value: (id: number) => captured.add(id) },
      hasPointerCapture: { value: (id: number) => captured.has(id) },
      releasePointerCapture: { value: (id: number) => captured.delete(id) },
    })
    Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 800 } })
    await act(async () => {
      resize?.()
      image.dispatchEvent(new Event('load'))
    })
    expect(level.textContent).toBe('25%')
    const press = (key: string) => act(async () => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }))
    })
    await press('1')
    expect(level.textContent).toBe('100%')
    await press('+')
    await press('-')
    expect(level.textContent).toBe('100%')
    viewport.scrollLeft = 100
    const pointer = (type: string, pointerId: number, clientX: number) => act(async () => {
      viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId, clientX }))
    })
    await pointer('pointerdown', 1, 90)
    await pointer('pointerdown', 2, 70)
    expect([...captured]).toEqual([1])
    await pointer('pointermove', 2, 45)
    expect(viewport.scrollLeft).toBe(100)
    await pointer('pointermove', 1, 65)
    expect(viewport.scrollLeft).toBe(125)
    expect(viewport.hasAttribute('data-dragging')).toBe(true)
    await pointer('pointercancel', 2, 45)
    expect([...captured]).toEqual([1])
    await pointer('pointercancel', 1, 65)
    await pointer('pointermove', 1, 0)
    expect(viewport.scrollLeft).toBe(125)
    expect(viewport.hasAttribute('data-dragging')).toBe(false)
    expect([...captured]).toEqual([])
    await press('0')
    expect(level.textContent).toBe('25%')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
