// @vitest-environment happy-dom
import { act, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computePosition, size } from '@floating-ui/dom'
import { ToolkitPopover } from '../src/renderer/src/components/performance/PerformancePopover'
import { ToolkitPopoverResizeHandle } from '../src/renderer/src/components/performance/ToolkitPopoverResizeHandle'
import { composerDOM } from './helpers/composer-dom-fixture'

vi.mock('@floating-ui/dom', () => ({
  autoUpdate: (_a: unknown, _b: unknown, update: () => void) => { update(); return () => {} },
  computePosition: vi.fn(async () => ({ x: 100, y: 100 })),
  flip: vi.fn(), offset: vi.fn(), shift: vi.fn(), size: vi.fn()
}))
const dom = composerDOM()
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
beforeEach(() => {
  frames.clear()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
})
function Consumer({ terminal = true }: { terminal?: boolean }) {
  const [selected, select] = useState<string | symbol | null>(null)
  return <ToolkitPopover toolId="terminal" name="Workspace monitor" icon={<span />} selectedToolId={selected} onSelectTool={select}>{close => <>
    {terminal ? <ToolkitPopoverResizeHandle /> : null}
    <button data-toolkit-close onClick={close}>Close</button>
    <div data-toolkit-terminal><textarea aria-label="Original terminal" /></div>
  </>}</ToolkitPopover>
}
function elements() {
  const panel = document.querySelector<HTMLDivElement>('.performance-popover')!
  const handle = panel.querySelector<HTMLButtonElement>('[aria-label="Resize terminal panel"]')!
  const captures = new Set<number>()
  handle.setPointerCapture = vi.fn(id => { captures.add(id) })
  handle.hasPointerCapture = vi.fn(id => captures.has(id))
  handle.releasePointerCapture = vi.fn(id => { captures.delete(id) })
  vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(() => ({ width: parseFloat(panel.style.width) || 760, height: parseFloat(panel.style.height) || 500 }) as DOMRect)
  return { panel, handle, captures }
}
async function pointer(node: Element, type: string, x: number, y: number, pointerId = 7) {
  await act(async () => node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, button: 0, clientX: x, clientY: y })))
}
async function flush() {
  const pending = [...frames.values()]; frames.clear()
  await act(async () => pending.forEach(callback => callback(1)))
}
async function key(node: Element, key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey })
  await act(async () => node.dispatchEvent(event))
  return event
}

describe('original Toolkit popover resize consumer', () => {
  it('ignores a delayed size callback after its original presenter is removed', async () => {
    await dom.render(<Consumer />); await dom.click('[data-toolkit-id="terminal"]')
    const { panel } = elements()
    const apply = (vi.mocked(size).mock.lastCall![0] as { apply(value: { availableWidth: number; availableHeight: number }): void }).apply
    apply({ availableWidth: 500, availableHeight: 400 })
    expect(panel.style.getPropertyValue('--toolkit-available-width')).toBe('500px')
    await dom.render(<Consumer terminal={false} />)
    apply({ availableWidth: 800, availableHeight: 700 })
    expect(panel.style.getPropertyValue('--toolkit-available-width')).toBe('')
    expect(panel.style.getPropertyValue('--toolkit-available-height')).toBe('')
  })
  it('anchors only the actually mounted terminal presenter at the trailing edge', async () => {
    await dom.render(<Consumer />); await dom.click('[data-toolkit-id="terminal"]')
    expect(computePosition).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ placement: 'top-end' }))
    await dom.render(<Consumer terminal={false} />)
    expect(computePosition).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ placement: 'top-start' }))
    expect(document.querySelector('[aria-label="Resize terminal panel"]')).toBeNull()
  })
  it('coalesces the captured top-left gesture, flushes its final delta and keeps the focused input', async () => {
    await dom.render(<Consumer />); await dom.click('[data-toolkit-id="terminal"]')
    const { panel, handle, captures } = elements()
    const field = panel.querySelector('textarea')!
    await act(async () => field.focus())
    await pointer(handle, 'pointerdown', 100, 100)
    expect(captures.has(7)).toBe(true)
    await pointer(handle, 'pointermove', 90, 80)
    await pointer(handle, 'pointermove', 70, 60)
    await pointer(handle, 'pointermove', 1, 1, 8)
    await pointer(handle, 'pointercancel', 1, 1, 8)
    expect(panel.style.width).toBe(''); expect(frames.size).toBe(1)
    await flush()
    expect(panel.style.width).toBe('790px'); expect(panel.style.height).toBe('540px')
    await pointer(handle, 'pointerup', 60, 50)
    expect(panel.style.width).toBe('800px'); expect(panel.style.height).toBe('550px')
    expect(captures.size).toBe(0); expect(frames.size).toBe(0)
    expect(document.activeElement).toBe(field)
    expect(panel.querySelector('textarea')).toBe(field)
    expect((await key(field, 'Escape')).defaultPrevented).toBe(false)
    expect(document.querySelector('.performance-popover')).toBe(panel)
  })
  it('supports directional keyboard sizing and restores default geometry when the presenter leaves', async () => {
    await dom.render(<Consumer />); await dom.click('[data-toolkit-id="terminal"]')
    const { panel, handle } = elements()
    expect((await key(handle, 'ArrowLeft')).defaultPrevented).toBe(true)
    await key(handle, 'ArrowUp', true)
    expect(panel.style.width).toBe('770px'); expect(panel.style.height).toBe('520px')
    await key(handle, 'ArrowRight'); await key(handle, 'ArrowDown')
    expect(panel.style.width).toBe('760px'); expect(panel.style.height).toBe('510px')
    await dom.render(<Consumer terminal={false} />)
    expect(panel.style.width).toBe(''); expect(panel.style.height).toBe('')
  })
  it.each(['pointercancel', 'lostpointercapture', 'blur', 'unmount'])('releases capture and pending work on %s, leaving later input usable', async reason => {
    await dom.render(<Consumer />); await dom.click('[data-toolkit-id="terminal"]')
    const { panel, handle, captures } = elements()
    await pointer(handle, 'pointerdown', 100, 100); await pointer(handle, 'pointermove', 50, 50)
    if (reason === 'blur') await act(async () => window.dispatchEvent(new Event('blur')))
    else if (reason === 'unmount') await dom.render(<Consumer terminal={false} />)
    else await pointer(handle, reason, 50, 50)
    expect(frames.size).toBe(0); expect(captures.size).toBe(0)
    await flush(); expect(panel.style.width).toBe(''); expect(panel.style.height).toBe('')
    if (reason !== 'unmount') {
      await pointer(handle, 'pointerdown', 100, 100); await pointer(handle, 'pointerup', 110, 110)
      expect(panel.style.width).toBe('750px'); expect(panel.style.height).toBe('490px')
    }
  })
})
