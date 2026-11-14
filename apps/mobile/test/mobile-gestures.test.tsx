import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMIT_DISTANCE_PX, EDGE_START_PX, createEdgeBackTracker, useEdgeBack } from '../src/navigation/use-edge-back'
import { MobileSheetHandle, SHEET_CLOSE_DISTANCE_PX, sheetDragCloses } from '../src/navigation/MobileSheetHandle'

const at = (x: number, y = 300, t = 0) => ({ x, y, t })
function swipe(points: Array<[number, number, number]>) {
  const tracker = createEdgeBackTracker(), offsets: Array<number | null> = []
  const [first, ...rest] = points, last = rest.pop() ?? first!
  tracker.start(at(...first!))
  for (const point of rest) offsets.push(tracker.move(at(...point)))
  offsets.push(tracker.move(at(...last)))
  return { offsets, commit: tracker.end(at(...last)) }
}

describe('left-edge swipe back geometry', () => {
  it('commits a sideways drag that starts at the edge and travels far enough', () => {
    const result = swipe([[4, 300, 0], [30, 302, 40], [60, 304, 120], [4 + COMMIT_DISTANCE_PX + 2, 305, 260]])
    expect(result.commit).toBe(true)
    expect(result.offsets.at(-1)).toBe(COMMIT_DISTANCE_PX + 2)
  })
  it('commits a short quick flick, and springs back from a short slow drag', () => {
    expect(swipe([[2, 300, 0], [14, 300, 20], [40, 301, 60]]).commit).toBe(true)
    expect(swipe([[2, 300, 0], [14, 300, 200], [40, 301, 900]]).commit).toBe(false)
  })
  it('ignores touches that start away from the edge and drags that are mostly vertical', () => {
    expect(swipe([[EDGE_START_PX + 6, 300, 0], [120, 300, 80], [200, 300, 160]]).commit).toBe(false)
    const vertical = swipe([[6, 300, 0], [12, 340, 40], [90, 420, 200]])
    expect(vertical.commit).toBe(false)
    expect(vertical.offsets.at(-1)).toBeNull()
  })
  it('never follows the finger to the left of where it started', () => {
    const result = swipe([[10, 300, 0], [30, 300, 40], [5, 300, 400]])
    expect(result.offsets.at(-1)).toBe(0)
    expect(result.commit).toBe(false)
  })
})

