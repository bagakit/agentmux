// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { CaptureSurfaceView } from '../src/renderer/screenshot-editor/CaptureSurfaceView'
import type { CaptureBackground, CaptureSurfaceApi, CaptureSurfaceEvent, CaptureSurfaceInput } from '../src/shared/capture-surface'
import type { BrowserPng } from '../src/shared/contracts'

const compose = vi.hoisted(() => vi.fn())
const raster = vi.hoisted(() => ({ renderCommittedLayer: vi.fn(), renderScreenshotScene: vi.fn() }))
const editorHarness = vi.hoisted(() => ({ props: null as any }))
// Keep the real shared editor, while exposing its host callbacks for the no-crop defense-in-depth case.
vi.mock('../src/renderer/src/components/image-annotation/ImageAnnotationEditor', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/image-annotation/ImageAnnotationEditor')>()
  const { createElement } = await import('react')
  return { ...actual, ImageAnnotationEditor: (props: any) => { editorHarness.props = props; return createElement(actual.ImageAnnotationEditor, props) } }
})
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
const windowOutline = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, toJSON() {} }))
  paintId = 0; paints = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paints.set(++paintId, callback); return paintId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { paints.delete(id) })
  windowOutline.mockClear()
  const context = new Proxy({ measureText: () => ({ width: 20 }), strokeRect: windowOutline, getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 255]) }) }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {}, set: () => true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  compose.mockResolvedValue(image); raster.renderCommittedLayer.mockClear(); raster.renderScreenshotScene.mockClear(); editorHarness.props = null
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function paint() {
  await act(async () => { const pending = [...paints.values()]; paints.clear(); for (const callback of pending) callback(16) })
}

