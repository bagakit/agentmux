import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { NativeOverlaySurfaces } from '../src/main/native-overlay-surfaces'

const fake = vi.hoisted(() => ({ views: [] as any[], load: null as Promise<void> | null, image: null as Promise<void> | null, radiusError: null as Error | null }))
vi.mock('electron', () => ({ WebContentsView: class {
  webContents = { loadURL: vi.fn(async () => {
    this.loadStates.push({ ownerWindow: this.ownerWindow, bounds: this.bounds && { ...this.bounds }, visible: this.visible })
    await fake.load
    this.documentLoaded = true
  }), executeJavaScript: vi.fn(async () => { await fake.image; this.contentLoaded = true }),
    setBackgroundThrottling: vi.fn((value: boolean) => {
      this.syncStates.push({ value, ownerWindow: this.ownerWindow, bounds: this.bounds && { ...this.bounds },
        visible: this.visible, documentLoaded: this.documentLoaded, contentLoaded: this.contentLoaded })
    }),
    setWindowOpenHandler: vi.fn(), on: vi.fn((name, callback) => { this.listeners[name] = callback }),
    isDestroyed: () => this.destroyed, getOSProcessId: () => 4201, close: vi.fn(() => { this.destroyed = true }) }
  listeners: Record<string, (...args: any[]) => void> = {}
  destroyed = false
  ownerWindow: unknown = null
  loadStates: { ownerWindow: unknown; bounds: any; visible: boolean }[] = []
  syncStates: { value: boolean; ownerWindow: unknown; bounds: any; visible: boolean; documentLoaded: boolean; contentLoaded: boolean }[] = []
  documentLoaded = false
  contentLoaded = false
  setBackgroundColor = vi.fn()
  bounds: any
  setBounds = vi.fn(bounds => { this.bounds = bounds })
  getBounds = () => this.bounds
  setBorderRadius = vi.fn((radius: number) => {
    if (fake.radiusError) throw fake.radiusError
    // Electron's original View boundary accepts integer pixels, including after UI zoom.
    if (!Number.isInteger(radius)) throw new TypeError('Native radius requires an integer')
  })
  visible = false
  setVisible = vi.fn(value => { this.visible = value })
  getVisible = () => this.visible
  constructor() { fake.views.push(this) }
} }))

function fixture() {
  const contents = { capturePage: vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('chrome-frame') })),
    getZoomFactor: () => 1.25, sendInputEvent: vi.fn(), isDestroyed: () => false, focus: vi.fn() }
  const pageView = originalPage({ x: 100, y: 100, width: 600, height: 500 })
  const window = { getContentBounds: () => ({ width: 1000, height: 700 }), webContents: contents,
    contentView: { children: [pageView] as any[], addChildView: vi.fn(), removeChildView: vi.fn() }, isDestroyed: () => false }
  window.contentView.addChildView.mockImplementation(view => {
    const index = window.contentView.children.indexOf(view)
    if (index >= 0) window.contentView.children.splice(index, 1)
    window.contentView.children.push(view); view.ownerWindow = window
  })
  window.contentView.removeChildView.mockImplementation(view => {
    const index = window.contentView.children.indexOf(view)
    if (index >= 0) window.contentView.children.splice(index, 1)
    view.ownerWindow = null
  })
  const visible = vi.fn(() => [{ x: 100, y: 100, width: 600, height: 500 }])
  const pages = new Map([['page', pageView]])
  const nativeOwner = vi.fn((browserId: string) => { const view = pages.get(browserId); return view ? { browserId, bounds: view.getBounds(), view } : undefined })
  const warning = vi.fn(), pointer = vi.fn()
  return { owner: new NativeOverlaySurfaces(window as any, { visibleNativeBounds: visible, nativeOwner } as any, warning, pointer), window, contents, visible, nativeOwner, pages, pageView, warning, pointer }
}
function originalPage(bounds: { x: number; y: number; width: number; height: number }) {
  const page = { bounds, getBounds: () => page.bounds, getVisible: () => true,
    setBounds: vi.fn(), setVisible: vi.fn(), webContents: { close: vi.fn(), focus: vi.fn(), sendInputEvent: vi.fn() } }
  return page
}
const float = { id: 'chrome-1', bounds: { x: 120, y: 150, width: 100, height: 80 }, radius: 8 }

