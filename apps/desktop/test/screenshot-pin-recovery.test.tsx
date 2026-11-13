// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useScreenshotPin } from '../src/renderer/src/lib/use-screenshot-pin'
import { SystemScreenshotEditorView } from '../src/renderer/screenshot-editor/SystemScreenshotEditorView'
import type { BrowserPng } from '../src/shared/contracts'
import type { SystemScreenshotEditorApi } from '../src/shared/system-screenshot-editor'
import type { ImageResult } from '@agentmux/core'
import { createEditableAnnotationDocument, encodeEditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'
import { ANNOTATION_DOCUMENT_LIMITS } from '../src/renderer/src/components/browser-screenshot/document-files'

const compose = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/components/image-annotation/canvas-render', () => ({ renderCommittedLayer() {}, renderScreenshotScene() {} }))
vi.mock('../src/renderer/src/components/image-annotation/compose', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/components/image-annotation/compose')>(), composeScreenshot: compose
}))
const image: BrowserPng = { mimeType: 'image/png', width: 1, height: 1, byteLength: 68,
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
function result(operationId: string, state: 'pending' | 'completed' | 'failed' | 'unknown' = 'completed'): ImageResult {
  return { hostId: 'local', pinId: 'original-pin', state: state === 'completed' ? 'open' : 'unknown', creationOperationId: operationId,
    recordedOperation: { operationId, method: 'image.pin', actor: { kind: 'user', id: 'original-person' }, pinId: 'original-pin', state,
      effect: state === 'completed' ? 'opened' : null, message: state === 'failed' ? 'Original creation failed' : null } }
}
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement, current: ReturnType<typeof useScreenshotPin>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, toJSON() {} }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  compose.mockResolvedValue(image)
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount() {
  const ports = { pin: vi.fn<(input: { operationId: string; image: BrowserPng }) => Promise<ImageResult>>(), inspect: vi.fn<(operationId: string) => Promise<ImageResult>>() }
  function Probe() { current = useScreenshotPin(ports); return null }
  await act(async () => root.render(<Probe />))
  return ports
}
async function rejected(call: () => Promise<unknown>) { let cause: unknown; await act(async () => { try { await call() } catch (error) { cause = error } }); expect(cause).toBeInstanceOf(Error); return cause as Error }

it('retains the original pin after a lost response and checks it without another creation', async () => {
  const ports = await mount(); ports.pin.mockRejectedValue(new Error('Reader disconnected'))
  const error = await rejected(() => current.pin(image)), operationId = ports.pin.mock.lastCall![0].operationId
  expect(current.uncertain, 'a lost reader must preserve an inspectable original pin').toBe(true)
  expect(error.message).toContain(operationId)
  await rejected(() => current.pin(image)); expect(ports.pin).toHaveBeenCalledOnce()
  ports.inspect.mockResolvedValue(result(operationId))
  await act(async () => { expect((await current.checkPin())?.recordedOperation?.effect).toBe('opened') })
  expect(ports.inspect, 'inspection must read that exact original operation').toHaveBeenCalledExactlyOnceWith(operationId)
  expect(ports.pin).toHaveBeenCalledOnce(); expect(current.uncertain).toBe(false)
})

it.each(['missing', 'pending', 'unknown', 'another-operation'] as const)('keeps %s evidence unknown and never grants another pin', async state => {
  const ports = await mount(); ports.pin.mockRejectedValue(new Error('Reply lost'))
  await rejected(() => current.pin(image)); const id = ports.pin.mock.lastCall![0].operationId
  ports.inspect.mockResolvedValue(state === 'missing' ? { ...result(id), recordedOperation: null } : result(state === 'another-operation' ? 'other-original' : id, state === 'pending' || state === 'unknown' ? state : 'completed'))
  await rejected(() => current.checkPin())
  expect(current.uncertain, 'missing, pending, unknown or another operation cannot confirm the original effect').toBe(true)
  await rejected(() => current.pin(image)); expect(ports.pin).toHaveBeenCalledOnce()
  expect(ports.inspect).toHaveBeenCalledExactlyOnceWith(id)
})