async function mount(owned: boolean, background: CaptureBackground = 'included', loaded = true, notice?: string, issue = false, initialCrop: typeof remembered | null = remembered, deferred = false) {
  const stopAutomaticLoad = (event: Event) => event.stopImmediatePropagation()
  if (!loaded) node.addEventListener('load', stopAutomaticLoad, true)
  let listener: ((event: CaptureSurfaceEvent) => void) | undefined
  const api = { load: vi.fn(), switchBackground: vi.fn(async () => {}), presented: vi.fn(async () => {}), select: vi.fn(async () => owned), onEvent: (receive: (event: CaptureSurfaceEvent) => void) => { listener = receive; return () => {} },
    finish: vi.fn(async () => ({ status: 'completed' as const })), pin: vi.fn(), savePng: vi.fn(async () => ({ status: 'cancelled' as const })), copyText: vi.fn(),
    source: vi.fn(), sequence: vi.fn(), liveInput: vi.fn(), expand: vi.fn(async () => {}), cancel: vi.fn(async () => {}) } satisfies CaptureSurfaceApi
  const initialImage = loaded ? image : { ...image, dataUrl: 'data:image/png;base64,' }
  const input: CaptureSurfaceInput = { requestId: 'original-request', revision: 1, displayId: 1, frame: { x: 0, y: 0, width: 800, height: 500 }, scale: 2, safeTop: 0,
    attachToDraft: false, expandable: true, theme: { status: 'unavailable', message: 'Private fixture appearance' }, background, backgrounds: {
      included: { status: 'ready', image: initialImage, windows: [{ x: 0, y: 0, width: 800, height: 500 }], capturedAt: 1, engine: 'included-engine' },
      excluded: deferred ? { status: 'pending', capturedAt: 0 } : { status: 'ready', image: excludedImage, windows: [], capturedAt: 2, engine: 'excluded-engine' }
    }, ...(initialCrop ? { initialCrop } : {}), ...(notice ? { notice } : {}) }
  if (issue) input.backgrounds[background] = { status: 'failed', capturedAt: 1, issue: 'The requested background was not captured.' }
  await act(async () => root.render(<CaptureSurfaceView key={Math.random()} input={input} api={api} />))
  await act(async () => { await Promise.resolve() })
  if (loaded && !issue) { await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load'))); await paint() }
  const key = async (key: string, init: KeyboardEventInit = {}) => {
    const canvas = node.querySelector('canvas')!
    await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
  }
  return { api, key, input, send: async (event: CaptureSurfaceEvent) => { await act(async () => listener?.(event)) }, allowLoad: () => node.removeEventListener('load', stopAutomaticLoad, true) }
}

it('a continued selection claims the capture only when the person outputs it, then delivers that selection', async () => {
  const { api, key } = await mount(true)
  expect(node.querySelector('.image-annotation-editor__capture-bar'), 'the overlay opens on the continued selection at rest').not.toBeNull()
  expect([api.select.mock.calls.length, api.finish.mock.calls.length], 'opening claims and delivers nothing').toEqual([0, 0])
  await key('s', { metaKey: true })
  expect(api.select, 'Save PNG claims the selection before its output').toHaveBeenCalledExactlyOnceWith('original-request')
  expect(api.select.mock.invocationCallOrder[0]!).toBeLessThan(api.savePng.mock.invocationCallOrder[0]!)
  await key('Enter')
  expect(api.finish, 'Enter delivers exactly the continued selection').toHaveBeenCalledExactlyOnceWith('original-request', 'included', image, remembered)
  expect(api.select, 'Main never releases an owner, so the one answer serves every later output').toHaveBeenCalledOnce()
})

it('an empty selection produces no claim, composition, delivery, file or pin from any output path', async () => {
  const { api, key } = await mount(true, 'included', true, undefined, false, null)
  for (const [keyName, init] of [['Enter', {}], ['c', { metaKey: true }], ['s', { metaKey: true }], ['p', { metaKey: true }]] as const) await key(keyName, init)
  const edit = { image, shapes: [], crop: null, displayWidth: image.width, displayHeight: image.height }
  await act(async () => {
    // The shared editor already refuses these keys without a crop. The host must also refuse an unexpected no-crop callback.
    await editorHarness.props.onComplete(edit)
    await editorHarness.props.onSavePng(edit)
    await editorHarness.props.onPin(edit)
  })
  for (const label of ['Done', 'Save PNG', 'Pin image']) {
    const button = [...node.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === label)
    if (button) await act(async () => button.click())
  }
  expect(api.select, 'no output may manufacture a selection owner').not.toHaveBeenCalled()
  expect(compose, 'no output may compose the full display as a fallback').not.toHaveBeenCalled()
  expect(api.finish).not.toHaveBeenCalled()
  expect(api.savePng).not.toHaveBeenCalled()
  expect(api.pin).not.toHaveBeenCalled()
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
  expect(api.savePng).toHaveBeenCalledExactlyOnceWith('original-request', background, image, remembered)
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
  expect(api.presented).toHaveBeenCalledExactlyOnceWith('original-request', 'included', { loadMs: expect.any(Number), decodeMs: expect.any(Number), paintMs: expect.any(Number), presentedMs: expect.any(Number) })
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
  expect(api.switchBackground).toHaveBeenCalledExactlyOnceWith('original-request', 'included')
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


it('plain Tab predecodes one explicit target, ignores rapid repeats and follows the Main-announced background', async () => {
  const { api, key, send, input } = await mount(true)
  let release!: () => void
  const decode = vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
  await act(async () => {
    const canvas = node.querySelector('canvas')!
    for (let index = 0; index < 2; index++) canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  })
  expect(decode, 'rapid Tab cannot start duplicate target decodes').toHaveBeenCalledOnce()
  expect(api.switchBackground, 'the current healthy frame remains until the target is decoded').not.toHaveBeenCalled()
  expect(node.querySelector('img')!.getAttribute('src')).toBe(input.backgrounds.included.image!.dataUrl)
  await act(async () => release())
  expect(api.switchBackground).toHaveBeenCalledExactlyOnceWith('original-request', 'excluded')
  decode.mockResolvedValue()
  await send({ kind: 'background', background: 'excluded' })
  await key('Tab')
  expect(api.switchBackground).toHaveBeenLastCalledWith('original-request', 'included')
})

it('modified Tab and text-editing Tab keep their original focus navigation', async () => {
  const { api, key } = await mount(true)
  for (const modifiers of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) await key('Tab', modifiers)
  for (const html of ['<input />', '<textarea></textarea>', '<div contenteditable="true"><span>editing</span></div>']) {
    const box = document.createElement('div'); box.innerHTML = html; node.append(box)
    const target = box.querySelector('span') ?? box.firstElementChild!
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => target.dispatchEvent(tab))
    expect(tab.defaultPrevented, 'editing Tab is not owned by the screenshot host').toBe(false)
    box.remove()
  }
  expect(api.switchBackground).not.toHaveBeenCalled()
})

it('a missing target and a locked peer keep their current frame when Tab is pressed', async () => {
  const { api, key, input, send } = await mount(true)
  await send({ kind: 'snapshot', requestId: 'original-request', revision: 2, background: 'excluded',
    frame: { status: 'failed', capturedAt: 2, issue: 'The hidden background is unavailable.' } })
  await key('Tab')
  expect(api.switchBackground, 'an unavailable target is never recaptured or substituted').not.toHaveBeenCalled()
  expect(node.querySelector('img')!.getAttribute('src')).toBe(input.backgrounds.included.image!.dataUrl)
  expect(node.textContent).toContain('The hidden background is unavailable.')
  await send({ kind: 'snapshot', requestId: 'original-request', revision: 3, background: 'excluded',
    frame: { status: 'ready', image: excludedImage, windows: [], capturedAt: 2, engine: 'excluded-engine' } })
  await send({ kind: 'locked' })
  await key('Tab')
  expect(api.switchBackground, 'a peer cannot change the owning display background').not.toHaveBeenCalled()
})

it('a target decode failure keeps the current pixels, selection and available Cancel', async () => {
  const { api, key, input } = await mount(true)
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockRejectedValue(new Error('Target PNG decode failed'))
  await key('Tab')
  expect(api.switchBackground).not.toHaveBeenCalled()
  expect(node.querySelector('img')!.getAttribute('src')).toBe(input.backgrounds.included.image!.dataUrl)
  expect(node.textContent).toContain('Target PNG decode failed')
  await key('Enter')
  expect(api.finish).toHaveBeenCalledWith('original-request', 'included', image, remembered)
  await key('Escape')
  expect(api.cancel).toHaveBeenCalledExactlyOnceWith('original-request')
})


it('Tab cannot change the frame while the original PNG output is being composed', async () => {
  const { api, key } = await mount(true)
  let release!: (image: BrowserPng) => void
  compose.mockImplementationOnce(() => new Promise<BrowserPng>(resolve => { release = resolve }))
  await key('Enter')
  expect(compose).toHaveBeenCalledOnce()
  await key('Tab')
  expect(api.switchBackground, 'the in-flight output retains its original frame').not.toHaveBeenCalled()
  await act(async () => release(image))
  expect(api.finish).toHaveBeenCalledExactlyOnceWith('original-request', 'included', image, remembered)
})


it('switching sources drops the old window highlight and sampled RGB without another pointer move', async () => {
  const { send } = await mount(true, 'included', true, undefined, false, null)
  await act(async () => node.querySelector('canvas')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 100, bubbles: true })))
  await paint()
  expect(node.querySelector('.image-annotation-editor__loupe')?.textContent).toContain('#FF0000')
  expect(windowOutline, 'the included window is lit under the stationary pointer').toHaveBeenCalled()
  windowOutline.mockClear()
  await send({ kind: 'background', background: 'excluded' })
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  await paint()
  expect(node.querySelector('.image-annotation-editor__loupe'), 'old source RGB is not presented as a new source sample').toBeNull()
  expect(windowOutline, 'the old window geometry is not painted over the new frozen source').not.toHaveBeenCalled()
})


