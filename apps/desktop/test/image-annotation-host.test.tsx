// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import type { AppConfig, BrowserPng, BrowserScreenshotCapture } from '../src/shared/contracts'
import { createEditableAnnotationDocument, encodeEditableAnnotationDocument, type AnnotationHistoricalSource } from '../src/renderer/src/components/image-annotation/document'
import { ANNOTATION_DOCUMENT_LIMITS } from '../src/renderer/src/components/browser-screenshot/document-files'

const fixture = vi.hoisted(() => ({ state: { applyBrowserEvent: vi.fn(), executeControl: vi.fn(async () => ({ operation: 'browser.history', operations: [] })),
  reportError: vi.fn(), setConfig: vi.fn(), saveBrowserBookmark: vi.fn(), openFile: vi.fn(), addBrowserAnnotation: vi.fn(),
  browserAnnotationsByBrowserId: {}, noticeReadReceipts: {}, toolsOpen: false, config: null as AppConfig | null },
compose: vi.fn(), committed: vi.fn(), scene: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign((selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  { getState: () => fixture.state, setState: vi.fn(), subscribe: () => () => {} }) }))
vi.mock('../src/renderer/src/components/image-annotation/canvas-render', () => ({ renderCommittedLayer: fixture.committed, renderScreenshotScene: fixture.scene }))
vi.mock('../src/renderer/src/components/browser-screenshot/compose', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/components/browser-screenshot/compose')>(), composeScreenshot: fixture.compose
}))
vi.mock('../src/renderer/src/lib/browser-stage-geometry', () => ({ observeBrowserStageGeometry(_stage: HTMLElement, update: () => void, active: boolean) { if (active) update(); return () => {} } }))
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'

const page = { id: 'annotation-browser', browserId: 'annotation-browser', navigationId: 'annotation-navigation', regionId: 'annotation-region',
  workspaceId: 'annotation-workspace', profileId: 'annotation-profile', kind: 'browser' as const, url: 'https://example.invalid/current', title: 'Current page',
  loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null }
const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const image: BrowserPng = { mimeType: 'image/png', dataUrl, width: 1, height: 1, byteLength: 68 }
const annotationImage = { dataUrl, width: 1, height: 1 }
const capture: BrowserScreenshotCapture = { browserId: page.browserId, navigationId: page.navigationId, image,
  source: { url: page.url, title: page.title, viewport: { width: 400, height: 300, deviceScaleFactor: 1 }, viewportWarning: null } }
const historical: AnnotationHistoricalSource = { url: 'https://example.invalid/saved', title: 'Historical original', viewport: null, viewportWarning: 'Historical observation unavailable' }
function saved(source: AnnotationHistoricalSource = historical) {
  return createEditableAnnotationDocument({ image: annotationImage, shapes: [{ id: 'saved-note', kind: 'note', color: '#ef4444', width: .01, radius: .03, number: 7,
    note: 'Saved historical note', template: 'request', from: { x: .1, y: .1 }, to: { x: .5, y: .5 } }], crop: null, source }, ANNOTATION_DOCUMENT_LIMITS)
}
function readResult(source: AnnotationHistoricalSource = historical) { return { status: 'read' as const,
  document: { path: 'chosen original.json', revision: 'opened-revision', content: encodeEditableAnnotationDocument(saved(source), ANNOTATION_DOCUMENT_LIMITS) } } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
class Decoder {
  static pending: Decoder[] = []
  naturalWidth = 1; naturalHeight = 1
  onload: (() => void) | null = null; onerror: (() => void) | null = null
  set src(_value: string) { Decoder.pending.push(this) }
}
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement, frames: Map<number, FrameRequestCallback>, nextFrame: number
let read: ReturnType<typeof vi.spyOn<typeof api.files, 'read'>>, write: ReturnType<typeof vi.spyOn<typeof api.files, 'write'>>
let captured: ReturnType<typeof vi.spyOn<typeof api.browser, 'captureScreenshot'>>, clipboard: ReturnType<typeof vi.spyOn<typeof api.ui, 'writeClipboardText'>>
let bounds: ReturnType<typeof vi.spyOn<typeof api.browser, 'setBounds'>>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); vi.stubGlobal('Image', Decoder); Decoder.pending = []
  frames = new Map(); nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, toJSON() {} }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  fixture.state.config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local fixture' }], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  vi.clearAllMocks()
  bounds = vi.spyOn(api.browser, 'setBounds').mockResolvedValue(undefined)
  captured = vi.spyOn(api.browser, 'captureScreenshot').mockResolvedValue(capture)
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined); vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
  read = vi.spyOn(api.files, 'read').mockResolvedValue(readResult()); write = vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'saved-revision' })
  clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'writeClipboardImage').mockResolvedValue(undefined)
  fixture.compose.mockResolvedValue(image)
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function frame() { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)) }) }
function editor(): HTMLElement { const value = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]'); expect(value).not.toBeNull(); return value! }
function dialog(): HTMLElement { const value = document.querySelector<HTMLElement>('.confirmation-dialog[role="dialog"]'); expect(value).not.toBeNull(); return value! }
function button(scope: ParentNode, name: string): HTMLButtonElement { const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === name || button.textContent?.trim() === name)
  expect(value, name).toBeDefined(); return value! }