it('an authoritative failed creation clears uncertainty without reporting successful opening', async () => {
  const ports = await mount(); ports.pin.mockRejectedValueOnce(new Error('Reply lost'))
  await rejected(() => current.pin(image)); const id = ports.pin.mock.lastCall![0].operationId
  ports.inspect.mockResolvedValue(result(id, 'failed'))
  await act(async () => { expect((await current.checkPin())?.recordedOperation).toMatchObject({ state: 'failed', effect: null }) })
  expect(current.uncertain).toBe(false)
  ports.pin.mockImplementation(async input => result(input.operationId))
  await act(async () => current.pin(image))
  expect(ports.pin).toHaveBeenCalledTimes(2)
  expect(ports.pin.mock.lastCall![0].operationId).not.toBe(id)
})

function button(name: string) { const found = [...node.querySelectorAll<HTMLButtonElement>('button')].find(value => value.getAttribute('aria-label') === name || value.textContent?.trim() === name); expect(found, name).toBeDefined(); return found! }
it('the actual System host exposes Check pin while retaining Copy and Cancel, then checks its exact bridge request', async () => {
  const api: SystemScreenshotEditorApi = { load: vi.fn(), finish: vi.fn(async () => ({ status: 'completed' })), cancel: vi.fn(async () => {}),
    savePng: vi.fn(), pin: vi.fn(async () => { throw new Error('Pin response lost') }), inspectPin: vi.fn(),
    copyContext: vi.fn(), openOriginal: vi.fn(), saveOriginal: vi.fn(), inspectOriginal: vi.fn(), inspectOriginalOperation: vi.fn() }
  await act(async () => root.render(<SystemScreenshotEditorView input={{ requestId: 'original-request', image, attachToDraft: false, theme: { status: 'unavailable', message: 'Private fixture appearance' } }} api={api} />))
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  await act(async () => button('Pin image').click())
  const id = vi.mocked(api.pin).mock.lastCall![1]
  expect(vi.mocked(api.pin).mock.lastCall).toEqual(['original-request', id, image])
  expect(button('Pin image').disabled, 'only another uncertain creation is held').toBe(true)
  expect(button('Copy').disabled, 'healthy independent Copy stays available').toBe(false)
  expect(button('Cancel').disabled, 'healthy cancellation stays available').toBe(false)
  expect(node.querySelector('[role="alert"]')!.textContent).toContain(id)
  vi.mocked(api.inspectPin).mockResolvedValue(result(id))
  await act(async () => button('Check pin').click())
  expect(api.inspectPin).toHaveBeenCalledExactlyOnceWith('original-request', id)
  expect(api.pin).toHaveBeenCalledOnce()
  expect(button('Pin image').disabled).toBe(false)
  expect([...node.querySelectorAll('button')].some(value => value.textContent?.trim() === 'Check pin')).toBe(false)
  expect(node.textContent).toContain('Original reference pinned')
  await act(async () => button('Copy').click())
  expect(api.finish).toHaveBeenCalledOnce()
  expect(node.querySelector('[aria-label="Screenshot editor"]')).not.toBeNull()
  await act(async () => button('Cancel').click())
  expect(api.cancel).toHaveBeenCalledExactlyOnceWith('original-request')
})

it('Escape dismisses the actual Original menu before a second Canvas Escape cancels the System request', async () => {
  const api: SystemScreenshotEditorApi = { load: vi.fn(), finish: vi.fn(), cancel: vi.fn(async () => {}), savePng: vi.fn(), pin: vi.fn(), inspectPin: vi.fn(),
    copyContext: vi.fn(), openOriginal: vi.fn(), saveOriginal: vi.fn(), inspectOriginal: vi.fn(), inspectOriginalOperation: vi.fn() }
  await act(async () => root.render(<SystemScreenshotEditorView input={{ requestId: 'original-request', image, attachToDraft: false,
    theme: { status: 'unavailable', message: 'Private fixture appearance' } }} api={api} />))
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  await act(async () => { const trigger = button('Original file actions'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu, 'the production Radix Original menu must actually open').not.toBeNull()
  await act(async () => { menu.focus(); menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })) })
  await act(async () => new Promise(done => setTimeout(done, 1)))
  expect(document.querySelector('[role="menu"]'), 'the first Escape dismisses only its menu').toBeNull()
  expect(api.cancel, 'menu dismissal must not cancel the healthy image request').not.toHaveBeenCalled()
  expect(node.querySelector('[aria-label="Screenshot editor"]')).not.toBeNull()
  await act(async () => { const canvas = node.querySelector('canvas')!; canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })) })
  expect(api.cancel).toHaveBeenCalledExactlyOnceWith('original-request')
})