it('a switch reply does not unlock old-frame output while the announced background still decodes', async () => {
  const { api, key, send, input } = await mount(true)
  let reply!: () => void, decoded!: () => void
  api.switchBackground.mockImplementationOnce(() => new Promise<void>(resolve => { reply = resolve }))
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValueOnce().mockImplementationOnce(() => new Promise<void>(resolve => { decoded = resolve }))
  await key('Tab')
  expect(api.switchBackground).toHaveBeenCalledExactlyOnceWith('original-request', 'excluded')
  await send({ kind: 'background', background: 'excluded' })
  await act(async () => reply())
  expect(node.querySelector('img')!.getAttribute('src'), 'the healthy old frame remains visible until the announced frame decodes').toBe(input.backgrounds.included.image!.dataUrl)
  await key('Enter')
  expect(api.finish, 'the Main reply cannot release outputs before its announced frame is ready').not.toHaveBeenCalled()
  await act(async () => decoded())
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  await paint()
  await key('Enter')
  expect(api.finish).toHaveBeenCalledExactlyOnceWith('original-request', 'excluded', image, remembered)
})

it('a deferred ready snapshot preserves the current editor and selection until an explicit switch', async () => {
  const { api, key, send, input } = await mount(true, 'included', true, undefined, false, remembered, true)
  const canvas = node.querySelector('canvas')!
  await key('ArrowRight')
  await send({ kind: 'snapshot', requestId: 'original-request', revision: 2, background: 'excluded',
    frame: { status: 'ready', image: excludedImage, windows: [], capturedAt: 2, engine: 'excluded-engine' } })
  expect(node.querySelector('img')!.getAttribute('src'), 'ready never auto-switches the visible source').toBe(input.backgrounds.included.image!.dataUrl)
  expect(node.querySelector('canvas'), 'a snapshot cannot rebuild or clear the current editor').toBe(canvas)
  await key('Tab')
  expect(api.switchBackground, 'the explicit gesture consumes the newly ready snapshot without another capture').toHaveBeenCalledExactlyOnceWith('original-request', 'excluded')
  await send({ kind: 'background', background: 'excluded' })
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  await paint()
  await key('Enter')
  expect(api.finish).toHaveBeenLastCalledWith('original-request', 'excluded', image, { ...remembered, x: remembered.x + input.scale })
})

