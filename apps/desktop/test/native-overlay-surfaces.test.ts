import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { NativeOverlaySurfaces } from '../src/main/native-overlay-surfaces'
import type { NativeOverlayRegion } from '../src/shared/native-overlay'

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
    isFocused: vi.fn(() => false), isDestroyed: () => this.destroyed, getOSProcessId: () => 4201, close: vi.fn(() => { this.destroyed = true }) }
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
    contentView: { children: [pageView] as any[], addChildView: vi.fn(), removeChildView: vi.fn() }, isDestroyed: () => false, isFocused: vi.fn(() => true) }
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
  const nativeOwnerForView = vi.fn((view: unknown) => { for (const [id, candidate] of pages) if (candidate === view) return nativeOwner(id) })
  const warning = vi.fn(), pointer = vi.fn()
  return { owner: new NativeOverlaySurfaces(window as any, { visibleNativeBounds: visible, nativeOwner, nativeOwnerForView } as any, warning, pointer), window, contents, visible, nativeOwner, nativeOwnerForView, pages, pageView, warning, pointer }
}
function originalPage(bounds: { x: number; y: number; width: number; height: number }) {
  const page = { bounds, getBounds: () => page.bounds, getVisible: () => true,
    setBounds: vi.fn(), setVisible: vi.fn(), webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, close: vi.fn(), focus: vi.fn(), sendInputEvent: vi.fn() }) }
  return page
}
const float = { id: 'chrome-1', bounds: { x: 120, y: 150, width: 100, height: 80 }, radius: 8 }

const modal = (): NativeOverlayRegion[] => [
  { id: 'chrome-1', bounds: { x: 0, y: 0, width: 1000, height: 700 }, radius: 0, scrim: 'rgba(0, 0, 0, 0.45)', modal: { id: 'original-confirmation', part: 'scrim' as const } },
  { ...float, id: 'chrome-2', modal: { id: 'original-confirmation', part: 'content' as const } }
]

