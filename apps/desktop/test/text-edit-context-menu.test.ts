import { EventEmitter } from 'node:events'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { Window as DomWindow } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ menus: [] as any[], contents: [] as any[], focused: null as any, frames: new Map<any, any>(), failMenu: false }))
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (items: any[]) => {
    if (native.failMenu) throw new Error('native menu unavailable')
    const menu = { items, options: undefined as any, closed: false,
      popup(options: any) { this.options = options }, closePopup() { this.closed = true; this.options?.callback?.() } }
    native.menus.push(menu); return menu
  } },
  webContents: { getFocusedWebContents: () => native.focused, fromFrame: (frame: any) => native.frames.get(frame) },
  WebContentsView: class {
    webContents = new Contents(); visible = false; bounds = { x: 0, y: 0, width: 500, height: 400 }
    constructor() { native.contents.push(this.webContents) }
    setVisible(value: boolean) { this.visible = value }; getVisible() { return this.visible }
    setBounds(value: typeof this.bounds) { this.bounds = value }; getBounds() { return this.bounds }
  }
}))
import { installTextEditContextMenu } from '../src/main/text-edit-context-menu.js'
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'

const doms: Array<{ window: DomWindow }> = [], disposers: Array<() => void> = [], roots: string[] = []
let frameId = 0
class Frame {
  parent: Frame | null = null; detached = false; destroyed = false; frameToken = `frame-${++frameId}`
  evaluateHook: ((code: string) => Promise<unknown>) | undefined
  readonly dom = { window: new DomWindow({ url: 'https://generic.invalid/' }) }
  constructor() { this.dom.window.document.body.innerHTML = '<input id="original"><input id="other"><textarea id="textarea"></textarea><div id="editable" tabindex="0">editable text</div><p id="text">Selected plain text</p>'; doms.push(this.dom) }
  isDestroyed() { return this.destroyed }
  executeJavaScript(code: string): Promise<unknown> { return this.evaluateHook ? this.evaluateHook(code) : Promise.resolve(this.dom.window.eval(code)) }
  input(id = 'original') { return this.dom.window.document.getElementById(id) as unknown as HTMLInputElement }
}
class Contents extends EventEmitter {
  destroyed = false; mainFrame = new Frame(); focusedFrame = this.mainFrame; url = 'https://generic.invalid/'
  session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }); commands: string[] = []
  navigationHistory = { canGoBack: () => false, canGoForward: () => false }
  constructor() { super(); native.frames.set(this.mainFrame, this) }
  isDestroyed() { return this.destroyed }; getURL() { return this.url }; getTitle() { return 'Page' }; isLoading() { return false }
  getZoomFactor() { return 1 }; setZoomFactor() {}; setBackgroundThrottling() {}; getBackgroundThrottling() { return true }
  setWindowOpenHandler() {}; enableDeviceEmulation() {}; disableDeviceEmulation() {}; executeJavaScriptInIsolatedWorld() { return Promise.resolve(true) }
  async loadURL(url: string) { this.url = url; this.emit('did-start-navigation', { isMainFrame: true, frame: this.mainFrame, url }); this.emit('did-finish-load') }
  close() { this.destroyed = true; this.emit('destroyed') }
  copy() { this.commands.push('copy') }; cut() { this.commands.push('cut') }; paste() { this.commands.push('paste') }; selectAll() { this.commands.push('selectAll') }
}
class Window extends EventEmitter {
  destroyed = false; visible = true; minimized = false; focused = true
  webContents = { send: vi.fn(), isDestroyed: () => false, commands: [] as string[],
    copy() { this.commands.push('copy') }, cut() { this.commands.push('cut') }, paste() { this.commands.push('paste') }, selectAll() { this.commands.push('selectAll') } }
  contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
  isDestroyed() { return this.destroyed }; isVisible() { return this.visible }; isMinimized() { return this.minimized }; isFocused() { return this.focused }
}
const flush = async () => { for (let i = 0; i < 9; i++) await Promise.resolve() }
function params(frame: Frame, overrides: any = {}) {
  return { frame, x: 21, y: 34, isEditable: true, selectionText: '', editFlags: { canCopy: true, canCut: true, canPaste: true, canSelectAll: true }, ...overrides }
}
function fixture() {
  const contents = new Contents(), window = new Window(), owner = { current: true }
  contents.mainFrame.input().focus(); native.focused = contents
  disposers.push(installTextEditContextMenu(contents as never, window as never, { isCurrent: () => owner.current, origin: () => ({ x: 50, y: 60 }) }))
  return { contents, window, owner, frame: contents.mainFrame }
}
async function open(f: ReturnType<typeof fixture>, overrides: any = {}) {
  const before = native.menus.length
  f.contents.emit('context-menu', {}, params(f.frame, overrides)); await flush()
  expect(native.menus.length).toBeGreaterThan(before)
  return native.menus.at(-1)!
}
async function click(menu: any, label: string) {
  const item = menu.items.find((entry: any) => entry.label === label)
  expect(item).toBeDefined(); item.click(); menu.options.callback?.(); await flush()
}
beforeEach(() => { native.menus.length = 0; native.contents.length = 0; native.frames.clear(); native.focused = null; native.failMenu = false })
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); for (const dom of doms.splice(0)) dom.window.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true }); vi.restoreAllMocks() })

