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
  expect(host.querySelector<HTMLElement>('.browser-start-atmosphere__plane')?.style.transform).toBe('translate3d(10.00px, 6.00px, 0px)')
  const highlight = host.querySelector<HTMLElement>('.browser-start-atmosphere__sheen')!
  expect(highlight.style.transform).toBe('translate3d(-14.00px, -8.00px, 0px)')
  expect(Number(highlight.style.opacity)).toBeCloseTo(.82)
  expect(frame).toHaveBeenCalledTimes(1)
  expect(host.style.transform).toBe('')
  host.dispatchEvent(new PointerEvent('pointerleave'))
  expect(highlight.style.transform).toBe('translate3d(0px, 0px, 0px)')
  expect(highlight.style.opacity).toBe('0.62')
  expect(frame).toHaveBeenCalledTimes(1)
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
  for (const layer of host.querySelectorAll<HTMLElement>('.browser-start-atmosphere__plane, .browser-start-atmosphere__sheen')) {
    expect(layer.style.transition).toBe('none')
    expect(layer.style.transform).toBe('translate3d(0px, 0px, 0px)')
  }
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


it('keeps touch and static mounts still, and gives every visible workface its own gradient identities', async () => {
  const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42)
  const reference = { current: host }
  await act(async () => root.render(<><StartPageAtmosphere host={reference} visible /><StartPageAtmosphere host={reference} visible={false} /></>))
  host.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 200, pointerType: 'touch' }))
  expect(frame).not.toHaveBeenCalled()
  const ids = [...host.querySelectorAll('svg [id]')].map(element => element.id)
  expect(ids.length).toBeGreaterThan(0)
  expect(new Set(ids).size).toBe(ids.length)
  for (const svg of host.querySelectorAll('svg')) {
    for (const reference of svg.querySelectorAll('[href]')) {
      const id = reference.getAttribute('href')!.slice(1)
      expect([...svg.querySelectorAll('[id]')].some(element => element.id === id)).toBe(true)
    }
  }
})
