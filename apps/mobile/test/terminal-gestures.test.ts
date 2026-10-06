import { afterEach, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { bindMobileTerminalGestures } from '../src/terminal/gestures'

const dispose: Array<() => void> = []
afterEach(() => { for (const close of dispose.splice(0)) close(); document.body.innerHTML = '' })
function fixture(type: 'normal' | 'alternate' = 'normal') {
  const element = document.createElement('div'), screen = document.createElement('div')
  screen.className = 'xterm-screen'; element.append(screen); document.body.append(element)
  screen.getBoundingClientRect = () => ({ height: 240 } as DOMRect)
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 180 } as DOMRect)
  const active = { type, baseY: type === 'normal' ? 100 : 0, viewportY: type === 'normal' ? 100 : 0 }
  const scrollToLine = vi.fn((line: number) => { active.viewportY = line })
  const canvas = { options: { fontSize: 12 }, rows: 24, buffer: { active }, scrollToLine, element } as unknown as Terminal
  let control = false, visible = true
  const font = vi.fn(), frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++sequence, callback); return sequence })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  const binding = bindMobileTerminalGestures({ element, canvas, isControl: () => control, isVisible: () => visible, reportFont: font })
  dispose.push(() => binding.dispose())
  const touch = (type: string, points: Array<[number, number, number]>) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: points.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })) })
    element.dispatchEvent(event); return event
  }
  return { element, canvas, active, binding, font, frames, scrollToLine, touch,
    control: (value: boolean) => { control = value }, visible: (value: boolean) => { visible = value },
    frame() { for (const [id, callback] of frames) { frames.delete(id); callback(0) } } }
}
it('reads normal history in both directions even when application mouse input exists, and pans the retained grid locally', () => {
  const f = fixture(), wheel = vi.fn(); f.element.addEventListener('wheel', wheel)
  f.touch('touchstart', [[1, 150, 100]])
  f.touch('touchmove', [[1, 150, 150]])
  expect(f.active.viewportY).toBe(95)
  f.touch('touchmove', [[1, 150, 120]])
  expect(f.active.viewportY).toBe(98)
  f.touch('touchmove', [[1, 150, 50]])
  expect(f.active.viewportY).toBe(100); expect(f.element.scrollTop).toBe(50)
  f.touch('touchend', [])
  f.touch('touchstart', [[1, 150, 100]])
  f.touch('touchmove', [[1, 100, 100]])
  expect(f.element.scrollLeft).toBe(50); expect(wheel).not.toHaveBeenCalled()
})
it('alternate watch only pans existing geometry while explicit control delegates a standard wheel to xterm', () => {
  const f = fixture('alternate'), wheel = vi.fn(); f.element.addEventListener('wheel', wheel)
  f.touch('touchstart', [[1, 150, 150]])
  f.touch('touchmove', [[1, 150, 100]])
  expect(f.element.scrollTop).toBe(50); expect(f.scrollToLine).not.toHaveBeenCalled(); expect(wheel).not.toHaveBeenCalled()
  f.touch('touchend', []); f.control(true)
  f.touch('touchstart', [[1, 150, 150]])
  f.touch('touchmove', [[1, 150, 100]])
  expect(wheel).toHaveBeenCalledTimes(1)
  expect(wheel.mock.calls[0]![0].deltaY).toBe(50)
})
it('coalesces pinch locally, retains the reading line, prevents protocol gestures, and cancels when hidden or disposed', () => {
  const f = fixture(), leaked = vi.fn(); document.addEventListener('touchmove', leaked)
  dispose.push(() => document.removeEventListener('touchmove', leaked))
  f.active.viewportY = 20
  f.touch('touchstart', [[1, 100, 100], [2, 200, 100]])
  f.touch('touchmove', [[1, 80, 100], [2, 220, 100]])
  f.touch('touchmove', [[1, 50, 100], [2, 250, 100]])
  expect(f.frames.size).toBe(1); f.frame()
  expect(f.canvas.options.fontSize).toBe(24); expect(f.active.viewportY).toBe(20)
  expect(leaked).not.toHaveBeenCalled()
  f.touch('touchend', [[1, 50, 100]])
  f.touch('touchmove', [[1, 50, 200]])
  expect(f.active.viewportY).toBe(20)
  f.touch('touchcancel', []); f.binding.zoom(100); f.frame(); expect(f.canvas.options.fontSize).toBe(32)
  f.binding.zoom(2); f.visible(false); f.frame(); expect(f.canvas.options.fontSize).toBe(32)
  f.visible(true); f.binding.zoom(12); f.binding.dispose(); expect(f.frames.size).toBe(0)
})
