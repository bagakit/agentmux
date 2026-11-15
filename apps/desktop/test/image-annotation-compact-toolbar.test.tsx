// @vitest-environment happy-dom
import { act } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'

const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
vi.mock('@agentmux/client-ui/image-annotation', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/client-ui/image-annotation')>(), renderCommittedLayer: raster.committed, renderScreenshotScene: raster.scene }))
const image = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
let node: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>, frames: Map<number, FrameRequestCallback>, nextFrame: number
const cancel = vi.fn(), complete = vi.fn(), edited = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  frames = new Map(); nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 420, bottom: 300, width: 420, height: 300, toJSON() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.clearAllMocks(); node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const content = (active = true, busy = false) => <><button aria-label="Other workface">Other workface</button><ImageAnnotationEditor image={image} initialTool="pen" active={active} busy={busy} onCancel={cancel} onComplete={complete} onEdited={edited} /></>
const trigger = () => node.querySelector<HTMLButtonElement>('[aria-label="Markup tool"]')!
const canvas = () => node.querySelector<HTMLCanvasElement>('canvas')!
async function frame() { await act(async () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(16)) }) }
async function mount(busy = false) {
  await act(async () => root.render(content(true, busy))); await frame()
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
  canvas().setPointerCapture = vi.fn()
}
async function openMenu() {
  await act(async () => { trigger().focus(); trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) }); await frame()
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu, 'the actual compact markup menu must open').not.toBeNull()
  return menu
}
function item(menu: HTMLElement, label: string) { const found = menu.querySelector<HTMLElement>(`[role="menuitemradio"][aria-label="${label}"]`); expect(found, label).not.toBeNull(); return found! }
async function choose(menu: HTMLElement, label: string) { await act(async () => item(menu, label).dispatchEvent(new MouseEvent('click', { bubbles: true }))); await frame() }

it('the compact radio menu selects the actual editor tool and exposes its checked state', async () => {
  await mount(); const menu = await openMenu()
  expect(item(menu, 'Pen').getAttribute('aria-checked')).toBe('true')
  await choose(menu, 'Arrow')
  expect(trigger().textContent, 'the actual menu selection reaches the shared editor tool').toBe('Arrow')
  expect(node.querySelector('.image-annotation-editor__tool-name')!.textContent).toBe('Arrow')
  const reopened = await openMenu()
  expect(item(reopened, 'Arrow').getAttribute('aria-checked')).toBe('true')
  expect(item(reopened, 'Pen').getAttribute('aria-checked')).toBe('false')
  expect(cancel).not.toHaveBeenCalled(); expect(edited).not.toHaveBeenCalled()
})

it('Escape dismisses the compact markup popup before a later Canvas Escape cancels editing', async () => {
  await mount(); const menu = await openMenu()
  await act(async () => { menu.focus(); menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) }); await frame()
  expect(document.querySelector('[role="menu"]'), 'the first Escape dismisses only the markup menu').toBeNull()
  expect(cancel, 'closing the tool popup keeps the original image editor').not.toHaveBeenCalled()
  await act(async () => { canvas().focus(); canvas().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(cancel).toHaveBeenCalledOnce()
})

it('hiding the actual editor closes its tool portal and preserves another workface focus', async () => {
  await mount(); await openMenu()
  const other = node.querySelector<HTMLButtonElement>('[aria-label="Other workface"]')!
  await act(async () => {
    flushSync(() => root.render(content(false)))
    expect(document.querySelector('[role="menu"]'), 'an inactive editor must close its exact tool portal').toBeNull()
    other.focus()
    await new Promise(done => setTimeout(done, 1))
  }); await frame()
  expect(document.activeElement, 'late menu cleanup cannot steal another workface focus').toBe(other)
  await act(async () => other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(cancel, 'a hidden editor does not consume the other workface keys').not.toHaveBeenCalled()
  await act(async () => root.render(content(true))); await frame()
  expect(document.querySelector('[role="menu"]'), 'showing the retained image does not reopen a stale tool portal').toBeNull()
})

it('the busy compact menu keeps only Pan selectable and pans without adding an edit', async () => {
  await mount(true); const menu = await openMenu(), pan = item(menu, 'Pan')
  expect(pan.getAttribute('aria-disabled'), 'actual busy Pan stays available').toBeNull()
  expect([...menu.querySelectorAll('[role="menuitemradio"]')].filter(value => value !== pan).every(value => value.getAttribute('aria-disabled') === 'true')).toBe(true)
  await choose(menu, 'Arrow')
  expect(trigger().textContent).toBe('Pen')
  await choose(menu, 'Pan')
  expect(trigger().textContent).toBe('Pan')
  const before = { ...raster.committed.mock.lastCall![2].view }
  await act(async () => {
    for (const [type, x, y] of [['pointerdown', 80, 90], ['pointermove', 120, 140], ['pointerup', 120, 140]] as const)
      canvas().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }))
  }); await frame()
  expect(raster.committed.mock.lastCall![2].view, 'the actual busy gesture reaches image pan').toMatchObject({ x: before.x + 40, y: before.y + 50 })
  expect(edited).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
})