it('an earlier Copy settles the original attachment without overwriting a newly opened document status', async () => {
  function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
  const reading = deferred<Awaited<ReturnType<SystemScreenshotEditorApi['openOriginal']>>>(), copying = deferred<Awaited<ReturnType<SystemScreenshotEditorApi['finish']>>>()
  class Decoder { naturalWidth = 1; naturalHeight = 1; onload: (() => void) | null = null; onerror: (() => void) | null = null
    set src(_value: string) { queueMicrotask(() => this.onload?.()) } }
  vi.stubGlobal('Image', Decoder)
  const api: SystemScreenshotEditorApi = { load: vi.fn(), finish: vi.fn(() => copying.promise), cancel: vi.fn(async () => {}), savePng: vi.fn(), pin: vi.fn(), inspectPin: vi.fn(),
    copyContext: vi.fn(), openOriginal: vi.fn(() => reading.promise), saveOriginal: vi.fn(), inspectOriginal: vi.fn(), inspectOriginalOperation: vi.fn() }
  await act(async () => root.render(<SystemScreenshotEditorView input={{ requestId: 'original-request', image, attachToDraft: true,
    theme: { status: 'unavailable', message: 'Private fixture appearance' } }} api={api} />))
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  await act(async () => { const trigger = button('Original file actions'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(value => value.textContent?.trim() === 'Open original…')
  expect(action, 'the actual Original menu starts the read').toBeDefined()
  await act(async () => action!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await act(async () => new Promise(done => setTimeout(done, 1)))
  expect(api.openOriginal).toHaveBeenCalledOnce()
  await act(async () => button('Copy & attach').click())
  expect(api.finish, 'the original Copy is submitted once while the read is still pending').toHaveBeenCalledOnce()
  expect(vi.mocked(api.finish).mock.lastCall).toEqual(['original-request', expect.any(String), image])
  const original = createEditableAnnotationDocument({ image: { dataUrl: image.dataUrl, width: image.width, height: image.height }, source: null, crop: null,
    shapes: [{ id: 'new-document-text', kind: 'text', color: '#123456', fontSize: .1, at: { x: .1, y: .1 }, text: 'Newly opened original' }] }, ANNOTATION_DOCUMENT_LIMITS)
  await act(async () => reading.resolve({ status: 'read', file: { grantId: 'new-original-grant', path: 'different-original.json', revision: 'new-original-revision' },
    content: encodeEditableAnnotationDocument(original, ANNOTATION_DOCUMENT_LIMITS) }))
  await act(async () => node.querySelector('img')!.dispatchEvent(new Event('load')))
  const status = node.querySelector('.image-annotation-editor__status')!
  expect(status.textContent).toBe('Opened original · different-original.json')
  expect(node.textContent).toContain('1 annotations')
  await act(async () => copying.resolve({ status: 'completed' }))
  expect(status.textContent, 'an earlier output receipt must not claim that the newly opened document was copied').toBe('Opened original · different-original.json')
  expect(button('Copy').disabled, 'the original attachment was delivered, leaving independent future copies available').toBe(false)
  expect(api.finish).toHaveBeenCalledOnce()
  expect(api.cancel).not.toHaveBeenCalled()
  await act(async () => button('Cancel').click())
  expect(api.cancel).toHaveBeenCalledExactlyOnceWith('original-request')
})