describe('actual native edit-menu Source with real local DOM identity scripts', () => {
  it('targets original contents for all four native commands, preserves caret, and binds popup coordinates/frame', async () => {
    const f = fixture(), original = f.frame.input()
    // HappyDOM derives selection offsets by reading value; native Chromium exposes offsets directly.
    Object.defineProperties(original, { selectionStart: { value: 0 }, selectionEnd: { value: 0 } })
    Object.defineProperty(original, 'value', { get() { throw new Error('secret value must not be read') } })
    for (const label of ['Copy', 'Cut', 'Paste', 'Select All']) {
      const menu = await open(f); expect(menu.options).toMatchObject({ window: f.window, frame: f.frame, x: 71, y: 94 })
      await click(menu, label); expect(f.frame.dom.window.document.activeElement).toBe(original)
    }
    expect(f.contents.commands).toEqual(['copy', 'cut', 'paste', 'selectAll'])
    expect(f.window.webContents.commands).toEqual([])
    expect(Object.keys(f.frame.dom.window).filter(key => key.startsWith('__agentmuxTextEdit_'))).toEqual([])
  })
  it('derives disabled actions from real editFlags and does not execute a forced disabled callback', async () => {
    const f = fixture(), menu = await open(f, { editFlags: { canCopy: true, canCut: false, canPaste: false, canSelectAll: true } })
    expect(menu.items.map((item: any) => [item.label, item.enabled])).toEqual([['Cut', false], ['Copy', true], ['Paste', false], ['Select All', true]])
    await click(menu, 'Cut'); await click(menu, 'Paste'); expect(f.contents.commands).toEqual([])
  })
  it('noneditable real selection has only Copy, including a nonempty whitespace selection', async () => {
    const f = fixture(), doc = f.frame.dom.window.document, node = doc.getElementById('text')!.firstChild!
    const range = doc.createRange(); range.selectNodeContents(node); const selection = doc.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const menu = await open(f, { isEditable: false, selectionText: ' ' })
    expect(menu.items.map((item: any) => item.label)).toEqual(['Copy']); await click(menu, 'Copy'); expect(f.contents.commands).toEqual(['copy'])
  })
  it('empty noneditable selection does not build a menu', async () => {
    const f = fixture(); f.contents.emit('context-menu', {}, params(f.frame, { isEditable: false, selectionText: '' })); await flush()
    expect(native.menus).toEqual([]); expect(f.contents.commands).toEqual([])
  })
  it('textarea and contenteditable preserve native editing without DOM assignments', async () => {
    for (const id of ['textarea', 'editable']) {
      const f = fixture(), target = f.frame.input(id); if (id === 'editable') Object.defineProperty(target, 'isContentEditable', { value: true })
      target.focus(); const menu = await open(f); await click(menu, 'Paste'); expect(f.contents.commands).toEqual(['paste'])
    }
  })
  it('password editing follows native flags and never reads its value', async () => {
    const f = fixture(), target = f.frame.input(); target.type = 'password'
    Object.defineProperties(target, { selectionStart: { value: 0 }, selectionEnd: { value: 0 } })
    Object.defineProperty(target, 'value', { get() { throw new Error('password access') } })
    const menu = await open(f, { editFlags: { canCopy: false, canCut: false, canPaste: true, canSelectAll: true } })
    await click(menu, 'Paste'); expect(f.contents.commands).toEqual(['paste'])
  })
  it('same frame changed input invalidates the original menu, even if focus returns', async () => {
    const f = fixture(), menu = await open(f); f.frame.input('other').focus(); f.frame.input().focus()
    await click(menu, 'Cut'); expect(f.contents.commands).toEqual([])
    expect(native.menus.at(-1).items[0].label).toContain('changed or unavailable')
  })
  it('changed caret/selection in the same input invalidates the old selection', async () => {
    const f = fixture(); f.frame.input().setSelectionRange(0, 0); const menu = await open(f)
    // selectionDirection/offset are local metadata; the actual input text is not copied into the helper.
    f.frame.input().value = 'fixture'; f.frame.input().setSelectionRange(1, 2)
    await click(menu, 'Copy'); expect(f.contents.commands).toEqual([])
  })
  it('a newly focused WebContents cannot receive the original menu action', async () => {
    const f = fixture(), menu = await open(f), other = new Contents(); native.focused = other
    await click(menu, 'Paste'); expect(f.contents.commands).toEqual([]); expect(other.commands).toEqual([])
  })
  it('changed owner invalidates the old menu without restoring focus', async () => {
    const f = fixture(), menu = await open(f); f.owner.current = false
    await click(menu, 'Cut'); expect(f.contents.commands).toEqual([]); expect(native.focused).toBe(f.contents)
  })
  it('navigation cancels before a delayed local identity result can act on a new document', async () => {
    const f = fixture(), menu = await open(f); let release!: (value: unknown) => void
    f.frame.evaluateHook = code => code.includes('check()') ? new Promise(resolve => { release = resolve }) : Promise.resolve(true)
    menu.items.find((item: any) => item.label === 'Paste').click(); await flush()
    f.contents.emit('did-start-navigation', { isMainFrame: true, frame: f.frame }); release(true); await flush()
    expect(f.contents.commands).toEqual([]); expect(menu.closed).toBe(true)
  })
  it('rechecks actual native frame focus after awaiting local identity', async () => {
    const f = fixture(), menu = await open(f), other = new Frame()
    f.frame.evaluateHook = async code => { if (code.includes('check()')) f.contents.focusedFrame = other; return true }
    await click(menu, 'Copy'); expect(f.contents.commands).toEqual([])
  })
  it('lost OS window focus during identity await prevents both native edit and a notice popup', async () => {
    const f = fixture(), menu = await open(f)
    f.frame.evaluateHook = async code => { if (code.includes('check()')) f.window.focused = false; return true }
    await click(menu, 'Paste'); expect(f.contents.commands).toEqual([]); expect(native.menus).toHaveLength(1)
  })
  it.each(['mouseDown', 'keyDown'])('later native %s before deferred capture cannot relabel another input as the original target', async (type) => {
    const f = fixture(); let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    f.frame.evaluateHook = async code => {
      if (code.includes('const active =')) await waiting
      return f.frame.dom.window.eval(code)
    }
    f.contents.emit('context-menu', {}, params(f.frame)); await flush()
    f.frame.input('other').focus()
    if (type === 'mouseDown') f.contents.emit('input-event', {}, { type })
    else f.contents.emit('before-input-event', {}, { type, key: 'Tab' })
    release(); await flush()
    const menu = native.menus.at(-1)
    if (menu?.items.some((item: any) => item.label === 'Copy')) await click(menu, 'Copy')
    expect(f.contents.commands).toEqual([]); expect(native.menus).toEqual([])
  })
  it('the original context-menu mouseUp and an ordinary mouseMove do not cancel its deferred capture', async () => {
    const f = fixture(); let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    f.frame.evaluateHook = async code => { if (code.includes('const active =')) await waiting; return f.frame.dom.window.eval(code) }
    f.contents.emit('context-menu', {}, params(f.frame)); await flush()
    f.contents.emit('input-event', {}, { type: 'mouseUp' }); f.contents.emit('input-event', {}, { type: 'mouseMove' })
    release(); await flush(); const menu = native.menus.at(-1)
    expect(menu?.items.map((item: any) => item.label)).toEqual(['Cut', 'Copy', 'Paste', 'Select All'])
    await click(menu, 'Copy'); expect(f.contents.commands).toEqual(['copy'])
  })
  it('a detached actual child frame and its ancestor navigation cancel only that menu', async () => {
    const f = fixture(), child = new Frame(); child.parent = f.frame; child.input().focus(); native.frames.set(child, f.contents); f.contents.focusedFrame = child
    f.contents.emit('context-menu', {}, params(child)); await flush(); const menu = native.menus.at(-1)
    expect(menu.options.frame).toBe(child); f.contents.emit('did-start-navigation', { isMainFrame: true, frame: f.frame }); await click(menu, 'Copy')
    expect(f.contents.commands).toEqual([])
    f.contents.emit('context-menu', {}, params(child)); await flush(); const next = native.menus.at(-1); child.detached = true; await click(next, 'Paste')
    expect(f.contents.commands).toEqual([])
  })
  it('does not let a duplicate callback or popup-close ordering execute twice', async () => {
    const f = fixture(), menu = await open(f); const item = menu.items.find((entry: any) => entry.label === 'Copy')
    item.click(); item.click(); menu.options.callback(); await flush(); expect(f.contents.commands).toEqual(['copy'])
  })
  it('unknown local editable target gives a disabled local notice and leaves native actions untouched', async () => {
    const f = fixture(); (f.frame.dom.window.document.activeElement as unknown as HTMLElement).blur(); const menu = await open(f)
    expect(menu.items).toHaveLength(1); expect(menu.items[0].enabled).toBe(false); expect(f.contents.commands).toEqual([])
  })
  it('disposing the contents releases only its pending menu and DOM listeners', async () => {
    const f = fixture(), menu = await open(f); f.contents.close(); await click(menu, 'Cut')
    expect(f.contents.commands).toEqual([]); expect(f.contents.listenerCount('context-menu')).toBe(0)
  })
})

