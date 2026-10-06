// @vitest-environment happy-dom
import { act, useCallback, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSidebarResize } from '../src/renderer/src/hooks/useSidebarResize'
let host: HTMLDivElement, root: Root, nextFrame: number
const frames = new Map<number, FrameRequestCallback>(), commits: number[] = [], drafts: number[] = []
const reportDraft = (width: number) => drafts.push(width)
function Surface({ open = true, resizable = open, max = 420, identity = 'original' }: { open?: boolean; resizable?: boolean; max?: number; identity?: string }) {
  const [width, update] = useState(210), setWidth = useCallback((next: number) => { commits.push(next); update(next) }, [])
  const resize = useSidebarResize<HTMLElement>({ isOpen: open, resizable, width, minWidth: 48, maxWidth: max, defaultWidth: 220, deltaSign: 1, setWidth, onDraftWidthChange: reportDraft })
  return <section ref={resize.containerRef} data-resizing={resize.isResizing} data-surface={identity}><button onMouseDown={resize.onResizeStart} onDoubleClick={resize.onResizeReset}
    onKeyDown={event => { if (event.key === 'Enter') resize.onResizeReset(event) }}>Resize</button><output>{width}</output></section>
}
const surface = () => host.querySelector<HTMLElement>('section')!
async function render(props = {}) { await act(async () => root.render(<Surface {...props} />)) }
async function down(button = 0) { await act(async () => host.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button, clientX: 210 }))) }
async function move(x: number, paint = true) { await act(async () => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: x })); if (paint) { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(1) } }) }
async function key(composing = false) { const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: composing }); await act(async () => window.dispatchEvent(event)); return event }
async function up() { await act(async () => window.dispatchEvent(new MouseEvent('mouseup'))) }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); nextFrame = 0; frames.clear(); commits.length = 0; drafts.length = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame }); vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

it('Escape cancels a pending draft frame, restores the original width and cannot commit on later release', async () => {
  await render(); await down(); await move(300, false); expect(frames.size).toBe(1)
  const event = await key(); expect(event.defaultPrevented).toBe(true); expect(surface().style.width).toBe('210px')
  expect(surface().dataset.resizing).toBe('false'); expect(frames.size).toBe(0); expect(drafts.at(-1)).toBe(210)
  await up(); expect(commits).toEqual([]); expect(document.body.style.cursor).toBe(''); expect(document.body.style.userSelect).toBe('')
})
it('normal release and blur keep one final commit', async () => {
  await render(); await down(); await move(300); expect(surface().style.width).toBe('300px'); expect(commits).toEqual([])
  await up(); await act(async () => window.dispatchEvent(new Event('blur'))); expect(commits).toEqual([300])
})
it('IME Escape remains owned by input and does not cancel the active gesture', async () => {
  await render(); await down(); await move(300); expect((await key(true)).defaultPrevented).toBe(false)
  expect(surface().dataset.resizing).toBe('true'); await up(); expect(commits).toEqual([300])
  const enter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true, bubbles: true })
  await act(async () => host.querySelector('button')!.dispatchEvent(enter))
  expect(enter.defaultPrevented).toBe(false); expect(commits).toEqual([300])
})
it('nonleft and nonresizable occurrences leave ordinary Escape untouched', async () => {
  await render(); await down(2); expect(surface().dataset.resizing).toBe('false'); expect((await key()).defaultPrevented).toBe(false)
  await render({ resizable: false }); await down(); await move(300); expect(surface().style.width).toBe('210px'); expect(commits).toEqual([])
})
it('reset cancels a draft and persists the original default rather than a narrow viewport clamp', async () => {
  await render({ max: 100 }); await down(); await move(300)
  await act(async () => host.querySelector('button')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })))
  expect(commits).toEqual([220]); expect(surface().style.width).toBe('100px'); expect(host.querySelector('output')!.textContent).toBe('220')
  await up(); expect(commits).toEqual([220])
})

it('the original handle second click restores the default only after release without movement', async () => {
  await render(); await down(); await move(300); await up()
  await act(async () => host.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 2, bubbles: true, cancelable: true })))
  expect(host.querySelector('output')!.textContent).toBe('300'); expect(document.body.style.cursor).toBe('col-resize')
  expect(surface().dataset.resizing).toBe('true'); await up(); expect(commits).toEqual([300, 220])
})
it('a second native press followed by movement remains a drag and blur cannot complete a double-click', async () => {
  await render()
  await act(async () => host.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 2, clientX: 210, bubbles: true, cancelable: true })))
  await move(250); await up(); expect(commits).toEqual([250])
  await act(async () => host.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 2, clientX: 210, bubbles: true, cancelable: true })))
  await act(async () => window.dispatchEvent(new Event('blur')))
  expect(commits).toEqual([250]); await up(); expect(commits).toEqual([250])
})
it('vertical movement followed by return to the press point cannot complete a second click', async () => {
  await render()
  await act(async () => host.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { detail: 2, clientX: 210, clientY: 20, bubbles: true })))
  await act(async () => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 210, clientY: 21 })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: 210, clientY: 20 })) })
  await up(); expect(commits).toEqual([]); expect(surface().style.width).toBe('210px')
})
it('a retained hidden occurrence cancels immediately without changing its rendered shell or preference', async () => {
  await render(); await down(); await move(300); await render({ resizable: false })
  expect(surface().style.width).toBe('210px'); expect(surface().dataset.resizing).toBe('false'); expect(commits).toEqual([])
  await up(); expect(commits).toEqual([]); expect(document.body.style.cursor).toBe('')
})
it('a changed available bound cancels the old frame and clamps presentation without saving it', async () => {
  await render(); await down(); await move(300, false); await render({ max: 100 })
  expect(frames.size).toBe(0); expect(surface().style.width).toBe('100px'); expect(surface().dataset.resizing).toBe('false')
  await up(); expect(commits).toEqual([])
})
it('unmount releases the frame, drag shield and Escape handler', async () => {
  await render(); const children = document.body.children.length; await down(); await move(300, false)
  expect(document.body.children.length).toBe(children + 1); await act(async () => root.render(null))
  expect(frames.size).toBe(0); expect(document.body.children.length).toBe(children); expect((await key()).defaultPrevented).toBe(false)
  expect(document.body.style.cursor).toBe(''); expect(document.body.style.userSelect).toBe(''); expect(commits).toEqual([])
})

it('an inactive sibling changing bounds or unmounting cannot clear the active gesture styles', async () => {
  await act(async () => root.render(<div><Surface identity="active" key="active" /><Surface identity="other" key="other" /></div>))
  await down(); await move(300)
  await act(async () => root.render(<div><Surface identity="active" key="active" /><Surface identity="other" key="other" max={100} /></div>))
  expect(document.body.style.cursor).toBe('col-resize'); expect(document.body.style.userSelect).toBe('none')
  expect(surface().style.width).toBe('300px'); expect(surface().dataset.resizing).toBe('true')
  await act(async () => root.render(<div><Surface identity="active" key="active" /></div>))
  expect(document.body.style.cursor).toBe('col-resize'); expect(document.body.style.userSelect).toBe('none')
  await key(); await up(); expect(commits).toEqual([]); expect(document.body.style.cursor).toBe('')
})