// A separate process observes real unhandled-rejection delivery without changing Vitest's
// own handler. It compiles the current production module; only Electron's native boundary is modeled.
function lateDocumentAfterRemoval(geometry: 'radius' | 'reorder'): {
  projected: number; warning: string; views: number; closed: boolean; unhandled: string[]
} {
  const script = String.raw`
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const ts = require('typescript'), { createRequire } = require('node:module');
    const root = process.cwd(), requirePackage = createRequire(path.join(root, 'package.json'));
    const geometry = process.argv[1], modules = new Map(), views = [], unhandled = [];
    let rejectDocument, attachmentCount = 0;
    process.on('unhandledRejection', error => unhandled.push(error.message));
    class View {
      constructor() {
        views.push(this);
        this.webContents = {
          loadURL: () => new Promise((_resolve, reject) => { rejectDocument = reject }),
          setWindowOpenHandler() {}, on() {}, isDestroyed: () => this.closed === true,
          close: () => {
            this.closed = true;
            setImmediate(() => rejectDocument(new Error('Original document interrupted by owner close')));
          }
        };
      }
      setBackgroundColor() {} setBounds(bounds) { this.bounds = bounds } setVisible() {}
      setBorderRadius() { if (geometry === 'radius') throw new Error('Original native radius rejected') }
    }
    function load(file) {
      if (modules.has(file)) return modules.get(file).exports;
      const module = { exports: {} }; modules.set(file, module);
      const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText;
      const requireModule = id => id === 'electron' ? { WebContentsView: View }
        : id.startsWith('.') ? load(path.resolve(path.dirname(file), id.replace(/\.js$/, '.ts')))
        : requirePackage(id);
      vm.runInThisContext('(function(require,module,exports){' + code + '\n})', { filename: file })
        (requireModule, module, module.exports);
      return module.exports;
    }
    (async () => {
      const Owner = load(path.join(root, 'apps/desktop/src/main/native-overlay-surfaces.ts')).NativeOverlaySurfaces;
      const window = {
        getContentBounds: () => ({ width: 800, height: 600 }), isDestroyed: () => false,
        webContents: { isDestroyed: () => false },
        contentView: {
          addChildView() {
            if (++attachmentCount === 2 && geometry === 'reorder') throw new Error('Original native reorder rejected');
          }, removeChildView() {}
        }
      };
      const owner = new Owner(window, { visibleNativeBounds: () => [{ x: 0, y: 0, width: 800, height: 600 }], nativeOwner: () => undefined }, () => {}, () => {});
      const receipt = await owner.update([{ id: 'chrome-1', bounds: { x: 20, y: 20, width: 100, height: 100 }, radius: 11.25 }]);
      await new Promise(resolve => setTimeout(resolve, 20));
      owner.dispose();
      console.log(JSON.stringify({ projected: receipt.projected, warning: receipt.warning,
        views: views.length, closed: views[0].closed, unhandled }));
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `
  return JSON.parse(execFileSync(process.execPath, ['-e', script, geometry], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
  })) as ReturnType<typeof lateDocumentAfterRemoval>
}

