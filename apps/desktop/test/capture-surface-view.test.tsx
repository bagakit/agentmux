// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { CaptureSurfaceView } from '../src/renderer/screenshot-editor/CaptureSurfaceView'
import type { CaptureBackground, CaptureSurfaceApi, CaptureSurfaceEvent, CaptureSurfaceInput } from '../src/shared/capture-surface'
import type { BrowserPng } from '../src/shared/contracts'

const compose = vi.hoisted(() => vi.fn())
const raster = vi.hoisted(() => ({ renderCommittedLayer: vi.fn(), renderScreenshotScene: vi.fn() }))
// The overlay host and the shared editor are production code; raster drawing and pixel composition are replaced.
vi.mock('../src/renderer/src/components/image-annotation/canvas-render', () => raster)
vi.mock('../src/renderer/src/components/image-annotation/compose', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/components/image-annotation/compose')>(), composeScreenshot: compose
}))
const image: BrowserPng = { mimeType: 'image/png', width: 1600, height: 1000, byteLength: 68,
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
const excludedImage: BrowserPng = { ...image, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIW2P4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' }
const remembered = { x: 600, y: 200, width: 400, height: 200 }
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
let paintId = 0, paints = new Map<number, FrameRequestCallback>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, toJSON() {} }))
  paintId = 0; paints = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paints.set(++paintId, callback); return paintId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { paints.delete(id) })
  const context = new Proxy({ measureText: () => ({ width: 20 }) }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {}, set: () => true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  compose.mockResolvedValue(image); raster.renderCommittedLayer.mockClear(); raster.renderScreenshotScene.mockClear()
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function paint() {
  await act(async () => { const pending = [...paints.values()]; paints.clear(); for (const callback of pending) callback(16) })
}

async function mount(owned: boolean, background: CaptureBackground = 'included', loaded = true, notice?: string, issue = false) {
  const stopAutomaticLoad = (event: Event) => event.stopImmediatePropagation()
  if (!loaded) node.addEventListener('load', stopAutomaticLoad, true)
  let listener: ((event: CaptureSurfaceEvent) => void) | undefined
  const api = { load: vi.fn(), switchBackground: vi.fn(async () => {}), presented: vi.fn(async () => {}), select: vi.fn(async () => owned), onEvent: (receive: (event: CaptureSurfaceEvent) => void) => { listener = receive; return () => {} },
    finish: vi.fn(async () => ({ status: 'completed' as const })), pin: vi.fn(), savePng: vi.fn(async () => ({ status: 'cancelled' as const })), copyText: vi.fn(),
    expand: vi.fn(async () => {}), cancel: vi.fn(async () => {}) } satisfies CaptureSurfaceApi
  const initialImage = loaded ? image : { ...image, dataUrl: 'data:image/png;base64,' }
  const input: CaptureSurfaceInput = { requestId: 'original-request', displayId: 1, frame: { x: 0, y: 0, width: 800, height: 500 }, scale: 2, safeTop: 0,
    attachToDraft: false, expandable: true, theme: { status: 'unavailable', message: 'Private fixture appearance' }, background, backgrounds: {
      included: { image: initialImage, windows: [{ x: 0, y: 0, width: 800, height: 500 }], capturedAt: 1, engine: 'included-engine' },
      excluded: { image: excludedImage, windows: [], capturedAt: 2, engine: 'excluded-engine' }
    }, initialCrop: remembered, ...(notice ? { notice } : {}) }
  if (issue) input.backgrounds[background] = { capturedAt: 1, issue: 'The requested background was not captured.' }
  await act(async () => root.render(<CaptureSurfaceView key={Math.random()} input={input} api={api} />))
  await act(async () => { await Promise.resolve() })
  if (loaded && !issue) { await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load'))); await paint() }
  const key = async (key: string, init: KeyboardEventInit = {}) => {
    const canvas = node.querySelector('canvas')!
    await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
  }
  return { api, key, input, send: async (event: CaptureSurfaceEvent) => { await act(async () => listener?.(event)) }, allowLoad: () => node.removeEventListener('load', stopAutomaticLoad, true) }
}

it('a remembered selection claims the capture only when the person outputs it, then delivers that selection', async () => {
  const { api, key } = await mount(true)
  expect(node.querySelector('.image-annotation-editor__capture-bar'), 'the overlay opens on the remembered selection at rest').not.toBeNull()
  expect([api.select.mock.calls.length, api.finish.mock.calls.length], 'opening claims and delivers nothing').toEqual([0, 0])
  await key('s', { metaKey: true })
  expect(api.select, 'Save PNG claims the selection before its output').toHaveBeenCalledExactlyOnceWith('original-request')
  expect(api.select.mock.invocationCallOrder[0]!).toBeLessThan(api.savePng.mock.invocationCallOrder[0]!)
  await key('Enter')
  expect(api.finish, 'Enter delivers exactly the remembered selection').toHaveBeenCalledExactlyOnceWith('original-request', 'included', image, remembered)
  expect(api.select, 'Main never releases an owner, so the one answer serves every later output').toHaveBeenCalledOnce()
})

it('a remembered selection whose claim another display won outputs nothing and locks this display', async () => {
  const delivering = await mount(false)
  await delivering.key('Enter')
  expect(delivering.api.finish, 'a lost claim delivers nothing').not.toHaveBeenCalled()
  expect(node.querySelector('.image-annotation-editor__capture-bar'), 'the locked display drops the remembered selection').toBeNull()
  const expanding = await mount(false)
  await expanding.key('e', { metaKey: true })
  expect(expanding.api.select, 'Command E claims before the marks move').toHaveBeenCalledOnce()
  expect(expanding.api.expand, 'a lost claim moves no marks').not.toHaveBeenCalled()
})


it.each(['included', 'excluded'] as const)('the %s background supplies the frozen source and every output carries that identity', async background => {
  const { api, key, input } = await mount(true, background)
  expect(node.querySelector('img')!.getAttribute('src')).toBe(input.backgrounds[background].image!.dataUrl)
  await key('s', { metaKey: true })
  expect(api.savePng).toHaveBeenCalledExactlyOnceWith('original-request', background, image)
  await key('e', { metaKey: true })
  expect(api.expand).toHaveBeenCalledExactlyOnceWith('original-request', background, expect.objectContaining({ crop: remembered }))
})

it('reports the frame only after the shared editor loads and paints it, once for this source', async () => {
  const { api, allowLoad } = await mount(true, 'included', false)
  await paint()
  expect(api.presented, 'an unloaded image is not a frozen-frame presentation').not.toHaveBeenCalled()
  allowLoad()
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  await paint()
  expect(api.presented).toHaveBeenCalledExactlyOnceWith('original-request', 'included')
  await paint()
  expect(api.presented, 'ordinary editor paints do not duplicate the frame receipt').toHaveBeenCalledOnce()
})

it('keeps an image decoding failure visible and cancellable without claiming it painted', async () => {
  const { api, key } = await mount(true, 'included', false)
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('error')))
  await paint()
  expect(api.presented).not.toHaveBeenCalled()
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('The image could not be loaded')
  await key('Escape')
  expect(api.cancel).toHaveBeenCalledExactlyOnceWith('original-request')
})