async function click(scope: ParentNode, name: string) {
  if ((name === 'Open original' || name === 'Save original') && scope === node.querySelector('[aria-label="Screenshot editor"]')) {
    await act(async () => { const trigger = button(scope, 'Original file actions'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === name + '…')
    expect(item, 'actual original file menu item').toBeDefined()
    await act(async () => item!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  } else await act(async () => button(scope, name).click())
  await frame()
}
async function mount(snapshot = page, visible = true) { await act(async () => root.render(<BrowserPane tab={snapshot} visible={visible} />)); await frame() }
async function beginCapture() { await click(node, 'Screenshot'); const opened = editor(); await act(async () => opened.querySelector('img')!.dispatchEvent(new Event('load'))); await frame(); return opened }
async function enterMoreOpen() {
  await act(async () => { const trigger = button(node, 'More browser tools'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  const item = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Open annotation original"]')
  expect(item).not.toBeNull(); await act(async () => item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await frame()
  return dialog()
}
async function submit(path = 'chosen original.json') {
  const input = dialog().querySelector('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, path); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
async function decode() { expect(Decoder.pending).toHaveLength(1); await act(async () => Decoder.pending[0]!.onload!()); await frame()
  const opened = editor(); await act(async () => opened.querySelector('img')!.dispatchEvent(new Event('load'))); await frame(); return opened }
async function copyContext() { await click(editor(), 'Copy context'); expect(clipboard).toHaveBeenCalled(); const text = clipboard.mock.lastCall![0]
  return JSON.parse(text.slice(text.indexOf('{'))) }

describe('Browser annotation host save and reopen consumers', () => {
  it.each([historical, null])('opens an original from More without capturing the current page and copies its own historical source (%j)', async source => {
    read.mockResolvedValue(readResult(source)); await mount(); await enterMoreOpen()
    expect(captured).not.toHaveBeenCalled(); expect(node.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
    await submit(); expect(read).toHaveBeenCalledExactlyOnceWith(page.workspaceId, 'chosen original.json')
    expect(node.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
    const opened = await decode(), context = await copyContext()
    expect(context).toMatchObject({ browserId: null, navigationId: null, sourceKind: 'saved-document', source,
      annotations: [expect.objectContaining({ id: 'saved-note', note: 'Saved historical note', template: 'request' })] })
    expect(captured).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, null)
    await click(opened, 'Cancel'); expect(node.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, { x: 0, y: 0, width: 400, height: 300 })
  })

  it('saves the exact captured document once, then uses only the revision explicitly reopened for the same path', async () => {
    await mount(); const capturedEditor = await beginCapture()
    await click(capturedEditor, 'Save original'); await submit(' captured original.json ')
    expect(write).toHaveBeenCalledExactlyOnceWith(page.workspaceId, { path: ' captured original.json ', expectedRevision: null,
      content: encodeEditableAnnotationDocument(createEditableAnnotationDocument({ image: annotationImage, shapes: [], crop: null, source: capture.source }, ANNOTATION_DOCUMENT_LIMITS), ANNOTATION_DOCUMENT_LIMITS) })
    expect(read).not.toHaveBeenCalled(); expect(editor()).toBe(capturedEditor)
    await click(capturedEditor, 'Open original'); await submit(); const reopened = await decode()
    expect(reopened).not.toBe(capturedEditor)
    await click(reopened, 'Save original'); await submit()
    expect(write.mock.lastCall).toEqual([page.workspaceId, { path: 'chosen original.json', expectedRevision: 'opened-revision',
      content: encodeEditableAnnotationDocument(saved(), ANNOTATION_DOCUMENT_LIMITS) }])
    expect(write).toHaveBeenCalledTimes(2); expect(captured).toHaveBeenCalledTimes(1)
  })

  it('keeps a cancelled late file read and late image decode from replacing a later editor', async () => {
    await mount(); const originalEditor = await beginCapture()
    const pending = deferred<Awaited<ReturnType<typeof api.files.read>>>()
    read.mockReturnValueOnce(pending.promise)
    await click(originalEditor, 'Open original'); await submit(); await click(dialog(), 'Cancel')
    await act(async () => pending.resolve(readResult()))
    expect(Decoder.pending).toHaveLength(0); expect(editor()).toBe(originalEditor)
    await click(originalEditor, 'Open original'); await submit()
    expect(Decoder.pending).toHaveLength(1)
    await click(dialog(), 'Cancel')
    await act(async () => Decoder.pending[0]!.onload!()); await frame()
    expect(editor(), 'cancelled decode must retain the current document').toBe(originalEditor)
    expect(fixture.committed.mock.lastCall![1]).toEqual([])
    await click(originalEditor, 'Cancel')
    const next = await beginCapture()
    await act(async () => Decoder.pending[0]!.onload!()); await frame()
    expect(editor()).toBe(next); expect(write).not.toHaveBeenCalled(); expect(clipboard).not.toHaveBeenCalled()
    expect(fixture.state.reportError).not.toHaveBeenCalled()
  })

  it.each(['written', 'unknown'] as const)('keeps a submitted %s write after Cancel for verification without retrying or closing a later dialog', async status => {
    const pending = deferred<Awaited<ReturnType<typeof api.files.write>>>()
    write.mockReturnValueOnce(pending.promise)
    await mount(); const opened = await beginCapture()
    await click(opened, 'Save original'); await submit(); expect(write).toHaveBeenCalledOnce()
    await click(dialog(), 'Cancel'); expect(editor()).toBe(opened)
    await click(opened, 'Save original'); const later = dialog()
    await act(async () => pending.resolve(status === 'written' ? { status, revision: 'late-written-revision' } : { status, code: 'REPLY_LOST', message: 'Unknown write' }))
    expect(dialog()).toBe(later); expect(write).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled()
    expect(opened.querySelector('[role="status"]')!.textContent).toBe(status === 'written'
      ? 'Earlier save confirmed · Check file before saving again' : 'Earlier save unconfirmed · Check file before saving again')
    await submit(); expect(write).toHaveBeenCalledOnce(); expect(button(dialog(), 'Save original').disabled).toBe(true)
    const content = write.mock.calls[0]![1].content
    read.mockResolvedValueOnce({ status: 'read', document: { path: 'chosen original.json', content, revision: 'late-verified-revision' } })
    await click(dialog(), 'Check file')
    expect(write).toHaveBeenCalledOnce(); expect(button(dialog(), 'Save original').disabled).toBe(false)
  })

  it('does not let an earlier cancelled save receipt overwrite the status or document opened later', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.files.write>>>()
    write.mockReturnValueOnce(pending.promise)
    await mount(); const capturedEditor = await beginCapture()
    await click(capturedEditor, 'Save original'); await submit(); await click(dialog(), 'Cancel')
    await click(capturedEditor, 'Open original'); await submit(); const reopened = await decode()
    const before = reopened.querySelector('[role="status"]')!.textContent
    await act(async () => pending.resolve({ status: 'written', revision: 'earlier-save-revision' }))
    expect(editor()).toBe(reopened); expect(reopened.querySelector('[role="status"]')!.textContent).toBe(before)
    expect((await copyContext()).source).toEqual(historical)
    expect(write).toHaveBeenCalledOnce()
  })

  it('keeps an unknown save read-only until exact on-disk verification, then uses that confirmed revision', async () => {
    write.mockResolvedValueOnce({ status: 'unknown', code: 'REPLY_LOST', message: 'Write acknowledgement unknown' })
    await mount(); const opened = await beginCapture()
    await click(opened, 'Save original'); await submit()
    expect(write).toHaveBeenCalledOnce(); expect(button(dialog(), 'Save original').disabled).toBe(true)
    const content = write.mock.calls[0]![1].content
    read.mockResolvedValueOnce({ status: 'read', document: { path: 'chosen original.json', content, revision: 'verified-revision' } })
    await click(dialog(), 'Check file')
    expect(read).toHaveBeenCalledExactlyOnceWith(page.workspaceId, 'chosen original.json')
    expect(write).toHaveBeenCalledOnce(); expect(button(dialog(), 'Save original').disabled).toBe(false)
    expect(editor()).toBe(opened)
    expect(opened.querySelector('[role="status"]')!.textContent).toBe('Original verified on disk')
    await submit(); expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.lastCall![1]).toMatchObject({ path: 'chosen original.json', expectedRevision: 'verified-revision', content })
  })

  it('keeps a conflict and differing check from overwriting the original while allowing an explicit new path', async () => {
    write.mockResolvedValueOnce({ status: 'conflict', observedRevision: 'other-revision' })
    await mount(); const opened = await beginCapture(); await click(opened, 'Save original'); await submit()
    await click(dialog(), 'Check file')
    expect(button(dialog(), 'Save original').disabled).toBe(true); expect(write).toHaveBeenCalledOnce()
    await submit(); expect(write).toHaveBeenCalledOnce(); expect(editor()).toBe(opened)
    await submit('new original.json'); expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.lastCall![1]).toMatchObject({ path: 'new original.json', expectedRevision: null })
  })

  it.each(['existing-revision', 'new-file-deleted'] as const)('allows an explicit retry after an unknown save checks %s while preserving the current edits', async scenario => {
    await mount(); let opened: HTMLElement
    if (scenario === 'existing-revision') {
      await enterMoreOpen(); await submit(); opened = await decode()
      await click(opened, 'Note 7')
      const field = opened.querySelector<HTMLTextAreaElement>('[aria-label="Note text"]')!
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Newer unconfirmed note')
        field.dispatchEvent(new Event('input', { bubbles: true })) })
    } else opened = await beginCapture()
    write.mockResolvedValueOnce({ status: 'unknown', code: 'REPLY_LOST', message: 'Write acknowledgement unknown' })
    await click(opened, 'Save original'); await submit()
    read.mockClear()
    read.mockResolvedValueOnce(scenario === 'existing-revision' ? readResult() : { status: 'deleted' })
    await click(dialog(), 'Check file')
    expect(read).toHaveBeenCalledExactlyOnceWith(page.workspaceId, 'chosen original.json')
    expect(write).toHaveBeenCalledOnce(); expect(editor()).toBe(opened)
    expect(button(dialog(), 'Save original').disabled).toBe(false)
    await submit(); expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.lastCall![1].expectedRevision).toBe(scenario === 'existing-revision' ? 'opened-revision' : null)
  })

  it('verifies an unknown save with the intended bytes even when its revision also equals the original revision', async () => {
    await mount(); await enterMoreOpen(); await submit(); const opened = await decode()
    write.mockResolvedValueOnce({ status: 'unknown', code: 'REPLY_LOST', message: 'Write acknowledgement unknown' })
    await click(opened, 'Save original'); await submit()
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]![1].content).toBe(readResult().document.content)
    read.mockResolvedValueOnce(readResult())
    await click(dialog(), 'Check file')
    expect(opened.querySelector('[role="status"]')!.textContent).toBe('Original verified on disk')
    expect(editor()).toBe(opened); expect(write).toHaveBeenCalledOnce()
    expect(button(dialog(), 'Save original').disabled).toBe(false)
  })

  it('invalidates a pending full image decode when its Pane is hidden and preserves the original editor after showing it', async () => {
    await mount(); const opened = await beginCapture(); await click(opened, 'Open original'); await submit()
    expect(Decoder.pending).toHaveLength(1)
    await mount(page, false)
    await act(async () => Decoder.pending[0]!.onload!()); await frame()
    expect(editor()).toBe(opened); expect(editor().style.display).toBe('none')
    await mount(page, true)
    expect(editor()).toBe(opened)
    if (document.querySelector('.confirmation-dialog[role="dialog"]')) await click(dialog(), 'Cancel')
    expect((await copyContext()).source).toEqual(capture.source)
  })

  it('keeps a reopened file editor and its historical source across background Browser navigation', async () => {
    await mount(); const capturedEditor = await beginCapture(); await click(capturedEditor, 'Open original'); await submit()
    const opened = await decode()
    await mount({ ...page, navigationId: 'background-navigation', url: 'https://example.invalid/background', title: 'Background page' })
    expect(editor()).toBe(opened)
    expect(await copyContext()).toMatchObject({ browserId: null, navigationId: null, sourceKind: 'saved-document', source: historical,
      annotations: [expect.objectContaining({ id: 'saved-note', note: 'Saved historical note' })] })
    expect(captured).toHaveBeenCalledTimes(1)
  })

  it.each(['Copy PNG', 'Copy context'] as const)('completes pending %s from the same saved document across Browser navigation with one historical result', async action => {
    await mount(); await enterMoreOpen(); await submit(); const opened = await decode()
    const pending = deferred<BrowserPng>(); fixture.compose.mockReturnValueOnce(pending.promise)
    await click(opened, action)
    expect(fixture.compose).toHaveBeenCalledOnce(); expect(button(opened, 'Copying…').disabled).toBe(true)
    await mount({ ...page, navigationId: 'background-navigation', url: 'https://example.invalid/background', title: 'Background page' })
    expect(editor()).toBe(opened); expect(button(opened, 'Copying…').disabled).toBe(true)
    await act(async () => pending.resolve(image)); await frame()
    expect(fixture.compose).toHaveBeenCalledOnce(); expect(editor()).toBe(opened)
    if (action === 'Copy context') {
      expect(clipboard).toHaveBeenCalledTimes(1)
      const text = clipboard.mock.lastCall![0], context = JSON.parse(text.slice(text.indexOf('{')))
      expect(context).toMatchObject({ browserId: null, navigationId: null, sourceKind: 'saved-document', source: historical,
        annotations: [expect.objectContaining({ id: 'saved-note', note: 'Saved historical note' })] })
    } else { expect(api.ui.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(image); expect(clipboard).not.toHaveBeenCalled() }
    expect(captured).not.toHaveBeenCalled(); expect(button(opened, 'Copy PNG').disabled).toBe(false)
  })

  it('hands focus from More through Open and Cancel back to the actual Canvas so Escape exits', async () => {
    await mount(); const opened = await beginCapture(); await enterMoreOpen(); await click(dialog(), 'Cancel')
    // Radix returns focus after unmount; the host schedules the owning Canvas handoff.
    await act(async () => new Promise(resolve => setTimeout(resolve, 1))); await frame()
    const canvas = opened.querySelector('canvas')!
    expect(document.activeElement, 'actual More Open Cancel must restore Canvas focus').toBe(canvas)
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await frame()
    expect(node.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
  })

  it.each(['decode-error', 'dimension-mismatch'])('keeps the existing document when the opened image fails full validation (%s)', async failure => {
    await mount(); const opened = await beginCapture(); await click(opened, 'Open original'); await submit()
    expect(Decoder.pending).toHaveLength(1)
    await act(async () => { const decoder = Decoder.pending[0]!
      if (failure === 'decode-error') decoder.onerror!()
      else { decoder.naturalWidth = 2; decoder.onload!() } })
    expect(dialog().querySelector('[role="alert"]')).not.toBeNull(); expect(editor()).toBe(opened)
    expect(write).not.toHaveBeenCalled(); expect(captured).toHaveBeenCalledTimes(1)
    await click(dialog(), 'Cancel'); expect((await copyContext()).source).toEqual(capture.source)
  })
})