beforeEach(() => { fake.views.length = 0; fake.load = null; fake.image = null; fake.radiusError = null })
describe('actual native Chrome owner', () => {
  it('raises only the original contained page, preserves background owners, and keeps a later float above it', async () => {
    const { owner, window, contents, visible, pages, pageView, nativeOwner, pointer } = fixture()
    const inside = originalPage({ x: 130, y: 160, width: 80, height: 60 })
    const unrelated = originalPage({ x: 800, y: 500, width: 100, height: 100 })
    pages.set('inside', inside); pages.set('unrelated', unrelated)
    window.contentView.children.push(inside, unrelated)
    visible.mockReturnValue([...pages.values()].map(view => view.getBounds()))
    const containing = { ...float, browserStages: [{ browserId: 'inside', bounds: inside.getBounds() }] }
    expect(await owner.update([containing])).toEqual({ projected: 1, capturedPixels: 8000 })
    expect(fake.views).toHaveLength(1)
    expect(window.contentView.children).toEqual([pageView, unrelated, fake.views[0], inside])
    expect(window.contentView.addChildView.mock.calls.map(call => call[0])).toEqual([fake.views[0], fake.views[0], inside])
    const origin = nativeOwner('inside') as any
    owner.forwardBrowserInput(origin, { type: 'pointer', event: { type: 'mouseMove', x: 20, y: 20 } })
    expect(pointer.mock.calls).toEqual([[{ type: 'pointerMove', browserId: 'inside', overlayId: 'chrome-1', x: 120, y: 144, button: 0 }]])
    expect(owner.forwardBrowserInput(origin, { type: 'escape' })).toBe(true)
    expect(pointer.mock.calls.at(-1)).toEqual([{ type: 'escape', browserId: 'inside', overlayId: 'chrome-1' }])
    window.contentView.addChildView.mockClear()
    const later = { id: 'chrome-2', bounds: { x: 140, y: 170, width: 30, height: 30 }, radius: 2 }
    expect(await owner.update([containing, later])).toEqual({ projected: 2, capturedPixels: 8900 })
    expect(window.contentView.children).toEqual([pageView, unrelated, fake.views[0], inside, fake.views[1]])
    expect(window.contentView.addChildView.mock.calls.map(call => call[0])).toEqual([fake.views[1], fake.views[1]])
    pointer.mockClear()
    owner.forwardBrowserInput(origin, { type: 'pointer', event: { type: 'mouseDown', x: 20, y: 20, button: 'left' } })
    expect(pointer).not.toHaveBeenCalled()
    for (const page of [pageView, inside, unrelated]) {
      expect(page.setBounds).not.toHaveBeenCalled(); expect(page.setVisible).not.toHaveBeenCalled(); expect(page.webContents.close).not.toHaveBeenCalled()
      expect(page.webContents.focus).not.toHaveBeenCalled(); expect(page.webContents.sendInputEvent).not.toHaveBeenCalled()
    }
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    expect(window.contentView.children).toEqual([pageView, unrelated, inside])
    owner.dispose()
  })
  it.each(['wrong-id', 'outside-stage', 'outside-float'] as const)('cannot promote a page from an invalid %s containment fact', async defect => {
    const { owner, window, pages, pageView, pointer } = fixture()
    const inside = originalPage({ x: 130, y: 160, width: 80, height: 60 })
    pages.set('inside', inside); window.contentView.children.push(inside)
    const stage = { browserId: defect === 'wrong-id' ? 'absent' : 'inside', bounds: defect === 'outside-stage' ? { x: 400, y: 400, width: 80, height: 60 } : inside.getBounds() }
    const containing = { ...float, ...(defect === 'outside-float' ? { bounds: { x: 120, y: 150, width: 30, height: 30 } } : {}), browserStages: [stage] }
    await owner.update([containing])
    expect(fake.views).toHaveLength(1)
    expect(window.contentView.children).toEqual([pageView, inside, fake.views[0]])
    expect(window.contentView.addChildView.mock.calls.map(call => call[0])).toEqual([fake.views[0], fake.views[0]])
    expect(owner.forwardBrowserInput({ browserId: 'inside', bounds: inside.getBounds(), view: inside } as any, { type: 'escape' })).toBe(false)
    expect(pointer).not.toHaveBeenCalled()
    owner.dispose()
  })
  it.each(['radius', 'reorder'] as const)('consumes a removed owner document rejection after synchronous %s failure', geometry => {
    const result = lateDocumentAfterRemoval(geometry)
    expect(result.views).toBe(1)
    expect(result.closed).toBe(true)
    expect(result.projected).toBe(0)
    expect(result.warning).toContain(`Chrome geometry: Original native ${geometry} rejected`)
    expect(result.unhandled).toEqual([])
  })
  it.each([[11.25, 11], [7.2, 7], [0.625, 1]])('paints a visible interactive owner for fractional zoom radius %s', async (radius, nativeRadius) => {
    const { owner, contents } = fixture()
    await expect(owner.update([{ ...float, radius }])).resolves.toEqual({ projected: 1, capturedPixels: 8000 })
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(view.setBorderRadius).toHaveBeenCalledExactlyOnceWith(nativeRadius)
    expect(view.contentLoaded).toBe(true)
    expect(view.getVisible()).toBe(true)
    expect(contents.capturePage).toHaveBeenCalledTimes(1)
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).toHaveBeenCalledWith({ type: 'mouseDown', x: 125, y: 157, button: 'left' })
    owner.dispose()
  })
  it('cleans a rejected native radius while reporting the failed step and retaining Browser ownership', async () => {
    fake.radiusError = new Error('Native radius configuration rejected')
    const { owner, contents } = fixture()
    await expect(owner.update([float])).resolves.toMatchObject({ projected: 0, warning: expect.stringContaining('Native radius configuration rejected') })
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(view.ownerWindow).toBeNull()
    expect(contents.capturePage).not.toHaveBeenCalled()
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    owner.dispose()
  })
  it('cleans a rejected native reorder without leaving empty Chrome over a healthy page', async () => {
    const { owner, window, contents } = fixture()
    window.contentView.addChildView.mockImplementationOnce(view => { view.ownerWindow = window })
      .mockImplementationOnce(() => { throw new Error('Native child reorder rejected') })
    await expect(owner.update([float])).resolves.toMatchObject({ projected: 0, warning: expect.stringContaining('Native child reorder rejected') })
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(view.ownerWindow).toBeNull()
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(contents.focus).not.toHaveBeenCalled()
    owner.dispose()
  })
  it('synchronizes throttling once on the attached owner after document and content load, never during subsequent paints', async () => {
    let finishDocument!: () => void, finishContent!: () => void
    fake.load = new Promise(resolve => { finishDocument = resolve })
    fake.image = new Promise(resolve => { finishContent = resolve })
    const { owner, window, contents } = fixture()
    const pending = owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(view.ownerWindow).toBe(window)
    expect(view.getBounds()).toEqual(float.bounds)
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(contents.capturePage).not.toHaveBeenCalled()
    finishDocument()
    await vi.waitFor(() => expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(1))
    expect(view.documentLoaded).toBe(true)
    expect(view.contentLoaded).toBe(false)
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    finishContent()
    expect(await pending).toEqual({ projected: 1, capturedPixels: 8000 })
    expect(view.syncStates).toEqual([{ value: false, ownerWindow: window, bounds: float.bounds,
      visible: true, documentLoaded: true, contentLoaded: true }])
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(await owner.refresh()).toEqual({ projected: 1, capturedPixels: 8000 })
    expect(await owner.update([{ ...float, bounds: { ...float.bounds, x: 200 } }])).toEqual({ projected: 1, capturedPixels: 8000 })
    view.listeners['input-event']({}, { type: 'keyDown', keyCode: 'Escape' })
    await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledTimes(4))
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(fake.views).toHaveLength(1)
    expect(view.setVisible.mock.calls).toEqual([[true]])
    expect(contents.focus).not.toHaveBeenCalled()
    owner.dispose()
  })
  it('cannot synchronize or route a late document after its native owner is removed', async () => {
    let finishDocument!: () => void
    fake.load = new Promise(resolve => { finishDocument = resolve })
    const { owner, contents } = fixture()
    const pending = owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    finishDocument()
    expect(await pending).toEqual({ projected: 0, capturedPixels: 8000 })
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(contents.capturePage).not.toHaveBeenCalled()
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(view.ownerWindow).toBeNull()
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    owner.dispose()
  })
  it('cannot synchronize or route late content after its native owner is removed', async () => {
    let finishContent!: () => void
    fake.image = new Promise(resolve => { finishContent = resolve })
    const { owner, contents } = fixture()
    const pending = owner.update([float])
    await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledTimes(1))
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    finishContent()
    expect(await pending).toEqual({ projected: 0, capturedPixels: 8000 })
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(view.ownerWindow).toBeNull()
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    owner.dispose()
  })
  it('a rejected document cannot be synchronized and reports degradation while retaining page input ownership', async () => {
    fake.load = Promise.reject(new Error('Chrome document load rejected'))
    const { owner, contents } = fixture()
    expect(await owner.update([float])).toMatchObject({ projected: 0, warning: expect.stringContaining('Browser remains available') })
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(view.webContents.executeJavaScript).not.toHaveBeenCalled()
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.focus).not.toHaveBeenCalled()
    owner.dispose()
  })
  it('a synchronization failure uses the existing paint warning and cleanup without taking Browser input', async () => {
    let finishDocument!: () => void
    fake.load = new Promise(resolve => { finishDocument = resolve })
    const { owner, contents } = fixture()
    const pending = owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    view.webContents.setBackgroundThrottling.mockImplementationOnce(() => { throw new Error('Platform synchronization rejected') })
    finishDocument()
    expect(await pending).toMatchObject({ projected: 0, warning: expect.stringContaining('Browser remains available') })
    expect(view.webContents.setBackgroundThrottling).toHaveBeenCalledExactlyOnceWith(false)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.focus).not.toHaveBeenCalled()
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    expect(await owner.refresh()).toEqual({ projected: 0, capturedPixels: 0 })
    owner.dispose()
  })
  it('attaches the Chrome to its owner with actual clipped bounds before its document starts loading', async () => {
    const { owner, window, contents, visible } = fixture()
    visible.mockReturnValue([{ x: 0, y: 0, width: 1000, height: 700 }])
    const requested = { ...float, bounds: { x: 940, y: 650, width: 200, height: 100 } }
    const actual = { x: 940, y: 650, width: 60, height: 50 }
    expect(await owner.update([requested])).toEqual({ projected: 1, capturedPixels: 3000 })
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    // Captured synchronously by the Electron double at the production loadURL boundary,
    // not inferred from its final attachment or invocation-order numbers. Native frames
    // remain a separate canonical product proof.
    expect(view.loadStates).toHaveLength(1)
    expect(view.loadStates[0].ownerWindow).toBe(window)
    expect(view.loadStates[0].bounds).toEqual(actual)
    expect(view.loadStates[0].visible).toBe(true)
    expect(view.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^data:text\/html,/))
    expect(contents.capturePage).toHaveBeenCalledExactlyOnceWith(actual)
    expect(view.setVisible.mock.calls).toEqual([[true]])
    expect(contents.focus).not.toHaveBeenCalled()
    owner.dispose()
  })
  it('relays only ordinary native outside pointer coordinates while retaining page input and focus', async () => {
    const { owner, pointer, contents, warning, pageView } = fixture()
    const page = { x: 100, y: 100, width: 600, height: 500 }
    const origin = { browserId: 'page', bounds: page, view: pageView } as any
    const send = (event: Electron.MouseInputEvent) => owner.forwardBrowserInput(origin, { type: 'pointer', event })
    send({ type: 'mouseDown', x: 300, y: 50, button: 'left' })
    expect(pointer).not.toHaveBeenCalled()
    await owner.update([float])
    send({ type: 'mouseDown', x: 300, y: 50, button: 'left' })
    expect(pointer.mock.calls).toEqual([[{ type: 'pointerDown', browserId: 'page', x: 320, y: 120, button: 0 }]])
    send({ type: 'mouseDown', x: 25, y: 57, button: 'left' })
    send({ type: 'mouseMove', x: 300, y: 50 })
    send({ type: 'mouseDown', x: -1, y: 50, button: 'left' })
    expect(pointer).toHaveBeenCalledTimes(2)
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.focus).not.toHaveBeenCalled()
    expect(contents.capturePage).toHaveBeenCalledTimes(1)
    pointer.mockImplementationOnce(() => { throw new Error('Renderer notice transport closed') })
    expect(() => send({ type: 'mouseDown', x: 300, y: 50, button: 'left' })).not.toThrow()
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('floating-panel notice could not reach'))
    owner.dispose()
    send({ type: 'mouseDown', x: 300, y: 50, button: 'left' })
    expect(pointer).toHaveBeenCalledTimes(3)
  })
  it('zero floats do no Browser traversal, native allocation, capture or polling', async () => {
    const { owner, visible, contents } = fixture()
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    expect(await owner.refresh()).toEqual({ projected: 0, capturedPixels: 0 })
    expect(visible).not.toHaveBeenCalled()
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(fake.views).toEqual([])
    expect(owner.resourceProcessIds()).toEqual([])
  })
  it('an unrelated float does not allocate or touch any Browser view', async () => {
    const { owner, contents, pointer, pageView } = fixture()
    expect(await owner.update([{ ...float, bounds: { x: 5, y: 5, width: 30, height: 30 } }])).toEqual({ projected: 0, capturedPixels: 0 })
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(fake.views).toEqual([])
    owner.forwardBrowserInput({ browserId: 'page', bounds: pageView.getBounds(), view: pageView } as any, { type: 'pointer', event: { type: 'mouseDown', x: 300, y: 50, button: 'left' } })
    expect(pointer.mock.calls).toEqual([[{ type: 'pointerDown', browserId: 'page', x: 320, y: 120, button: 0 }]])
  })
  it('captures only the intersecting original Chrome rectangle and disposes on close', async () => {
    const { owner, contents, window } = fixture()
    expect(await owner.update([float])).toEqual({ projected: 1, capturedPixels: 8000 })
    expect(contents.capturePage).toHaveBeenCalledExactlyOnceWith(float.bounds)
    expect(fake.views).toHaveLength(1)
    expect(owner.resourceProcessIds()).toEqual([4201])
    const view = fake.views[0]
    expect(view.setBorderRadius).toHaveBeenCalledWith(8)
    expect(view.webContents.executeJavaScript.mock.calls[0][0]).toContain(Buffer.from('chrome-frame').toString('base64'))
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(owner.resourceProcessIds()).toEqual([])
  })
  it('projects a real modal scrim as transparency, never a full-window Chrome bitmap', async () => {
    const { owner, contents } = fixture()
    expect(await owner.update([{ ...float, bounds: { x: 0, y: 0, width: 1000, height: 700 }, scrim: 'rgba(0, 0, 0, 0.2)' }])).toEqual({ projected: 1, capturedPixels: 0 })
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(fake.views).toHaveLength(1)
    expect(fake.views[0].webContents.executeJavaScript.mock.calls[0][0]).toContain('rgba(0, 0, 0, 0.2)')
    expect(fake.views[0].webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    const moved={...float,bounds:{x:20,y:30,width:800,height:600},scrim:'rgba(0, 0, 0, 0.3)'}
    expect(await owner.update([moved])).toEqual({projected:1,capturedPixels:0})
    expect(fake.views[0].getBounds()).toEqual(moved.bounds)
    expect(fake.views[0].webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    contents.sendInputEvent.mockClear()
    fake.views[0].listeners['input-event']({}, {type:'mouseDown',x:5,y:7,button:'left'})
    expect(contents.sendInputEvent).toHaveBeenCalledWith({type:'mouseDown',x:25,y:37,button:'left'})
  })
  it('real native pointer and keyboard input goes to the original Renderer at current window coordinates', async () => {
    const { owner, contents } = fixture()
    await owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).toHaveBeenCalledWith({ type: 'mouseDown', x: 125, y: 157, button: 'left' })
    expect(contents.focus).toHaveBeenCalledTimes(1)
    await owner.update([{ ...float, bounds: { ...float.bounds, x: 200 } }])
    view.listeners['input-event']({}, { type: 'mouseUp', x: 5, y: 7, button: 'left' })
    view.listeners['input-event']({}, { type: 'keyDown', keyCode: 'Escape' })
    expect(contents.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
      { type: 'mouseDown', x: 125, y: 157, button: 'left' },
      { type: 'mouseUp', x: 205, y: 157, button: 'left' }, { type: 'keyDown', keyCode: 'Escape' }
    ])
    owner.dispose()
  })
  it.each([
    ['left', 'leftbuttondown'], ['middle', 'middlebuttondown'], ['right', 'rightbuttondown']
  ] as const)('retains the actual %s button across modifier-less native mouse moves', async (button, held) => {
    const { owner, contents } = fixture()
    try {
      await owner.update([float])
      const view = fake.views[0]
      // Electron 43.4.1 WebMouseEvent::ToV8 omits modifiers from input-event.
      // This is the native producer's shape, not a synthetic DOM pointer event.
      for (const input of [
        { type: 'mouseDown', x: 5, y: 7, button },
        { type: 'mouseMove', x: 15, y: 7, button },
        { type: 'mouseMove', x: 25, y: 7, button, modifiers: ['shift'] },
        { type: 'mouseUp', x: 25, y: 7, button },
        { type: 'mouseMove', x: 35, y: 7, button }
      ]) view.listeners['input-event']({}, input)
      expect(contents.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
        { type: 'mouseDown', x: 125, y: 157, button },
        { type: 'mouseMove', x: 135, y: 157, button, modifiers: [held] },
        { type: 'mouseMove', x: 145, y: 157, button, modifiers: ['shift', held] },
        { type: 'mouseUp', x: 145, y: 157, button },
        { type: 'mouseMove', x: 155, y: 157, button }
      ])
    } finally { owner.dispose() }
  })
  it('releases buttons independently and retains the same gesture through an owner repaint', async () => {
    const { owner, contents } = fixture()
    try {
      await owner.update([float])
      const view = fake.views[0]
      view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
      view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'right' })
      await owner.update([{ ...float, bounds: { ...float.bounds, x: 200 } }])
      view.listeners['input-event']({}, { type: 'mouseMove', x: 15, y: 7, button: 'right' })
      view.listeners['input-event']({}, { type: 'mouseUp', x: 15, y: 7, button: 'left' })
      view.listeners['input-event']({}, { type: 'mouseMove', x: 25, y: 7, button: 'right' })
      view.listeners['input-event']({}, { type: 'mouseUp', x: 25, y: 7, button: 'right' })
      view.listeners['input-event']({}, { type: 'mouseMove', x: 35, y: 7, button: 'none' })
      expect(contents.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
        { type: 'mouseDown', x: 125, y: 157, button: 'left' },
        { type: 'mouseDown', x: 125, y: 157, button: 'right' },
        { type: 'mouseMove', x: 215, y: 157, button: 'right', modifiers: ['leftbuttondown', 'rightbuttondown'] },
        { type: 'mouseUp', x: 215, y: 157, button: 'left' },
        { type: 'mouseMove', x: 225, y: 157, button: 'right', modifiers: ['rightbuttondown'] },
        { type: 'mouseUp', x: 225, y: 157, button: 'right' },
        { type: 'mouseMove', x: 235, y: 157, button: 'none' }
      ])
    } finally { owner.dispose() }
  })
  it('continues and releases an accepted gesture at actual View bounds during a held repaint', async () => {
    const { owner, contents, warning } = fixture()
    let finishContent: (() => void) | undefined
    let repaint: Promise<unknown> | undefined
    try {
      await owner.update([float])
      const view = fake.views[0]
      view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
      fake.image = new Promise(resolve => { finishContent = resolve })
      const moved = { ...float, bounds: { ...float.bounds, x: 200, y: 230 } }
      repaint = owner.update([moved])
      await vi.waitFor(() => expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(2))
      // The requested region has moved, but the original native View still has its old rectangle.
      expect(view.getBounds()).toEqual(float.bounds)
      view.listeners['input-event']({}, { type: 'mouseMove', x: 15, y: 7, button: 'left' })
      view.listeners['input-event']({}, { type: 'mouseUp', x: 25, y: 7, button: 'left' })
      // No new gesture or keyboard input is authorized by an unfinished paint.
      view.listeners['input-event']({}, { type: 'mouseDown', x: 30, y: 7, button: 'right' })
      view.listeners['input-event']({}, { type: 'keyDown', keyCode: 'Escape' })
      view.listeners['input-event']({}, { type: 'mouseMove', x: 30, y: 7, button: 'none' })
      finishContent!()
      expect(await repaint).toEqual({ projected: 1, capturedPixels: 8000 })
      expect(view.getBounds()).toEqual(moved.bounds)
      view.listeners['input-event']({}, { type: 'mouseMove', x: 35, y: 7, button: 'none' })
      expect(contents.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
        { type: 'mouseDown', x: 125, y: 157, button: 'left' },
        { type: 'mouseMove', x: 135, y: 157, button: 'left', modifiers: ['leftbuttondown'] },
        { type: 'mouseUp', x: 145, y: 157, button: 'left' },
        { type: 'mouseMove', x: 235, y: 237, button: 'none' }
      ])
      expect(contents.focus).toHaveBeenCalledTimes(1)
      expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
      expect(fake.views).toHaveLength(1)
      expect(warning).not.toHaveBeenCalled()
    } finally {
      finishContent?.()
      await repaint?.catch(() => {})
      owner.dispose()
    }
  })
  it('never transfers a held button to another, recreated or disposed native owner', async () => {
    const { owner, contents } = fixture()
    try {
      await owner.update([float])
      const old = fake.views[0]
      old.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
      const sibling = { ...float, id: 'chrome-2', bounds: { ...float.bounds, x: 400 } }
      await owner.update([float, sibling])
      const other = fake.views[1]
      other.listeners['input-event']({}, { type: 'mouseMove', x: 15, y: 7, button: 'none' })
      old.listeners['input-event']({}, { type: 'mouseMove', x: 15, y: 7, button: 'left' })
      await owner.update([sibling])
      old.listeners['input-event']({}, { type: 'mouseMove', x: 25, y: 7, button: 'left' })
      await owner.update([sibling, float])
      expect(fake.views).toHaveLength(3)
      fake.views[2].listeners['input-event']({}, { type: 'mouseMove', x: 15, y: 7, button: 'none' })
      owner.dispose()
      other.listeners['input-event']({}, { type: 'mouseMove', x: 25, y: 7, button: 'none' })
      expect(contents.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
        { type: 'mouseDown', x: 125, y: 157, button: 'left' },
        { type: 'mouseMove', x: 415, y: 157, button: 'none' },
        { type: 'mouseMove', x: 135, y: 157, button: 'left', modifiers: ['leftbuttondown'] },
        { type: 'mouseMove', x: 135, y: 157, button: 'none' }
      ])
    } finally { owner.dispose() }
  })
  it('paint failure reports degradation while preserving the Browser and cleaning the failed Chrome owner', async () => {
    const { owner, contents } = fixture()
    contents.capturePage.mockRejectedValueOnce(new Error('compositor unavailable'))
    const receipt = await owner.update([float])
    expect(receipt.projected).toBe(0)
    expect(receipt.warning).toContain('Browser remains available')
    expect(fake.views).toHaveLength(1)
    expect(fake.views[0].webContents.close).toHaveBeenCalledTimes(1)
  })
  it('pending or failed repaint cannot route a stale picture to the new source position', async () => {
    const { owner, contents } = fixture()
    await owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    let reject!: (error: Error) => void
    contents.capturePage.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const moved = owner.update([{ ...float, bounds: { ...float.bounds, x: 200 } }])
    await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledTimes(2))
    expect(view.getBounds()).toEqual(float.bounds)
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    reject(new Error('Compositor unavailable'))
    expect(await moved).toMatchObject({ projected: 0, warning: expect.stringContaining('Browser remains available') })
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })
  it('a closed projection late failure cannot delete or leak a reopened same-id native owner', async () => {
    const {owner,contents,warning}=fixture()
    let fail!:(error:Error)=>void
    contents.capturePage.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject}))
    const old=owner.update([float])
    await vi.waitFor(()=>expect(contents.capturePage).toHaveBeenCalledTimes(1))
    await owner.update([])
    expect(await owner.update([float])).toEqual({projected:1,capturedPixels:8000})
    expect(fake.views).toHaveLength(2)
    const replacement=fake.views[1]
    fail(new Error('Old closed compositor response'))
    expect(await old).toEqual({projected:1,capturedPixels:8000})
    expect(warning).not.toHaveBeenCalled()
    expect(replacement.webContents.close).not.toHaveBeenCalled()
    expect(owner.resourceProcessIds()).toEqual([4201])
    owner.dispose()
    expect(replacement.webContents.close).toHaveBeenCalledTimes(1)
    expect(owner.resourceProcessIds()).toEqual([])
  })
})
