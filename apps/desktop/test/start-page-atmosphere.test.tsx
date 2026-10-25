// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { StartPageAtmosphere } from '../src/renderer/src/components/StartPageAtmosphere'

let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>, reduced: boolean, mediaChanged: (() => void) | undefined
let hidden: boolean
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  reduced = false; hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ get matches() { return reduced },
    addEventListener: (_: string, handler: () => void) => { mediaChanged = handler }, removeEventListener: vi.fn()
  }) as unknown as MediaQueryList)
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 600 } as DOMRect)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
const move = (x: number, y: number) => host.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, pointerType: 'mouse', bubbles: true }))

it('batches pointer movement into one local frame and never schedules an idle loop', async () => {
  let paint!: FrameRequestCallback
  const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { paint = callback; return 41 })
  await act(async () => root.render(<StartPageAtmosphere host={{ current: host }} visible />))
  expect(frame).not.toHaveBeenCalled()
  move(150, 200); move(950, 500); move(1000, 600)
  expect(frame).toHaveBeenCalledTimes(1)
  expect(host.getBoundingClientRect).not.toHaveBeenCalled()
  await act(async () => paint(100))
  expect(host.getBoundingClientRect).toHaveBeenCalledTimes(1)
  expect(host.querySelector<HTMLElement>('.browser-start-atmosphere__plane')?.style.transform).toBe('translate3d(28.00px, 20.00px, 0px)')
  expect(frame).toHaveBeenCalledTimes(1)
  expect(host.style.transform).toBe('')
})

it('suspends pending work for reduced motion, hidden documents and hidden workfaces', async () => {
  const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42)
  const cancel = vi.spyOn(window, 'cancelAnimationFrame')
  const reference = { current: host }
  await act(async () => root.render(<StartPageAtmosphere host={reference} visible />))
  move(900, 500)
  expect(frame).toHaveBeenCalledTimes(1)
  reduced = true; mediaChanged!()
  expect(cancel).toHaveBeenCalledWith(42)
  move(500, 500)
  expect(frame).toHaveBeenCalledTimes(1)
  expect(host.querySelector<HTMLElement>('.browser-start-atmosphere__plane')?.style.transition).toBe('none')
  reduced = false; mediaChanged!()
  move(700, 500)
  expect(frame).toHaveBeenCalledTimes(2)
  hidden = true; document.dispatchEvent(new Event('visibilitychange'))
  move(800, 500)
  expect(frame).toHaveBeenCalledTimes(2)
  hidden = false; document.dispatchEvent(new Event('visibilitychange'))
  await act(async () => root.render(<StartPageAtmosphere host={reference} visible={false} />))
  move(900, 500)
  expect(frame).toHaveBeenCalledTimes(2)
})
