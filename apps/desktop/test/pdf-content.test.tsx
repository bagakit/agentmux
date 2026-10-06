// @vitest-environment happy-dom
import { act, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => {
  let releaseEngine!: () => void, releaseViewer!: () => void
  const engineGate = new Promise<void>(resolve => { releaseEngine = resolve }), viewerGate = new Promise<void>(resolve => { releaseViewer = resolve })
  class EventBus {
    listeners = new Map<string, Set<(event: any) => void>>()
    on(type: string, listener: (event: any) => void) { const group = this.listeners.get(type) ?? new Set(); group.add(listener); this.listeners.set(type, group) }
    off(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener) }
    dispatch(type: string, event: any = {}) { this.listeners.get(type)?.forEach(listener => listener(event)) }
  }
  class Viewer {
    static instances: Viewer[] = []
    page = 1; scale = 1; scaleValue = ''; pdfDocument: any
    views = new Map<number, { renderingState: number }>()
    getPageView(index: number) { return this.views.get(index + 1) }
    setDocument = vi.fn((doc: any) => { this.pdfDocument = doc; this.options.findController?.setDocument(doc); if (doc) this.options.eventBus.dispatch('pagesinit') })
    update = vi.fn()
    constructor(public options: any) { Viewer.instances.push(this) }
    get currentPageNumber() { return this.page }
    set currentPageNumber(page: number) { this.page = page; this.options.eventBus.dispatch('pagechanging', { pageNumber: page }) }
    get currentScale() { return this.scale }
    set currentScale(scale: number) { this.scale = scale; this.options.eventBus.dispatch('scalechanging', { scale }) }
    set currentScaleValue(value: string) { this.scaleValue = value; this.currentScale = value === 'page-width' ? 0.8 : value === 'page-fit' ? 0.6 : Number(value) }
  }
  const tasks: Array<{ promise: Promise<any>; resolve: (value: any) => void; reject: (error: Error) => void; destroy: ReturnType<typeof vi.fn>; onPassword?: (unlock: (value: string) => void, reason: number) => void }> = []
  const getDocument = vi.fn((_options: Record<string, unknown>) => {
    let resolve!: (value: any) => void, reject!: (error: Error) => void
    const task = { promise: new Promise((yes, no) => { resolve = yes; reject = no }), resolve: (value: any) => resolve(value), reject: (error: Error) => reject(error), destroy: vi.fn(async () => {}) }
    tasks.push(task); return task
  })
  return { EventBus, Viewer, tasks, getDocument, holdColdImports: false, engineReady: false, viewerEvaluations: 0, engineGate, viewerGate, releaseEngine, releaseViewer }
})
// Only the third-party rendering engine is substituted; the reader and lifecycle below are production.
vi.mock('pdfjs-dist', async () => { if (boundary.holdColdImports) await boundary.engineGate; boundary.engineReady = true; return { getDocument: boundary.getDocument, GlobalWorkerOptions: {} } })
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', async () => {
  boundary.viewerEvaluations++
  // The real viewer destructures globalThis.pdfjsLib at its module top level.
  if (!boundary.engineReady) throw new Error('The PDF viewer consumed the engine before globalThis.pdfjsLib exists')
  if (boundary.holdColdImports) await boundary.viewerGate
  return { EventBus: boundary.EventBus, PDFViewer: boundary.Viewer, PDFFindController: class { setDocument = vi.fn() }, RenderingStates: { FINISHED: 3 }, PDFLinkService: class { setViewer = vi.fn(); setDocument = vi.fn(); goToDestination = vi.fn(async () => {}) } }
})
import { mountThemeRuntime, previewTheme, GRAPHITE_THEME } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { PdfContent } from '../src/renderer/src/components/PdfContent'