it('names the available source when the requested background failed', async () => {
  await mount(true, 'excluded', true, 'The included background failed. Showing the excluded background.')
  expect(node.textContent).toContain('The included background failed. Showing the excluded background.')
})


it('an unavailable requested background keeps its issue until the person explicitly chooses the other frozen source', async () => {
  const { api, input, send } = await mount(true, 'excluded', true, undefined, true)
  expect(node.querySelector('img'), 'an unavailable excluded background must not reveal the included pixels').toBeNull()
  expect(node.textContent).toContain('The requested background was not captured.')
  const button = [...node.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Use background including AgentMux')!
  await act(async () => button.click())
  expect(api.switchBackground).toHaveBeenCalledExactlyOnceWith('original-request')
  expect(node.querySelector('img'), 'the explicit request still waits for its original Main receipt').toBeNull()
  await send({ kind: 'background', background: 'included' })
  expect(node.querySelector('img')!.getAttribute('src')).toBe(input.backgrounds.included.image!.dataUrl)
})


it('a background change keeps the same editor, moved selection and undo while repainting the new source', async () => {
  const { api, key, send, input } = await mount(true)
  const canvas = node.querySelector('canvas')!
  await key('ArrowRight')
  await paint()
  const previousPaints = raster.renderCommittedLayer.mock.calls.length
  await send({ kind: 'background', background: 'excluded' })
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  await paint()
  expect(node.querySelector('canvas'), 'a peer display changing background cannot replace this document').toBe(canvas)
  expect(raster.renderCommittedLayer.mock.calls.length, 'the committed layer is rebuilt for the new source').toBeGreaterThan(previousPaints)
  expect((raster.renderCommittedLayer.mock.calls.at(-1)![3] as HTMLImageElement).src).toBe(input.backgrounds.excluded.image!.dataUrl)
  await key('Enter')
  expect(api.finish).toHaveBeenLastCalledWith('original-request', 'excluded', image, { ...remembered, x: remembered.x + input.scale })
  await key('z', { metaKey: true })
  await key('Enter')
  expect(api.finish, 'undo still reaches the selection change made before the background switch').toHaveBeenLastCalledWith('original-request', 'excluded', image, remembered)
})