describe('the bound edge gesture', () => {
  const roots: ReturnType<typeof createRoot>[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.restoreAllMocks() })
  function touch(type: string, x: number, y: number, t: number, identifier = 1, touches?: Array<{ identifier: number; clientX: number; clientY: number }>) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: unknown[]; changedTouches: unknown[] }
    const point = { identifier, clientX: x, clientY: y }
    Object.defineProperty(event, 'timeStamp', { value: t })
    event.touches = touches ?? (type === 'touchend' ? [] : [point]); event.changedTouches = [point]
    return event
  }
  async function mount(enabled: boolean, onBack: () => void) {
    function Layer({ revision }: { revision: number }) { const ref = useRef<HTMLElement>(null); useEdgeBack(ref, enabled, onBack, revision); return <main ref={ref}><div className="mobile-terminal-canvas" /></main> }
    const node = document.createElement('div'); document.body.append(node)
    const root = createRoot(node); roots.push(root)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const render = (revision: number) => act(async () => root.render(<Layer revision={revision} />))
    await render(0)
    return { main: node.querySelector('main')!, render }
  }
  it('follows the finger, then calls the same Back once on a committed release', async () => {
    const back = vi.fn(), { main, render } = await mount(true, back)
    main.dispatchEvent(touch('touchstart', 6, 300, 0))
    const drag = touch('touchmove', 50, 302, 80); main.dispatchEvent(drag)
    expect(drag.defaultPrevented).toBe(true)
    expect(main.dataset.edgeBack).toBe('tracking')
    expect(main.style.getPropertyValue('--mobile-edge-offset')).toBe('44px')
    main.dispatchEvent(touch('touchmove', 110, 304, 200))
    main.dispatchEvent(touch('touchend', 110, 304, 260))
    expect(back).toHaveBeenCalledTimes(1)
    expect(main.dataset.edgeBack).toBe('committed')
    expect(main.style.getPropertyValue('--mobile-edge-offset')).toBe('104px')
    await render(1)
    expect(main.dataset.edgeBack).toBeUndefined()
    expect(main.style.getPropertyValue('--mobile-edge-offset')).toBe('')
  })
  it('does nothing when there is nothing to go back to, and leaves vertical scrolling alone', async () => {
    const back = vi.fn(), { main: off } = await mount(false, back)
    off.dispatchEvent(touch('touchstart', 6, 300, 0)); off.dispatchEvent(touch('touchmove', 120, 300, 80)); off.dispatchEvent(touch('touchend', 120, 300, 120))
    expect(back).not.toHaveBeenCalled()
    const { main: on } = await mount(true, back)
    on.dispatchEvent(touch('touchstart', 6, 300, 0))
    const scroll = touch('touchmove', 10, 360, 60); on.dispatchEvent(scroll)
    expect(scroll.defaultPrevented).toBe(false)
    on.dispatchEvent(touch('touchend', 10, 420, 120))
    expect(back).not.toHaveBeenCalled()
  })
  it('registers no blocking move listener for normal reading or the terminal canvas, and releases it on vertical movement', async () => {
    const add = vi.spyOn(HTMLElement.prototype, 'addEventListener'), remove = vi.spyOn(HTMLElement.prototype, 'removeEventListener')
    const { main } = await mount(true, vi.fn())
    const moves = () => add.mock.calls.filter((args, index) => add.mock.instances[index] === main && args[0] === 'touchmove')
    expect(moves()).toHaveLength(0)
    main.dispatchEvent(touch('touchstart', 180, 300, 0))
    const normal = touch('touchmove', 180, 400, 100); main.dispatchEvent(normal)
    expect(normal.defaultPrevented).toBe(false); expect(moves()).toHaveLength(0)
    main.querySelector('.mobile-terminal-canvas')!.dispatchEvent(touch('touchstart', 6, 300, 200))
    expect(moves()).toHaveLength(0)
    main.dispatchEvent(touch('touchstart', 6, 300, 300))
    expect(moves()).toHaveLength(1); expect(moves()[0]![2]).toEqual({ passive: false })
    const scroll = touch('touchmove', 10, 370, 400); main.dispatchEvent(scroll)
    expect(scroll.defaultPrevented).toBe(false)
    expect(remove.mock.calls.some((args, index) => remove.mock.instances[index] === main && args[0] === 'touchmove')).toBe(true)
    expect(main.dataset.edgeBack).toBeUndefined()
  })
  it('keeps the starting finger identity and cancels as soon as a second finger lands', async () => {
    const back = vi.fn(), { main } = await mount(true, back)
    main.dispatchEvent(touch('touchstart', 6, 300, 0))
    main.dispatchEvent(touch('touchmove', 30, 301, 80))
    expect(main.dataset.edgeBack).toBe('tracking')
    // A changed touch from another finger cannot finish the first finger's gesture.
    main.dispatchEvent(touch('touchend', 300, 300, 100, 2, [{ identifier: 1, clientX: 30, clientY: 301 }]))
    expect(back).not.toHaveBeenCalled(); expect(main.style.getPropertyValue('--mobile-edge-offset')).toBe('24px')
    main.dispatchEvent(touch('touchstart', 300, 300, 120, 2, [{ identifier: 1, clientX: 30, clientY: 301 }, { identifier: 2, clientX: 300, clientY: 300 }]))
    expect(main.dataset.edgeBack).toBeUndefined()
    main.dispatchEvent(touch('touchmove', 150, 301, 150)); main.dispatchEvent(touch('touchend', 150, 301, 200))
    expect(back).not.toHaveBeenCalled()
  })

})

