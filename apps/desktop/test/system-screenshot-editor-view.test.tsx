// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { SystemScreenshotEditorView } from '../src/renderer/screenshot-editor/SystemScreenshotEditorView'
import type { BrowserPng } from '../src/shared/contracts'
import type { SystemScreenshotEditorApi, SystemScreenshotEditorInput } from '../src/shared/system-screenshot-editor'

// The window host and the shared editor are production code; only raster drawing is replaced.
vi.mock('@agentmux/client-ui/image-annotation', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/client-ui/image-annotation')>(), renderCommittedLayer() {}, renderScreenshotScene() {} }))
const image: BrowserPng = { mimeType: 'image/png', width: 1, height: 1, byteLength: 68,
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, toJSON() {} }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function retakeButton() { return [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === 'Retake') }
function retake() { const control = retakeButton(); expect(control, 'actual region capture offers Retake').toBeDefined(); return control! }
async function mount(retakable: boolean, retake: SystemScreenshotEditorApi['retake'], marks?: Pick<SystemScreenshotEditorInput, 'initialState' | 'initialTool'>) {
  const api: SystemScreenshotEditorApi = { load: vi.fn(), onNotice: () => () => {}, finish: vi.fn(), cancel: vi.fn(async () => {}), retake: vi.fn(retake),
    savePng: vi.fn(), pin: vi.fn(), inspectPin: vi.fn(), copyContext: vi.fn(), openOriginal: vi.fn(), saveOriginal: vi.fn(), inspectOriginal: vi.fn(), inspectOriginalOperation: vi.fn() }
  const input: SystemScreenshotEditorInput = { requestId: 'original-request', image, attachToDraft: true, theme: { status: 'unavailable', message: 'Private fixture appearance' }, ...(retakable ? { retakable: true } : {}), ...marks } as SystemScreenshotEditorInput
  await act(async () => root.render(<SystemScreenshotEditorView key={Math.random()} input={input} api={api} />))
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  return api
}

it('the window host offers Retake only for a region capture and asks Main to retake this exact request', async () => {
  await mount(false, async () => ({ status: 'cancelled' }))
  expect(retakeButton(), 'a display or window capture has no Retake').toBeUndefined()
  const api = await mount(true, async () => ({ status: 'cancelled' }))
  await act(async () => retake().click())
  expect(api.retake, 'actual Retake asks Main for this request').toHaveBeenCalledExactlyOnceWith('original-request')
  expect([api.cancel, api.finish].map(call => vi.mocked(call).mock.calls.length), 'a retake neither cancels nor delivers this editor').toEqual([0, 0])
  expect(retake().disabled, 'a cancelled retake leaves Retake available again').toBe(false)
})

it('a failed retake keeps the editor and says why', async () => {
  await mount(true, async () => ({ status: 'failed', message: 'A screen capture is already in progress.' }))
  await act(async () => retake().click())
  expect(node.querySelector('[role="alert"]')?.textContent, 'the reason shows in place').toContain('A screen capture is already in progress.')
  expect(retake().disabled).toBe(false)
})

it('marks moved here with Command E are unkept, so Retake confirms before it drops them', async () => {
  const marks = { initialState: { shapes: [{ id: 'mark', kind: 'rect' as const, color: '#ef4444', width: 4, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }], crop: null },
    initialTool: 'rect' as const }
  const api = await mount(true, async () => ({ status: 'cancelled' }), marks)
  await act(async () => retake().click())
  expect(api.retake, 'Retake waits for the in-place confirmation while handed-over marks exist nowhere else').not.toHaveBeenCalled()
  expect(node.textContent, 'the confirmation names the marks it would drop').toMatch(/Discard 1 annotation/)
})

it('a Command E handoff with no marks has nothing to lose, so Cancel closes at once', async () => {
  // A real Command E handoff always carries the capture selection as its crop.
  const api = await mount(true, async () => ({ status: 'cancelled' }), { initialState: { shapes: [], crop: { x: 0, y: 0, width: 1, height: 1 } }, initialTool: 'select' })
  const cancel = [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Cancel')
  expect(cancel, 'the window editor offers Cancel').toBeDefined()
  await act(async () => cancel!.click())
  expect(api.cancel, 'Cancel closes without a confirmation when no marks were handed over').toHaveBeenCalledOnce()
})