describe('required modal presentation unit', () => {
  beforeEach(() => { fake.views = []; fake.load = null; fake.image = null; fake.radiusError = null })

  it('prepares both required frames offscreen, guards exact background input, and commits them together', async () => {
    const f = fixture()
    let finish!: (image: { isEmpty(): boolean; toPNG(): Buffer }) => void
    f.contents.capturePage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.owner.update(modal())
    await vi.waitFor(() => expect(f.contents.capturePage).toHaveBeenCalledTimes(1))
    expect(fake.views).toHaveLength(2)
    for (const view of fake.views) expect(view.getBounds().x).toBeLessThan(0)
    const prevent = vi.fn()
    f.pageView.webContents.emit('before-mouse-event', { preventDefault: prevent }, { type: 'mouseDown', x: 5, y: 5 })
    f.pageView.webContents.emit('before-input-event', { preventDefault: prevent }, { key: 'a' })
    expect(prevent).toHaveBeenCalledTimes(2)
    expect(f.pageView.setVisible).not.toHaveBeenCalled()
    finish({ isEmpty: () => false, toPNG: () => Buffer.from('prepared-content') })
    expect(await pending).toEqual({ projected: 2, capturedPixels: 8000 })
    expect(fake.views.map(view => view.getBounds())).toEqual(modal().map(region => region.bounds))
    expect(f.window.contentView.children).toEqual([f.pageView, ...fake.views])
    await f.owner.update([])
    expect(f.pageView.webContents.listenerCount('before-mouse-event')).toBe(0)
    expect(f.pageView.webContents.listenerCount('before-input-event')).toBe(0)
    f.owner.dispose()
  })

  it('reports the original modal id and removes its scrim, content and input guard after content paint fails', async () => {
    const f = fixture()
    f.contents.capturePage.mockRejectedValueOnce(new Error('Original content frame failed'))
    const receipt = await f.owner.update(modal())
    expect(receipt).toMatchObject({ projected: 0, failures: [{ modalId: 'original-confirmation', message: expect.stringContaining('Original content frame failed') }] })
    expect(f.warning).toHaveBeenCalledWith(expect.stringContaining('Original content frame failed'), 'original-confirmation')
    expect(f.window.contentView.children).toEqual([f.pageView])
    expect(f.pageView.webContents.listenerCount('before-mouse-event')).toBe(0)
    expect(f.pageView.webContents.listenerCount('before-input-event')).toBe(0)
    expect(f.pageView.setVisible).not.toHaveBeenCalled()
    expect(await f.owner.refresh()).toEqual({ projected: 0, capturedPixels: 0 })
    f.owner.dispose()
  })

  it('does not guard an unrelated native view with identical geometry or a replaced Browser owner', async () => {
    const f = fixture(), unrelated = originalPage({ ...f.pageView.bounds })
    f.window.contentView.children.push(unrelated)
    await f.owner.update(modal())
    expect(unrelated.webContents.listenerCount('before-mouse-event')).toBe(0)
    const prevent = vi.fn()
    f.pages.set('page', unrelated)
    f.pageView.webContents.emit('before-input-event', { preventDefault: prevent }, { key: 'a' })
    expect(prevent).not.toHaveBeenCalled()
    f.owner.dispose()
  })

  it('keeps an exactly contained Browser usable in the foreground modal', async () => {
    const f = fixture(), pair = modal()
    pair[1] = { ...pair[1]!, bounds: { ...f.pageView.bounds }, browserStages: [{ browserId: 'page', bounds: { ...f.pageView.bounds } }] }
    await f.owner.update(pair)
    const prevent = vi.fn()
    f.pageView.webContents.emit('before-mouse-event', { preventDefault: prevent }, { type: 'mouseDown', x: 5, y: 5 })
    expect(prevent).not.toHaveBeenCalled()
    expect(f.window.contentView.children.at(-1)).toBe(f.pageView)
    f.owner.dispose()
  })

  it('an accessory paint failure does not revoke the required modal pair', async () => {
    const f = fixture()
    f.contents.capturePage.mockResolvedValueOnce({ isEmpty: () => false, toPNG: () => Buffer.from('modal-content') })
    f.contents.capturePage.mockRejectedValueOnce(new Error('Accessory frame failed'))
    const receipt = await f.owner.update([...modal(), { ...float, id: 'chrome-3' }])
    expect(receipt).toMatchObject({ projected: 2, warning: expect.stringContaining('Accessory frame failed') })
    expect(receipt.failures).toBeUndefined()
    expect(f.window.contentView.children).toEqual([f.pageView, fake.views[0], fake.views[1]])
    expect(f.pageView.webContents.listenerCount('before-mouse-event')).toBe(1)
    f.owner.dispose()
  })

  it('refuses an incomplete required pair before allocating a scrim or blocking Browser input', async () => {
    const f = fixture()
    expect(await f.owner.update(modal().slice(0, 1))).toMatchObject({ projected: 0, failures: [{ modalId: 'original-confirmation', message: expect.stringContaining('complete modal') }] })
    expect(fake.views).toEqual([])
    expect(f.pageView.webContents.listenerCount('before-mouse-event')).toBe(0)
    f.owner.dispose()
  })

  it('accepts a complete pair when only the scrim overlaps a native page', async () => {
    const f = fixture(), pair = modal()
    pair[1] = { ...pair[1]!, bounds: { x: 5, y: 10, width: 80, height: 70 } }
    expect(await f.owner.update(pair)).toEqual({ projected: 1, capturedPixels: 0 })
    expect(f.contents.capturePage).not.toHaveBeenCalled()
    f.owner.dispose()
  })

  it('rejects an over-budget modal as a complete unit and preserves the background page', async () => {
    const f = fixture(), pair = modal()
    f.window.getContentBounds = () => ({ width: 2000, height: 1600 })
    pair[1] = { ...pair[1]!, bounds: { x: 0, y: 0, width: 2000, height: 1500 } }
    expect(await f.owner.update(pair)).toMatchObject({ projected: 0, failures: [{ modalId: 'original-confirmation', message: expect.stringContaining('budget') }] })
    expect(fake.views).toEqual([])
    expect(f.window.contentView.children).toEqual([f.pageView])
    expect(f.pageView.webContents.listenerCount('before-mouse-event')).toBe(0)
    f.owner.dispose()
  })

  it('an over-budget accessory does not interrupt a healthy required modal', async () => {
    const f = fixture()
    f.window.getContentBounds = () => ({ width: 2000, height: 1600 })
    const receipt = await f.owner.update([...modal(), { ...float, id: 'chrome-3', bounds: { x: 0, y: 0, width: 2000, height: 1500 } }])
    expect(receipt).toMatchObject({ projected: 2, warning: expect.stringContaining('budget') })
    expect(receipt.failures).toBeUndefined()
    expect(f.contents.capturePage).toHaveBeenCalledTimes(1)
    f.owner.dispose()
  })

  it('an invalid later publication cannot cancel the already accepted modal preparation', async () => {
    const f = fixture()
    let finish!: (image: { isEmpty(): boolean; toPNG(): Buffer }) => void
    f.contents.capturePage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.owner.update(modal())
    await vi.waitFor(() => expect(f.contents.capturePage).toHaveBeenCalledTimes(1))
    await expect(f.owner.update([{ ...float, radius: -1 }])).rejects.toThrow('geometry')
    finish({ isEmpty: () => false, toPNG: () => Buffer.from('accepted-content') })
    expect(await pending).toMatchObject({ projected: 2 })
    expect(f.window.contentView.children).toHaveLength(3)
    f.owner.dispose()
  })

  it('a close during content preparation immediately releases input and cannot resurrect either member', async () => {
    const f = fixture()
    let finish!: (image: { isEmpty(): boolean; toPNG(): Buffer }) => void
    f.contents.capturePage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.owner.update(modal())
    await vi.waitFor(() => expect(f.contents.capturePage).toHaveBeenCalledTimes(1))
    await f.owner.update([])
    expect(f.pageView.webContents.listenerCount('before-mouse-event')).toBe(0)
    finish({ isEmpty: () => false, toPNG: () => Buffer.from('late-content') })
    expect(await pending).toMatchObject({ projected: 0 })
    expect(f.window.contentView.children).toEqual([f.pageView])
    expect(fake.views).toHaveLength(2)
    expect(fake.views.every(view => view.destroyed)).toBe(true)
    f.owner.dispose()
  })

  it('an asynchronous modal repaint failure removes the whole original group and addresses its recovery', async () => {
    const f = fixture()
    await f.owner.update(modal())
    f.contents.capturePage.mockRejectedValueOnce(new Error('Repaint failed'))
    fake.views[1].listeners['input-event']({}, { type: 'mouseMove', x: 5, y: 7, button: 'none' })
    await vi.waitFor(() => expect(f.warning).toHaveBeenCalledWith(expect.stringContaining('could not be repainted'), 'original-confirmation'))
    expect(f.window.contentView.children).toEqual([f.pageView])
    expect(f.pageView.webContents.listenerCount('before-input-event')).toBe(0)
    expect(await f.owner.refresh()).toEqual({ projected: 0, capturedPixels: 0 })
    f.owner.dispose()
  })

  it('draws one path over the union of actual Browser intersections, with transparent Chrome around it', async () => {
    const f = fixture()
    f.visible.mockReturnValue([{ x: 100, y: 100, width: 600, height: 500 }, { x: 200, y: 200, width: 200, height: 200 }])
    const pair = modal()
    pair[0]!.scrim = 'color(srgb 0 0 0 / 0.45)'
    await f.owner.update(pair)
    const script = fake.views[0].webContents.executeJavaScript.mock.calls[0][0]
    expect(script).toContain('M100,100h600v500h-600ZM200,200h200v200h-200Z')
    expect(script).toContain("path.style.fill=colour")
    expect(script).not.toContain('document.body.style.backgroundColor=')
    expect(script).toContain('color(srgb 0 0 0 / 0.45)')
    f.owner.dispose()
  })

  it('a higher scrim excludes lower opaque native Chrome including its exact rounded coverage', async () => {
    const f = fixture()
    const higher = modal().map((region, index) => ({ ...region, id: `chrome-${index + 3}`, modal: { ...region.modal!, id: 'higher-confirmation' } }))
    await f.owner.update([...modal(), ...higher])
    const script = fake.views[2].webContents.executeJavaScript.mock.calls[0][0]
    expect(script).toContain('<rect x=\\"120\\" y=\\"150\\" width=\\"100\\" height=\\"80\\" rx=\\"8\\" fill=\\"black\\"/>')
    expect(script).toContain("mask.innerHTML=")
    expect(script).toContain('M100,100h600v500h-600Z')
    f.owner.dispose()
  })

  it('a higher modal still dims and guards an actual page contained in a lower Chrome projection', async () => {
    const f = fixture(), lower = modal()
    lower[1] = { ...lower[1]!, bounds: { x: 90, y: 90, width: 620, height: 520 }, browserStages: [{ browserId: 'page', bounds: { ...f.pageView.bounds } }] }
    const higher = modal().map((region, index) => ({ ...region, id: `chrome-${index + 3}`, modal: { ...region.modal!, id: 'higher-confirmation' } }))
    await f.owner.update([...lower, ...higher])
    const script = fake.views[2].webContents.executeJavaScript.mock.calls[0][0]
    expect(script).toContain('<rect x=\\"100\\" y=\\"100\\" width=\\"600\\" height=\\"500\\" fill=\\"white\\"/>')
    const prevent = vi.fn()
    f.pageView.webContents.emit('before-input-event', { preventDefault: prevent }, { key: 'a' })
    expect(prevent).toHaveBeenCalledTimes(1)
    expect(f.owner.forwardBrowserInput(f.nativeOwner('page')!, { type: 'escape' })).toBe(true)
    expect(f.pointer).not.toHaveBeenCalled()
    f.owner.dispose()
  })
})