describe('dragging a sheet down to close', () => {
  const roots: ReturnType<typeof createRoot>[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })
  it('closes past the distance or on a quick flick, and springs back otherwise', () => {
    expect(sheetDragCloses(SHEET_CLOSE_DISTANCE_PX, 0)).toBe(true)
    expect(sheetDragCloses(40, 0.8)).toBe(true)
    expect(sheetDragCloses(40, 0.1)).toBe(false)
    expect(sheetDragCloses(10, 2)).toBe(false)
  })
  async function sheet(onClose: () => void) {
    const node = document.createElement('div'); document.body.append(node)
    const root = createRoot(node); roots.push(root)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => root.render(<section className="mobile-sheet"><MobileSheetHandle onClose={onClose} /></section>))
    return { sheet: node.querySelector<HTMLElement>('.mobile-sheet')!, handle: node.querySelector<HTMLElement>('.mobile-sheet-handle')! }
  }
  function pointer(type: string, y: number, t: number, id = 1) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, button: 0 }) as MouseEvent & { pointerId: number }
    Object.defineProperty(event, 'pointerId', { value: id }); Object.defineProperty(event, 'timeStamp', { value: t })
    return event
  }
  it('moves the sheet with the finger and closes once on a long drag', async () => {
    const close = vi.fn(), view = await sheet(close)
    await act(async () => { view.handle.dispatchEvent(pointer('pointerdown', 500, 0)); view.handle.dispatchEvent(pointer('pointermove', 560, 120)) })
    expect(view.sheet.dataset.sheetDrag).toBe('tracking')
    expect(view.sheet.style.getPropertyValue('--mobile-sheet-drag')).toBe('60px')
    await act(async () => { view.handle.dispatchEvent(pointer('pointermove', 640, 300)); view.handle.dispatchEvent(pointer('pointerup', 640, 400)) })
    expect(close).toHaveBeenCalledTimes(1)
    expect(view.sheet.dataset.sheetDrag).toBeUndefined()
  })
  it('springs back from a short slow drag and never follows an upward drag', async () => {
    const close = vi.fn(), view = await sheet(close)
    await act(async () => { view.handle.dispatchEvent(pointer('pointerdown', 500, 0)); view.handle.dispatchEvent(pointer('pointermove', 440, 200)) })
    expect(view.sheet.style.getPropertyValue('--mobile-sheet-drag')).toBe('0px')
    await act(async () => { view.handle.dispatchEvent(pointer('pointermove', 540, 900)); view.handle.dispatchEvent(pointer('pointerup', 540, 1400)) })
    expect(close).not.toHaveBeenCalled()
    expect(view.sheet.style.getPropertyValue('--mobile-sheet-drag')).toBe('')
  })

  it('retains the first finger and returns to rest when only its capture is lost', async () => {
    const close = vi.fn(), view = await sheet(close)
    const send = (type: string, y: number, time: number, id: number) => view.handle.dispatchEvent(pointer(type, y, time, id))
    await act(async () => {
      send('pointerdown', 500, 0, 1)
      send('pointermove', 550, 120, 1)
      send('pointerdown', 500, 150, 2)
      send('pointermove', 700, 230, 2)
      send('lostpointercapture', 700, 250, 2)
    })
    expect(view.sheet.style.getPropertyValue('--mobile-sheet-drag')).toBe('50px')
    await act(async () => {
      send('lostpointercapture', 550, 300, 1)
      send('pointerup', 660, 400, 1)
    })
    expect(view.sheet.dataset.sheetDrag).toBeUndefined()
    expect(view.sheet.style.getPropertyValue('--mobile-sheet-drag')).toBe('')
    expect(close).not.toHaveBeenCalled()
  })
})