it('a pending background announcement cannot replace the current document or produce pending output', async () => {
  const { api, key, send, input } = await mount(true, 'included', true, undefined, false, remembered, true)
  await send({ kind: 'background', background: 'excluded' })
  expect(node.querySelector('img')?.getAttribute('src'), 'pending is not a switch receipt').toBe(input.backgrounds.included.image!.dataUrl)
  expect(node.textContent).toContain('still preparing')
  await key('Enter')
  expect(api.finish, 'the current ready document remains usable').toHaveBeenCalledExactlyOnceWith('original-request', 'included', image, remembered)
})

it('a failed deferred snapshot keeps the current document and explains an explicit switch attempt', async () => {
  const { api, key, send, input } = await mount(true, 'included', true, undefined, false, remembered, true)
  const canvas = node.querySelector('canvas')!
  await send({ kind: 'snapshot', requestId: 'original-request', revision: 2, background: 'excluded',
    frame: { status: 'failed', capturedAt: 0, issue: 'alternate exposure failed' } })
  expect(node.querySelector('img')!.getAttribute('src')).toBe(input.backgrounds.included.image!.dataUrl)
  expect(node.querySelector('canvas')).toBe(canvas)
  await key('Tab')
  expect(api.switchBackground).not.toHaveBeenCalled()
  expect(node.textContent).toContain('alternate exposure failed')
  await key('Enter')
  expect(api.finish).toHaveBeenCalledExactlyOnceWith('original-request', 'included', image, remembered)
})