let root: Root, container: HTMLDivElement
const first = new Uint8Array([1, 2, 3]), second = new Uint8Array([4, 5, 6])
const observers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; resize: () => void }> = []
async function render(node: ReactNode) { await act(async () => { root.render(node); await vi.dynamicImportSettled() }); await act(async () => { await vi.dynamicImportSettled() }) }
async function event(type: string, value = {}) {
  const reader = boundary.Viewer.instances.at(-1)!, facts = { pageNumber: reader.page, ...value }
  if (type === 'pagerendered') reader.views.set(facts.pageNumber, { renderingState: 3 })
  await act(async () => reader.options.eventBus.dispatch(type, facts))
}
async function loaded(index = 0, pages = 3, outline: Promise<any[]> = Promise.resolve([])) { await act(async () => { boundary.tasks[index]!.resolve({ numPages: pages, getPage: async () => ({}), getOutline: () => outline }) }) }
// Test-only React telemetry checks the actual retained hook state, not a second lifecycle model.
function retainedSnapshot() {
  let hook = (root as any)._internalRoot.current.child.memoizedState
  while (hook) { if (hook.memoizedState?.owner instanceof Uint8Array) return hook.memoizedState.owner; hook = hook.next }
  return null
}
async function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  expect(button).toBeDefined(); await act(async () => button!.click())
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  boundary.tasks.length = 0; boundary.Viewer.instances.length = 0; boundary.getDocument.mockClear(); observers.length = 0
  vi.stubGlobal('ResizeObserver', class { instance: typeof observers[number]; constructor(resize: () => void) { this.instance = { observe: vi.fn(), disconnect: vi.fn(), resize }; observers.push(this.instance) }; observe() { this.instance.observe() }; disconnect() { this.instance.disconnect() } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('the actual File PDF reader', () => {
  it('waits for the cold engine before evaluating its viewer and fences both pending imports when hidden', async () => {
    boundary.holdColdImports = true
    const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    try {
      await act(async () => root.render(<PdfContent data={first} name="cold.pdf" />)); await tick()
      expect(boundary.engineReady).toBe(false); expect(boundary.viewerEvaluations).toBe(0)
      await act(async () => root.render(<PdfContent data={first} name="cold.pdf" visible={false} />))
      boundary.releaseEngine(); await act(async () => { await vi.dynamicImportSettled() })
      expect(boundary.viewerEvaluations).toBe(0); expect(boundary.getDocument).not.toHaveBeenCalled()
      await act(async () => root.render(<PdfContent data={first} name="cold.pdf" />)); await tick()
      expect(boundary.viewerEvaluations).toBe(1)
      await act(async () => root.render(<PdfContent data={first} name="cold.pdf" visible={false} />))
      boundary.releaseViewer(); await act(async () => { await vi.dynamicImportSettled() })
      expect(boundary.getDocument).not.toHaveBeenCalled()
      await render(<PdfContent data={first} name="cold.pdf" />)
      expect(boundary.getDocument).toHaveBeenCalledTimes(1)
    } finally { boundary.holdColdImports = false; boundary.releaseEngine(); boundary.releaseViewer() }
  })
  it('connects text search to the reader controller, navigates matches and reports current query only', async () => {
    await render(<PdfContent data={first} name="search.pdf" />); await loaded(); await event('pagerendered')
    const reader = boundary.Viewer.instances.at(-1)!, bus = reader.options.eventBus, dispatch = vi.spyOn(bus, 'dispatch')
    expect(reader.options.findController).toBeDefined()
    const input = container.querySelector<HTMLInputElement>('[aria-label="Find in PDF"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'reading'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(dispatch).toHaveBeenCalledWith('find', expect.objectContaining({ query: 'reading', highlightAll: true, type: '' }))
    await act(async () => bus.dispatch('updatefindcontrolstate', { source: reader.options.findController, rawQuery: 'reading', state: 0, matchesCount: { current: 1, total: 3 } }))
    expect(container.textContent).toContain('1 / 3')
    await click('Next PDF match'); expect(dispatch).toHaveBeenCalledWith('find', expect.objectContaining({ type: 'again', findPrevious: false }))
    await click('Previous PDF match'); expect(dispatch).toHaveBeenCalledWith('find', expect.objectContaining({ type: 'again', findPrevious: true }))
    await act(async () => bus.dispatch('updatefindcontrolstate', { source: reader.options.findController, rawQuery: 'obsolete', state: 1, matchesCount: { current: 0, total: 0 } }))
    expect(container.textContent).not.toContain('No matches')
    await render(<PdfContent data={first} name="search.pdf" visible={false} />)
    expect(reader.options.findController.setDocument).toHaveBeenCalledWith(null)
    expect(dispatch).toHaveBeenCalledWith('findbarclose', expect.anything())
  })
  it('loads and navigates nested outlines, fences stale metadata and keeps a failed outline nonblocking', async () => {
    let finish!: (items: any[]) => void
    await render(<PdfContent data={first} name="old.pdf" />); await loaded(0, 3, new Promise(resolve => { finish = resolve })); await event('pagerendered')
    await render(<PdfContent data={second} name="current.pdf" />)
    await loaded(1, 3, Promise.resolve([{ title: 'Chapter two', dest: 'second', items: [{ title: 'Final section', dest: [10, 'Fit'], items: [] }] }])); await event('pagerendered')
    await act(async () => finish([{ title: 'Stale outline', dest: 'old', items: [] }]))
    await click('PDF contents'); expect(container.textContent).toContain('Final section'); expect(container.textContent).not.toContain('Stale outline')
    await click('Chapter two'); expect(boundary.Viewer.instances.at(-1)!.options.linkService.goToDestination).toHaveBeenCalledWith('second')
    await click('Close PDF outline'); expect(container.querySelector('[aria-label="PDF outline"]')).toBeNull()
    await render(<PdfContent data={first} name="outline-error.pdf" />)
    const failure = Promise.reject(new Error('outline broken')); failure.catch(() => {})
    await loaded(2, 3, failure); await event('pagerendered'); await click('PDF contents')
    expect(container.textContent).toContain('outline could not be read')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Find in PDF"]')?.disabled).toBe(false)
    expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('ready')
  })
  it('admits an immutable byte copy and local resources, reports parsed pages, and waits for actual page rendering before ready', async () => {
    await render(<PdfContent data={first} name="report.pdf" />)
    const options = boundary.getDocument.mock.calls[0]![0] as any
    expect(options.data).toEqual(first); expect(options.data).not.toBe(first)
    expect(options.cMapUrl).toBe(new URL('pdfjs/cmaps/', document.baseURI).href)
    expect(options.standardFontDataUrl).toBe(new URL('pdfjs/standard_fonts/', document.baseURI).href)
    expect(options.wasmUrl).toBe(new URL('pdfjs/wasm/', document.baseURI).href)
    const reader = boundary.Viewer.instances[0]!
    expect(reader.options).toMatchObject({ textLayerMode: 1, annotationMode: 1, maxCanvasPixels: 16777216, maxCanvasDim: 8192, capCanvasAreaFactor: 200 })
    expect(reader.options.abortSignal.aborted).toBe(false)
    await loaded(); expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('rendering')
    expect(container.textContent).toContain('/ 3'); expect(container.textContent).toContain('Rendering PDF')
    await event('pagerendered', { cssTransform: true }); expect(container.textContent).toContain('Rendering PDF')
    await event('pagerendered', { error: null }); expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('ready')
    expect(reader.scaleValue).toBe('page-width')
  })
  it('navigates actual pages and fit/zoom through the existing engine and keeps failed-page recovery reachable', async () => {
    await render(<PdfContent data={first} name="report.pdf" />); await loaded(); await event('pagerendered')
    const reader = boundary.Viewer.instances[0]!
    await click('Next PDF page'); expect(reader.currentPageNumber).toBe(2)
    expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('rendering')
    await click('Previous PDF page'); expect(reader.currentPageNumber).toBe(1)
    expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('ready')
    await click('Fit page'); expect(reader.scaleValue).toBe('page-fit')
    await click('PDF original size'); expect(reader.currentScale).toBe(1)
    const release = mountThemeRuntime(window)
    try {
      const zoomOut = container.querySelector('[aria-label="Zoom PDF out"]')!
      expect(zoomOut.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.zoom-out'))
      expect(container.querySelector('[aria-label="Zoom PDF in"] use')?.getAttribute('href')).toBe(semanticIconHref('action.zoom-in'))
      const custom = structuredClone(GRAPHITE_THEME)
      custom.id = 'custom.pdf-zoom-proof'; custom.name = 'PDF zoom'
      custom.icons = { 'action.zoom-out': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z', fill: 'currentColor' }] } }
      expect(previewTheme(custom).applied).toBe(true)
      expect(container.querySelector('[aria-label="Zoom PDF out"]')).toBe(zoomOut)
      expect(document.getElementById(semanticIconHref('action.zoom-out').slice(1))!.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
      await click('Zoom PDF in'); expect(reader.currentScale).toBe(1.25)
    } finally { release() }
    await click('Zoom PDF out'); expect(reader.currentScale).toBe(1)
    await click('Fit width'); expect(reader.scaleValue).toBe('page-width')
    await event('pagerendered', { pageNumber: 2, error: new Error('background preload failure') })
    expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('ready')
    const viewport = container.querySelector<HTMLElement>('.pdf-content__viewport')!
    await act(async () => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))); expect(reader.currentPageNumber).toBe(3)
    await act(async () => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))); expect(reader.currentPageNumber).toBe(1)
    await event('pagerendered', { error: new Error('broken page') }); expect(container.textContent).toContain('could not render this page')
    await click('Next PDF page'); expect(reader.currentPageNumber).toBe(2)
    expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('error')
    await event('pagerendered'); expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('ready')
  })
  it('recovers a previously rendered healthy page from a failed page without requiring another render event', async () => {
    await render(<PdfContent data={first} name="partial.pdf" />); await loaded(); await event('pagerendered')
    await click('Next PDF page'); await event('pagerendered', { error: new Error('page 2 failed') })
    expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('error')
    await click('Previous PDF page')
    expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('ready')
    expect(container.querySelector('.pdf-content__viewport')?.getAttribute('aria-hidden')).toBe('false')
    await click('Next PDF page')
    expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('error')
  })
  it('keeps password input local, handles incorrect password, and cancels the exact pending task', async () => {
    await render(<PdfContent data={first} name="protected.pdf" />)
    const unlock = vi.fn(), task = boundary.tasks[0]!
    await act(async () => task.onPassword!(unlock, 1))
    expect(container.textContent).toContain('Password protected PDF')
    const input = container.querySelector<HTMLInputElement>('input[name="password"]')!; input.value = 'reader-only-password'
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(unlock).toHaveBeenCalledExactlyOnceWith('reader-only-password'); expect(input.value).toBe('')
    await act(async () => task.onPassword!(unlock, 2)); expect(container.textContent).toContain('password was incorrect')
    await click('Cancel'); expect(task.destroy).toHaveBeenCalledOnce(); expect(boundary.Viewer.instances[0]!.options.abortSignal.aborted).toBe(true)
    expect(container.textContent).toContain('PDF loading cancelled')
  })
  it('fences A→B→A late loads, rejects old render events, and releases workers/readers/listeners on hide', async () => {
    await render(<PdfContent data={first} name="a.pdf" />); const oldA = boundary.Viewer.instances[0]!
    await render(<PdfContent data={second} name="b.pdf" />); const oldB = boundary.Viewer.instances[1]!
    await render(<PdfContent data={first} name="a.pdf" />)
    expect(boundary.tasks).toHaveLength(3)
    await loaded(0, 90); await loaded(1, 80)
    expect(oldA.setDocument).toHaveBeenCalledExactlyOnceWith(null); expect(oldB.setDocument).toHaveBeenCalledExactlyOnceWith(null)
    expect(container.textContent).not.toContain('/ 90'); expect(container.textContent).not.toContain('/ 80')
    await loaded(2, 7); await event('pagerendered'); expect(container.textContent).toContain('/ 7')
    expect(retainedSnapshot()).toBe(first)
    await act(async () => oldA.options.eventBus.dispatch('pagerendered', { error: new Error('old failure') })); expect(container.textContent).not.toContain('could not render')
    const latest = boundary.Viewer.instances[2]!
    await render(<PdfContent data={first} name="a.pdf" visible={false} />)
    expect(boundary.tasks.map(task => task.destroy.mock.calls.length)).toEqual([1, 1, 1])
    expect(boundary.Viewer.instances.map(reader => reader.options.abortSignal.aborted)).toEqual([true, true, true])
    expect([...latest.options.eventBus.listeners.values()].every((listeners: any) => listeners.size === 0)).toBe(true)
    expect(observers.map(observer => observer.disconnect.mock.calls.length)).toEqual([1, 1, 1])
    expect(container.textContent).toContain('Preview paused while hidden')
    expect(retainedSnapshot()).toBeNull()
    const count = boundary.getDocument.mock.calls.length
    await render(<PdfContent data={second} name="b.pdf" visible={false} />); expect(boundary.getDocument).toHaveBeenCalledTimes(count)
    expect(retainedSnapshot()).toBeNull()
  })
  it('never labels the previous reader as the new file before passive teardown, and releases decoder failures', async () => {
    const seen: Array<{ name: string; phase: string | null; hidden: string | null }> = []
    function Witness({ data, name }: { data: Uint8Array; name: string }) {
      useLayoutEffect(() => { seen.push({ name, phase: container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state') ?? null, hidden: container.querySelector('[aria-label^="PDF "]')?.getAttribute('aria-hidden') ?? null }) })
      return <PdfContent data={data} name={name} />
    }
    await render(<Witness data={first} name="a.pdf" />); await loaded(); await event('pagerendered')
    await render(<Witness data={second} name="b.pdf" />)
    expect(seen.find(item => item.name === 'b.pdf')).toEqual({ name: 'b.pdf', phase: 'loading', hidden: 'true' })
    await act(async () => boundary.tasks[1]!.reject(new Error('invalid bytes')))
    expect(container.textContent).toContain('could not decode this file'); expect(boundary.tasks[1]!.destroy).toHaveBeenCalledOnce()
    expect(boundary.Viewer.instances[1]!.options.abortSignal.aborted).toBe(true)
  })
  it('fences a pending first-page decode and surfaces a real first-page failure instead of waiting forever', async () => {
    await render(<PdfContent data={first} name="slow.pdf" />)
    let finish!: () => void
    const getPage = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    await act(async () => boundary.tasks[0]!.resolve({ numPages: 3, getPage }))
    expect(getPage).toHaveBeenCalledExactlyOnceWith(1)
    await render(<PdfContent data={second} name="broken.pdf" />)
    await act(async () => finish())
    expect(boundary.Viewer.instances[0]!.setDocument).toHaveBeenCalledExactlyOnceWith(null)
    await act(async () => boundary.tasks[1]!.resolve({ numPages: 5, getPage: async () => { throw new Error('first page invalid') } }))
    expect(container.textContent).toContain('could not decode this file'); expect(container.textContent).not.toContain('/ 5')
    expect(boundary.tasks[1]!.destroy).toHaveBeenCalledOnce()
  })
})