describe('actual definition-external consumers', () => {
  it('executes the exact renderer-host registration call from current Main Source', () => {
    const source = readFileSync(process.env.AGENTMUX_TEXT_EDIT_MUTATION_ROOT
      ? join(process.env.AGENTMUX_TEXT_EDIT_MUTATION_ROOT, 'apps/desktop/src/main/index.ts')
      : new URL('../src/main/index.ts', import.meta.url), 'utf8')
    const calls = source.match(/^    installTextEditContextMenu\(window.webContents, window, .*$/gm) ?? []
    expect(calls).toHaveLength(1)
    const contents = new Contents(), window = new Window(); window.webContents = contents as any
    runInNewContext(calls[0]!, { installTextEditContextMenu, window, workbenchWindow: window })
    expect(contents.listenerCount('context-menu')).toBe(1); contents.close()
  })
  it('actual BVM attaches to each original page and refuses its hidden native owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentmux-text-edit-test-')); roots.push(root)
    const window = new Window(), manager = new BrowserViewManager(window as never,
      { defaultProfileId: () => 'profile', resolvePartition: () => 'persist:text-edit' }, new BrowserRefLedgerStore(join(root, 'refs.json')),
      { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
    disposers.push(() => manager.dispose())
    await manager.create('original-browser', 'https://generic.invalid/', 'workspace')
    await manager.create('unrelated-browser', 'https://other.invalid/', 'workspace')
    const [contents, unrelated] = native.contents; expect(contents.listenerCount('context-menu')).toBe(1); expect(unrelated.listenerCount('context-menu')).toBe(1)
    contents.mainFrame.input().focus(); native.focused = contents; manager.setBounds('original-browser', { x: 40, y: 50, width: 500, height: 400 })
    contents.emit('context-menu', {}, params(contents.mainFrame)); await flush(); const menu = native.menus.at(-1)
    expect(menu.options.x).toBe(61); expect(unrelated.commands).toEqual([])
    await click(menu, 'Copy'); expect(contents.commands).toEqual(['copy']); expect(window.webContents.commands).toEqual([])
    contents.emit('context-menu', {}, params(contents.mainFrame)); await flush(); const next = native.menus.at(-1)
    manager.setBounds('original-browser', null); await click(next, 'Paste'); expect(contents.commands).toEqual(['copy'])
  })
})
