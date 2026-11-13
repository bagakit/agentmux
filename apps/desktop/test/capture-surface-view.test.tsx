// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { CaptureSurfaceView } from '../src/renderer/screenshot-editor/CaptureSurfaceView'
import type { CaptureSurfaceApi, CaptureSurfaceInput } from '../src/shared/capture-surface'
import type { BrowserPng } from '../src/shared/contracts'

const compose = vi.hoisted(() => vi.fn())
// The overlay host and the shared editor are production code; raster drawing and pixel composition are replaced.
vi.mock('../src/renderer/src/components/image-annotation/canvas-render', () => ({ renderCommittedLayer() {}, renderScreenshotScene() {} }))
vi.mock('../src/renderer/src/components/image-annotation/compose', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/components/image-annotation/compose')>(), composeScreenshot: compose
}))
const image: BrowserPng = { mimeType: 'image/png', width: 1600, height: 1000, byteLength: 68,
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
const remembered = { x: 600, y: 200, width: 400, height: 200 }
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, toJSON() {} }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  compose.mockResolvedValue(image)
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function mount(owned: boolean) {
  const api = { load: vi.fn(), presented: vi.fn(async () => {}), select: vi.fn(async () => owned), onEvent: () => () => {},
    finish: vi.fn(async () => ({ status: 'completed' as const })), pin: vi.fn(), savePng: vi.fn(async () => ({ status: 'cancelled' as const })), copyText: vi.fn(),
    expand: vi.fn(async () => {}), cancel: vi.fn(async () => {}) } satisfies CaptureSurfaceApi
  const input: CaptureSurfaceInput = { requestId: 'original-request', displayId: 1, frame: { x: 0, y: 0, width: 800, height: 500 }, scale: 2, safeTop: 0,
    attachToDraft: false, expandable: true, theme: { status: 'unavailable', message: 'Private fixture appearance' }, image, initialCrop: remembered }
  await act(async () => root.render(<CaptureSurfaceView key={Math.random()} input={input} api={api} />))
  await act(async () => { await Promise.resolve() })
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  const key = async (key: string, init: KeyboardEventInit = {}) => {
    const canvas = node.querySelector('canvas')!
    await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
  }
  return { api, key }
}

it('a remembered selection claims the capture only when the person outputs it, then delivers that selection', async () => {
  const { api, key } = await mount(true)
  expect(node.querySelector('.image-annotation-editor__capture-bar'), 'the overlay opens on the remembered selection at rest').not.toBeNull()
  expect([api.select.mock.calls.length, api.finish.mock.calls.length], 'opening claims and delivers nothing').toEqual([0, 0])
  await key('s', { metaKey: true })
  expect(api.select, 'Save PNG claims the selection before its output').toHaveBeenCalledExactlyOnceWith('original-request')
  expect(api.select.mock.invocationCallOrder[0]!).toBeLessThan(api.savePng.mock.invocationCallOrder[0]!)
  await key('Enter')
  expect(api.finish, 'Enter delivers exactly the remembered selection').toHaveBeenCalledExactlyOnceWith('original-request', image, remembered)
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