it('keeps document blur separate from App departure before sibling focus settles', async () => {
  const { owner, window } = fixture()
  expect(owner.hasProjectionInFocusedWindow()).toBe(false)
  await owner.update([float])
  const projection = fake.views.at(-1)
  expect(projection.webContents.isFocused()).toBe(false)
  expect(owner.hasProjectionInFocusedWindow()).toBe(true)
  projection.webContents.isFocused.mockReturnValue(true)
  expect(owner.hasProjectionInFocusedWindow()).toBe(true)
  window.isFocused.mockReturnValue(false)
  expect(owner.hasProjectionInFocusedWindow()).toBe(false)
  window.isFocused.mockReturnValue(true)
  projection.setVisible(false)
  expect(owner.hasProjectionInFocusedWindow()).toBe(false)
  projection.setVisible(true)
  window.contentView.removeChildView(projection)
  expect(owner.hasProjectionInFocusedWindow()).toBe(false)
  window.contentView.addChildView(projection)
  projection.webContents.close()
  expect(owner.hasProjectionInFocusedWindow()).toBe(false)
  owner.dispose()
  expect(owner.hasProjectionInFocusedWindow()).toBe(false)
})

it('keeps attached projection focus separate from a moved frame input readiness', async () => {
  const { owner, window, contents, warning } = fixture()
  let finishContent!: () => void
  let repaint: Promise<unknown> | undefined
  try {
    await owner.update([float])
    const view = fake.views[0]
    fake.image = new Promise(resolve => { finishContent = resolve })
    const moved = { ...float, bounds: { ...float.bounds, x: 200, y: 230 } }
    repaint = owner.update([moved])
    await vi.waitFor(() => expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(2))
    expect(view.getBounds()).toEqual(float.bounds)
    expect(window.contentView.children).toContain(view)
    expect(owner.hasProjectionInFocusedWindow()).toBe(true)
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    view.listeners['input-event']({}, { type: 'mouseUp', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.focus).not.toHaveBeenCalled()
    window.isFocused.mockReturnValue(false)
    expect(owner.hasProjectionInFocusedWindow()).toBe(false)
    window.isFocused.mockReturnValue(true)
    expect(owner.hasProjectionInFocusedWindow()).toBe(true)
    finishContent()
    await repaint
    expect(view.getBounds()).toEqual(moved.bounds)
    expect(owner.hasProjectionInFocusedWindow()).toBe(true)
    await owner.update([])
    expect(owner.hasProjectionInFocusedWindow()).toBe(false)
    expect(warning).not.toHaveBeenCalled()
  } finally {
    finishContent?.()
    await repaint?.catch(() => {})
    owner.dispose()
  }
})

// A separate process observes real unhandled-rejection delivery without changing Vitest's
// own handler. It compiles the current production module; only Electron's native boundary is modeled.
function lateDocumentAfterRemoval(): {
  projected: number; warning: string; views: number; closed: boolean; unhandled: string[]
} {
  const script = String.raw`
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const ts = require('typescript'), { createRequire } = require('node:module');
    const root = process.cwd(), requirePackage = createRequire(path.join(root, 'package.json'));
    const modules = new Map(), views = [], unhandled = [];
    let rejectDocument;
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
      setBorderRadius() { throw new Error('Original native radius rejected') }
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
            throw new Error('Unexpected attachment before document readiness');
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
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
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
    expect(window.contentView.addChildView.mock.calls.map(call => call[0])).toEqual([fake.views[0], inside])
    const origin = nativeOwner('inside') as any
    owner.forwardBrowserInput(origin, { type: 'pointer', event: { type: 'mouseMove', x: 20, y: 20 } })
    expect(pointer.mock.calls).toEqual([[{ type: 'pointerMove', browserId: 'inside', overlayId: 'chrome-1', x: 120, y: 144, button: 0 }]])
    expect(owner.forwardBrowserInput(origin, { type: 'escape' })).toBe(true)
    expect(pointer.mock.calls.at(-1)).toEqual([{ type: 'escape', browserId: 'inside', overlayId: 'chrome-1' }])
    window.contentView.addChildView.mockClear()
    const later = { id: 'chrome-2', bounds: { x: 140, y: 170, width: 30, height: 30 }, radius: 2 }
    expect(await owner.update([containing, later])).toEqual({ projected: 2, capturedPixels: 8900 })
    expect(window.contentView.children).toEqual([pageView, unrelated, fake.views[0], inside, fake.views[1]])
    expect(window.contentView.addChildView.mock.calls.map(call => call[0])).toEqual([fake.views[1]])
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
    expect(window.contentView.addChildView.mock.calls.map(call => call[0])).toEqual([fake.views[0]])
    expect(owner.forwardBrowserInput({ browserId: 'inside', bounds: inside.getBounds(), view: inside } as any, { type: 'escape' })).toBe(false)
    expect(pointer).not.toHaveBeenCalled()
    owner.dispose()
  })
  it('consumes a removed owner document rejection after synchronous geometry failure', () => {
    const result = lateDocumentAfterRemoval()
    expect(result.views).toBe(1)
    expect(result.closed).toBe(true)
    expect(result.projected).toBe(0)
    expect(result.warning).toContain('Chrome geometry: Original native radius rejected')
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
  it('cleans a rejected first native attachment without leaving empty Chrome over a healthy page', async () => {
    const { owner, window, contents } = fixture()
    window.contentView.addChildView.mockImplementationOnce(() => { throw new Error('Native child attachment rejected') })
    await expect(owner.update([float])).resolves.toMatchObject({ projected: 0, warning: expect.stringContaining('Chrome attachment: Native child attachment rejected') })
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(view.ownerWindow).toBeNull()
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(contents.focus).not.toHaveBeenCalled()
    owner.dispose()
  })
  it('synchronizes scheduling once on the attached loaded owner before image preparation, never during subsequent paints', async () => {
    let finishDocument!: () => void, finishContent!: () => void
    fake.load = new Promise(resolve => { finishDocument = resolve })
    fake.image = new Promise(resolve => { finishContent = resolve })
    const { owner, window, contents } = fixture()
    const pending = owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(view.ownerWindow).toBeNull()
    expect(view.getBounds()).toEqual(float.bounds)
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(contents.capturePage).not.toHaveBeenCalled()
    finishDocument()
    await vi.waitFor(() => expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(1))
    expect(view.documentLoaded).toBe(true)
    expect(view.contentLoaded).toBe(false)
    expect(view.webContents.setBackgroundThrottling).toHaveBeenCalledExactlyOnceWith(false)
    finishContent()
    expect(await pending).toEqual({ projected: 1, capturedPixels: 8000 })
    expect(view.syncStates).toEqual([{ value: false, ownerWindow: window,
      bounds: { ...float.bounds, x: -float.bounds.width, y: -float.bounds.height },
      visible: true, documentLoaded: true, contentLoaded: false }])
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(await owner.refresh()).toEqual({ projected: 1, capturedPixels: 8000 })
    expect(await owner.update([{ ...float, bounds: { ...float.bounds, x: 200 } }])).toEqual({ projected: 1, capturedPixels: 8000 })
    expect(contents.focus).not.toHaveBeenCalled()
    view.listeners['input-event']({}, { type: 'keyDown', key: 'Escape', modifiers: [] })
    await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledTimes(4))
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(fake.views).toHaveLength(1)
    expect(view.setVisible.mock.calls).toEqual([[true]])
    expect(contents.focus).toHaveBeenCalledOnce()
    owner.dispose()
  })
  it('synchronizes the attached Chrome scheduler before waiting for an offscreen decoder', async () => {
    let releaseDecoder!: () => void
    fake.image = new Promise(resolve => { releaseDecoder = resolve })
    const { owner, window, contents, pageView } = fixture()
    const pending = owner.update([float])
    const view = fake.views[0]
    const synchronize = view.webContents.setBackgroundThrottling.getMockImplementation()!
    view.webContents.setBackgroundThrottling.mockImplementation((allowed: boolean) => {
      synchronize(allowed)
      if (!allowed && view.ownerWindow === window && view.getBounds().x < 0 && view.documentLoaded) releaseDecoder()
    })
    try {
      expect(await pending).toEqual({ projected: 1, capturedPixels: 8000 })
      expect(view.syncStates).toEqual([{ value: false, ownerWindow: window,
        bounds: { ...float.bounds, x: -float.bounds.width, y: -float.bounds.height },
        visible: true, documentLoaded: true, contentLoaded: false }])
      expect(view.contentLoaded).toBe(true)
      expect(view.getBounds()).toEqual(float.bounds)
      expect(contents.focus).not.toHaveBeenCalled()
      expect(pageView.webContents.sendInputEvent).not.toHaveBeenCalled()
    } finally { releaseDecoder(); await pending; owner.dispose() }
  })
  it.each(['document', 'image'] as const)('does not swallow an original menu gesture while its cold %s paint is pending', async phase => {
    let finishPaint!: () => void
    const held = new Promise<void>(resolve => { finishPaint = resolve })
    if (phase === 'document') fake.load = held
    else fake.image = held
    const { owner, window, contents, pageView } = fixture()
    const pending = owner.update([float])
    try {
      if (phase === 'image') await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledTimes(1))
      expect(fake.views).toHaveLength(1)
      const view = fake.views[0], point = { x: 5, y: 7 }
      expect(view.ownerWindow).toBe(phase === 'image' ? window : null)
      expect(view.getVisible()).toBe(true)
      // Attachment establishes same-window focus ownership, not paint or input readiness.
      expect(owner.hasProjectionInFocusedWindow()).toBe(phase === 'image')
      if (phase === 'image') {
        const preparing = view.getBounds()
        expect(preparing.x + preparing.width).toBeLessThanOrEqual(0)
        expect(preparing.y + preparing.height).toBeLessThanOrEqual(0)
      }
      const input = (type: 'mouseDown' | 'mouseUp') => ({ type, ...point, button: 'left', clickCount: 1 })
      const originalInput = (type: 'mouseDown' | 'mouseUp') => ({ ...input(type), x: float.bounds.x + point.x, y: float.bounds.y + point.y })
      const intercepted = window.contentView.children.includes(view) && view.getVisible() &&
        view.getBounds().x === float.bounds.x && view.getBounds().y === float.bounds.y &&
        view.getBounds().width === float.bounds.width && view.getBounds().height === float.bounds.height
      expect(view.contentLoaded).toBe(false)
      // Model only the native boundary, using the existing owner fixture. An unready layer
      // may remain out of the hit path; if it covers this exact original menu, its real
      // production input handler must carry the complete gesture without awaiting paint.
      if (intercepted) {
        view.listeners['input-event']({}, input('mouseDown'))
        view.listeners['input-event']({}, input('mouseUp'))
      }
      const whilePending = contents.sendInputEvent.mock.calls.map(([event]) => event)
      finishPaint()
      expect(await pending).toEqual({ projected: 1, capturedPixels: 8000 })
      expect(view.contentLoaded).toBe(true)
      expect(pageView.webContents.sendInputEvent).not.toHaveBeenCalled()
      expect(pageView.webContents.focus).not.toHaveBeenCalled()
      expect(pageView.webContents.close).not.toHaveBeenCalled()
      expect(whilePending, 'an attached exact menu layer must not swallow down/up while paint is pending')
        .toEqual(intercepted ? [originalInput('mouseDown'), originalInput('mouseUp')] : [])
      // Readiness cannot replay a previously intercepted click a second time.
      expect(contents.sendInputEvent.mock.calls.map(([event]) => event)).toEqual(whilePending)
      await owner.update([])
      contents.sendInputEvent.mockClear()
      view.listeners['input-event']({}, input('mouseDown'))
      view.listeners['input-event']({}, input('mouseUp'))
      expect(contents.sendInputEvent, 'the revoked native owner cannot dispatch into the original menu').not.toHaveBeenCalled()
    } finally {
      finishPaint()
      await pending
      owner.dispose()
    }
  })
  it('does not attach a pending owner while another attached float repaints', async () => {
    const { owner, window, contents } = fixture()
    await owner.update([float])
    const first = fake.views[0]
    let finishDocument!: () => void
    fake.load = new Promise<void>(resolve => { finishDocument = resolve })
    const second = { ...float, id: 'chrome-2', bounds: { ...float.bounds, x: 300 } }
    const pending = owner.update([float, second])
    try {
      await vi.waitFor(() => expect(fake.views).toHaveLength(2))
      const cold = fake.views[1]
      expect(cold.ownerWindow).toBeNull()
      first.listeners['input-event']({}, { type: 'mouseMove', x: 5, y: 7, button: 'none' })
      await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledTimes(3))
      expect(window.contentView.children).toContain(first)
      expect(window.contentView.children).not.toContain(cold)
      expect(cold.ownerWindow).toBeNull()
      expect(window.contentView.addChildView.mock.calls.map(([view]) => view)).toEqual([first])
      finishDocument()
      expect(await pending).toEqual({ projected: 2, capturedPixels: 16000 })
      expect(window.contentView.children).toEqual([expect.anything(), first, cold])
      expect(window.contentView.addChildView.mock.calls.map(([view]) => view)).toEqual([first, cold])
    } finally { finishDocument(); await pending; owner.dispose() }
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
    expect(view.webContents.setBackgroundThrottling).toHaveBeenCalledExactlyOnceWith(false)
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    finishContent()
    expect(await pending).toEqual({ projected: 0, capturedPixels: 8000 })
    expect(view.webContents.setBackgroundThrottling).toHaveBeenCalledExactlyOnceWith(false)
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
  it('prepares actual clipped geometry before loading and attaches its prepared pixels once', async () => {
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
    expect(view.loadStates[0].ownerWindow).toBeNull()
    expect(view.loadStates[0].bounds).toEqual(actual)
    expect(view.loadStates[0].visible).toBe(true)
    expect(view.ownerWindow).toBe(window)
    expect(view.contentLoaded).toBe(true)
    expect(window.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(view)
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
    view.listeners['input-event']({}, { type: 'keyDown', key: 'Escape', modifiers: [] })
    expect(contents.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
      { type: 'mouseDown', x: 125, y: 157, button: 'left' },
      { type: 'mouseUp', x: 205, y: 157, button: 'left' }, { type: 'keyDown', keyCode: 'Escape', modifiers: [] }
    ])
    owner.dispose()
  })
  it.each([
    ['rawKeyDown', 'Escape', 'Escape', []], ['keyUp', 'Escape', 'Escape', []],
    ['rawKeyDown', 'ArrowDown', 'Down', ['shift']], ['keyUp', 'ArrowLeft', 'Left', ['meta']],
    ['rawKeyDown', 'Tab', 'Tab', ['shift']], ['char', 'a', 'a', []]
  ])('converts actual Electron %s key %s into the original injectable protocol', async (type, key, keyCode, modifiers) => {
    const { owner, contents } = fixture()
    await owner.update([float])
    fake.views[0].listeners['input-event']({}, { type, key, modifiers })
    expect(contents.sendInputEvent).toHaveBeenCalledExactlyOnceWith({ type, keyCode, modifiers })
    expect(contents.focus).toHaveBeenCalledOnce()
    expect(contents.focus.mock.invocationCallOrder[0]).toBeLessThan(contents.sendInputEvent.mock.invocationCallOrder[0])
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
  it('keeps new clicks and keyboard input available while the confirmed same-position owner repaints', async () => {
    const { owner, contents } = fixture()
    let finishContent: (() => void) | undefined
    let repaint: Promise<unknown> | undefined
    try {
      await owner.update([float])
      const view = fake.views[0]
      fake.image = new Promise(resolve => { finishContent = resolve })
      repaint = owner.update([{ ...float, bounds: { ...float.bounds } }])
      await vi.waitFor(() => expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(2))
      view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
      view.listeners['input-event']({}, { type: 'mouseUp', x: 5, y: 7, button: 'left' })
      view.listeners['input-event']({}, { type: 'keyDown', key: 'Escape', modifiers: [] })
      expect(contents.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
        { type: 'mouseDown', x: 125, y: 157, button: 'left' },
        { type: 'mouseUp', x: 125, y: 157, button: 'left' },
        { type: 'keyDown', keyCode: 'Escape', modifiers: [] }
      ])
      finishContent!()
      expect(await repaint).toEqual({ projected: 1, capturedPixels: 8000 })
      expect(view.getBounds()).toEqual(float.bounds)
    } finally {
      finishContent?.()
      await repaint?.catch(() => {})
      owner.dispose()
    }
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
      view.listeners['input-event']({}, { type: 'keyDown', key: 'Escape', modifiers: [] })
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
    expect(owner.hasProjectionInFocusedWindow()).toBe(false)
    expect(fake.views).toHaveLength(1)
    expect(fake.views[0].webContents.close).toHaveBeenCalledTimes(1)
  })
  it('settles overlapping image preparations independently and retains the newest decoded frame', async () => {
    const { owner, contents, warning } = fixture()
    await owner.update([float])
    const view = fake.views[0]
    const requests: { image: Image; source: string; finish(): void }[] = []
    class Image {
      style = {}; alt = ''; onload?: () => void; onerror?: () => void
      current?: typeof requests[number]
      private decoded = Promise.resolve()
      setAttribute() {}
      set src(source: string) {
        let decoded!: () => void
        this.decoded = new Promise(resolve => { decoded = resolve })
        const request = { image: this, source, finish: () => {
          // A later src cancels the earlier image request; its replaced load handler
          // cannot settle the earlier caller. Independent Image objects do settle.
          if (this.current !== request) return
          decoded(); this.onload?.()
        } }
        requests.push(request); this.current = request
      }
      decode() { return this.decoded }
      replaceWith(image: Image) { displayed = image }
    }
    let displayed = new Image()
    const svg = { style: {} }
    const context = { Image, document: { documentElement: { dataset: {} },
      createElement: () => new Image(), querySelector: (selector: string) => selector === 'img' ? displayed : svg } }
    view.webContents.executeJavaScript.mockImplementation((script: string) => runInNewContext(script, context))
    contents.capturePage.mockResolvedValueOnce({ isEmpty: () => false, toPNG: () => Buffer.from('older-frame') })
    contents.capturePage.mockResolvedValueOnce({ isEmpty: () => false, toPNG: () => Buffer.from('newer-frame') })
    const updating = owner.update([float])
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      view.listeners['input-event']({}, { type: 'mouseMove', x: 5, y: 7, button: 'none' })
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      requests[1]!.finish()
      requests[0]!.finish()
      expect(await updating).toEqual({ projected: 1, capturedPixels: 8000 })
      expect(warning).not.toHaveBeenCalled()
      expect(displayed.current?.source).toContain(Buffer.from('newer-frame').toString('base64'))
      expect(view.webContents.close).not.toHaveBeenCalled()
      expect(view.getBounds()).toEqual(float.bounds)
    } finally {
      owner.dispose()
      for (const request of requests) request.finish()
      await updating
    }
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
    expect(owner.hasProjectionInFocusedWindow()).toBe(false)
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
