import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'
import { beginOwnDispatch, isOwnDispatch } from '../src/main/browser-own-dispatch.js'
import { BrowserLocalRecoveryFailure } from '../src/main/browser-local-recovery.js'
import { BrowserDemonstrationCapture } from '../src/main/browser-demonstration-capture.js'
import { BrowserDemonstrationRecorder } from '../src/main/browser-demonstration-recorder.js'
import type { BrowserDemonstrationDocument } from '../src/shared/browser-demonstration.js'
import type { BrowserPageTransport } from '../src/main/browser-page-transport.js'

/**
 * Agent page actions are trusted native input, and Main alone says who sent them.
 *
 * Two halves, each against the real owner:
 * - the real dispatcher sends `Input.dispatchMouseEvent` at the proven box, refuses covered targets
 *   before any input, and wraps every `Input.*` command in Main's own-dispatch receipt;
 * - the real BrowserViewManager and demonstration capture ask that receipt before they treat an
 *   `input-event` as a person's, so Agent input clears no feedback, marks no document use, forwards
 *   nothing to native chrome and records no demonstration, while a person's input still does.
 */

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''; destroyed = false; throttling = true; captures = 0
    session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {} })
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    getURL() { return this.url } getTitle() { return 'Native input page' }
    isLoading() { return false } isDestroyed() { return this.destroyed }
    getBackgroundThrottling() { return this.throttling }
    setBackgroundThrottling(value: boolean) { this.throttling = value }
    async capturePage() { this.captures += 1; return { isEmpty: () => true } }
    setWindowOpenHandler() {} setZoomFactor() {} getZoomFactor() { return 1 }
    disableDeviceEmulation() {} enableDeviceEmulation() {}
    async executeJavaScriptInIsolatedWorld() { return true }
    async loadURL(url: string) {
      // The same native sequence as a committed main-frame load, so the initial document settles.
      this.emit('did-start-navigation', { url, isSameDocument: false, isMainFrame: true })
      this.emit('did-start-loading')
      this.url = url
      this.emit('did-navigate', {}, url)
      this.emit('dom-ready')
      this.emit('did-finish-load')
      this.emit('did-stop-loading')
    }
    close() { this.destroyed = true; this.emit('destroyed', {}) }
  }
  return { WebContentsView: class {
    webContents = new Contents()
    visible = false
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    setVisible(value: boolean) { this.visible = value } setBounds(value: typeof this.bounds) { this.bounds = value }
    getVisible() { return this.visible } getBounds() { return this.bounds }
  } }
})

const { BrowserViewManager } = await import('../src/main/browser-view-manager.js')
const { BrowserRefLedgerStore } = await import('../src/main/browser-ref-ledger-store.js')

type Command = { method: string; params: Record<string, any> }

/**
 * A CDP peer for one top-level document. Its geometry answers come from what the test says is on top
 * at the click point; it never decides the outcome by looking at our declarations.
 */
function pagePeer(options: { topmost?: 'target' | 'cover'; landed?: boolean } = {}) {
  const commands: Command[] = []
  let onInput: ((command: Command) => void) | undefined
  const peer = {
    commands,
    topmost: options.topmost ?? 'target',
    landed: options.landed ?? true,
    onInput(listener: (command: Command) => void) { onInput = listener },
    session: {
      sendCommand: async (method: string, params: Record<string, any> = {}) => {
        commands.push({ method, params })
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame', loaderId: 'document-1' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', backendDOMNodeId: 11, role: { value: 'button' }, name: { value: 'Continue' }, childIds: [] }] }
        if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
        if (method === 'DOM.resolveNode') return { object: { objectId: params.executionContextId ? `isolated-${params.backendNodeId}` : `main-${params.backendNodeId}` } }
        if (method === 'DOM.getContentQuads') return { quads: [[100, 40, 180, 40, 180, 70, 100, 70]] }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: peer.topmost === 'target' ? 11 : 99, frameId: 'main-frame' }
        if (method === 'Runtime.callFunctionOn') {
          const declaration = String(params.functionDeclaration)
          // Hit ownership: the page answers whether the node at the point belongs to the target.
          if (declaration.includes('labels')) return { result: { value: params.arguments?.[0]?.objectId === 'isolated-11' } }
          if (declaration.includes(':hover')) return { result: { value: peer.landed } }
          return { result: { value: null } }
        }
        if (method.startsWith('Input.')) { onInput?.({ method, params }); return {} }
        return {}
      },
      frames: new Map(), endedReason: null, frameDiscoveryFailure: null, observe: () => () => {}
    } as unknown as BrowserPageTransport
  }
  return peer
}

function dispatchOn(peer: ReturnType<typeof pagePeer>, contents?: WebContents) {
  const nativeInput = contents ? vi.fn(async () => beginOwnDispatch(contents)) : undefined
  const dispatch = createBrowserPageDispatch({
    session: peer.session,
    pageInfo: () => ({ url: 'https://page.invalid/', title: 'Page', navigationId: 'nav-1' }),
    gotoUrl: async () => {}, captureScreenshot: async () => ({}), readLedger: async () => null,
    writeLedger: async () => {}, note: () => {},
    ...(nativeInput ? { beginNativeInput: nativeInput } : {})
  })
  return { dispatch, nativeInput }
}

const inputs = (peer: ReturnType<typeof pagePeer>) => peer.commands.filter(command => command.method.startsWith('Input.'))
  .map(command => [command.params.type, command.params.x, command.params.y, command.params.clickCount ?? 0])

/** A stand-in WebContents carrying only what the own-dispatch receipt reads. */
function nativeContents(): WebContents & { throttling: boolean; captures: number } {
  const contents = {
    throttling: true, captures: 0,
    isDestroyed: () => false,
    getBackgroundThrottling() { return contents.throttling },
    setBackgroundThrottling(value: boolean) { contents.throttling = value },
    capturePage: async () => { contents.captures += 1 }
  }
  return contents as unknown as WebContents & { throttling: boolean; captures: number }
}

describe('Agent click is one trusted native press at the proven box', () => {
  it('moves, presses and releases once at the box centre, after scrolling, under Main’s receipt', async () => {
    const peer = pagePeer(), contents = nativeContents()
    const seen: boolean[] = []
    peer.onInput(command => seen.push(isOwnDispatch(contents, { type: command.params.type === 'mouseMoved' ? 'mouseMove' : command.params.type === 'mousePressed' ? 'mouseDown' : 'mouseUp' })))
    const { dispatch, nativeInput } = dispatchOn(peer, contents)
    const page = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    await expect(dispatch('click', [page.nodes[0]!.ref])).resolves.toBeUndefined()

    expect(inputs(peer)).toEqual([['mouseMoved', 140, 55, 0], ['mousePressed', 140, 55, 1], ['mouseReleased', 140, 55, 1]])
    expect(peer.commands.filter(command => command.method === 'Runtime.callFunctionOn').map(command => String(command.params.functionDeclaration)),
      'the synthetic DOM click path is gone').not.toEqual(expect.arrayContaining([expect.stringContaining('this.click()')]))
    const scrolled = peer.commands.findIndex(command => String(command.params.functionDeclaration ?? '').includes('scrollIntoView'))
    const measured = peer.commands.findIndex(command => command.method === 'DOM.getContentQuads')
    expect(scrolled, 'geometry was read before the element was scrolled into view').toBeGreaterThanOrEqual(0)
    expect(scrolled).toBeLessThan(measured)
    // Every Input command was inside Main's receipt; outside it nothing is attributed to Main.
    expect(seen).toEqual([true, true, true])
    expect(isOwnDispatch(contents, { type: 'mouseDown' })).toBe(false)
    expect(nativeInput).toHaveBeenCalledTimes(1)
  })

  it('a covered target is refused before any input reaches the page, as not-dispatched', async () => {
    const peer = pagePeer({ topmost: 'cover' })
    const { dispatch, nativeInput } = dispatchOn(peer, nativeContents())
    const page = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    const failure = await dispatch('click', [page.nodes[0]!.ref]).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BrowserLocalRecoveryFailure)
    expect((failure as BrowserLocalRecoveryFailure).fact).toEqual({ kind: 'locator-changed', effects: 'not-dispatched' })
    expect((failure as Error).message).toMatch(/covers it|not the topmost/)
    expect(inputs(peer), 'a covered click still sent native input').toEqual([])
    expect(nativeInput).not.toHaveBeenCalled()
  })

  it('a hit test the transport refuses is not-dispatched and names the refusal, not a generic miss', async () => {
    const peer = pagePeer()
    const send = peer.session.sendCommand
    Reflect.set(peer.session, 'sendCommand', async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.getNodeForLocation') throw new Error('This request is outside the original shared-tab capability.')
      return await send(method, params)
    })
    const { dispatch, nativeInput } = dispatchOn(peer, nativeContents())
    const page = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    const failure = await dispatch('click', [page.nodes[0]!.ref]).catch((error: unknown) => error) as BrowserLocalRecoveryFailure
    expect(failure.fact).toEqual({ kind: 'locator-changed', effects: 'not-dispatched' })
    expect(failure.message).toContain('DOM.getNodeForLocation: This request is outside the original shared-tab capability.')
    expect(inputs(peer)).toEqual([])
    expect(nativeInput).not.toHaveBeenCalled()
  })

  it('a pointer that did not land on the target is never pressed', async () => {
    const peer = pagePeer({ landed: false })
    const { dispatch } = dispatchOn(peer, nativeContents())
    const page = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    const failure = await dispatch('click', [page.nodes[0]!.ref]).catch((error: unknown) => error)
    expect((failure as BrowserLocalRecoveryFailure).fact?.effects).toBe('not-dispatched')
    expect(inputs(peer).map(([type]) => type)).toEqual(['mouseMoved'])
  })

  it('a hidden page wakes for the action and goes back to its own visibility when the action ends', async () => {
    const peer = pagePeer(), contents = nativeContents()
    const during: boolean[] = []
    peer.onInput(() => during.push(contents.throttling))
    const { dispatch } = dispatchOn(peer, contents)
    const page = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    await dispatch('click', [page.nodes[0]!.ref])
    expect(during, 'Input reached a throttled page, which Chromium does not process while hidden').toEqual([false, false, false])
    expect(contents.throttling, 'the page was left awake after the action').toBe(true)
    expect(contents.captures, 'restoring throttling alone leaves a hidden page rendering').toBe(1)
  })
})

/**
 * A text field the dispatcher types into. `Input.insertText` replaces the selection the dispatcher's
 * own prepare step made (all of it for fill, a caret at the end for type); `format` lets a test model
 * a page that rewrites what was typed, and `deaf` a field that never receives the insert.
 */
function textPeer(options: { value?: string; format?: (value: string) => string; deaf?: boolean; readOnly?: boolean; noRange?: boolean } = {}) {
  const peer = pagePeer()
  const field = { value: options.value ?? 'old', selection: [0, 0] as [number, number], focused: false, restored: 0 }
  const send = peer.session.sendCommand
  const notes: string[] = []
  Reflect.set(peer.session, 'sendCommand', async (method: string, params: Record<string, any> = {}) => {
    if (method === 'Runtime.callFunctionOn') {
      const declaration = String(params.functionDeclaration)
      peer.commands.push({ method, params })
      if (declaration.includes('__agentMuxTextFocus = previous')) {
        if (options.readOnly) return { result: { value: { ok: false, reason: 'is read-only' } } }
        field.focused = true
        const replace = params.arguments?.[0]?.value === true
        if (replace) field.selection = [0, field.value.length]
        else if (!options.noRange) field.selection = [field.value.length, field.value.length]
        return { result: { value: { ok: true, before: field.value, caret: replace || !options.noRange ? 'set' : 'end-key' } } }
      }
      if (declaration.includes('restoreFocus(this, previous)')) { field.focused = false; field.restored += 1; return { result: { value: null } } }
      if (declaration.includes('isContentEditable ?')) return { result: { value: field.value } }
    }
    if (method === 'Input.insertText') {
      peer.commands.push({ method, params })
      if (!options.deaf) {
        const [start, end] = field.selection
        const next = field.value.slice(0, start) + params.text + field.value.slice(end)
        field.value = options.format ? options.format(next) : next
      }
      return {}
    }
    if (method === 'Input.dispatchKeyEvent') {
      peer.commands.push({ method, params })
      if (params.type === 'rawKeyDown' && params.key === 'End') field.selection = [field.value.length, field.value.length]
      if (params.type === 'rawKeyDown' && params.key === 'Delete') { const [start, end] = field.selection; field.value = field.value.slice(0, start) + field.value.slice(end) }
      return {}
    }
    return await send(method, params)
  })
  return { peer, field, notes }
}

function textDispatch(t: ReturnType<typeof textPeer>, contents = nativeContents()) {
  const nativeInput = vi.fn(async () => beginOwnDispatch(contents))
  const seen: boolean[] = []
  const dispatch = createBrowserPageDispatch({
    session: t.peer.session,
    pageInfo: () => ({ url: 'https://page.invalid/', title: 'Page', navigationId: 'nav-1' }),
    gotoUrl: async () => {}, captureScreenshot: async () => ({}), readLedger: async () => null,
    writeLedger: async () => {}, note: text => t.notes.push(text), beginNativeInput: nativeInput
  })
  t.peer.onInput(() => {})
  const sendCommand = t.peer.session.sendCommand
  Reflect.set(t.peer.session, 'sendCommand', async (method: string, params?: Record<string, unknown>) => {
    if (method.startsWith('Input.')) seen.push(isOwnDispatch(contents, { type: 'keyDown' }))
    return await sendCommand(method, params)
  })
  return { dispatch, nativeInput, seen }
}

const textInputs = (peer: ReturnType<typeof pagePeer>) => peer.commands.filter(command => command.method.startsWith('Input.'))
  .map(command => command.method === 'Input.insertText' ? ['insertText', command.params.text] : [command.params.type, command.params.key])

describe('Agent fill and type are trusted native text input, read back after', () => {
  it('fillInput selects everything, inserts the text natively, reads it back and returns focus', async () => {
    const t = textPeer({ value: 'old value' })
    const { dispatch, seen } = textDispatch(t)
    const page = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    await expect(dispatch('fillInput', [page.nodes[0]!.ref, 'new'])).resolves.toBeUndefined()
    expect(textInputs(t.peer)).toEqual([['insertText', 'new']])
    expect(t.field.value).toBe('new')
    expect(seen, 'text input was sent outside Main’s receipt').toEqual([true])
    expect(t.field.restored, 'page focus was not returned').toBe(1)
    expect(t.notes).toEqual([])
    expect(t.peer.commands.map(command => String(command.params.functionDeclaration ?? '')),
      'the synthetic value-setter path is still used').not.toEqual(expect.arrayContaining([expect.stringContaining("dispatchEvent(new Event('input'")]))
  })

  it('typeText appends at the end, and an input without a selection range moves its caret with a native End key', async () => {
    const t = textPeer({ value: 'abc' })
    const { dispatch } = textDispatch(t)
    const page = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    await dispatch('typeText', [page.nodes[0]!.ref, 'def'])
    expect(t.field.value).toBe('abcdef')
    expect(textInputs(t.peer)).toEqual([['insertText', 'def']])

    const n = textPeer({ value: '12', noRange: true })
    const numeric = textDispatch(n)
    const numericPage = await numeric.dispatch('snapshot', []) as { nodes: { ref: string }[] }
    await numeric.dispatch('typeText', [numericPage.nodes[0]!.ref, '3'])
    expect(n.field.value).toBe('123')
    expect(textInputs(n.peer)).toEqual([['rawKeyDown', 'End'], ['keyUp', 'End'], ['insertText', '3']])
  })

  it('an empty fill clears the field with a native delete; an empty type sends nothing', async () => {
    const t = textPeer({ value: 'abc' })
    const { dispatch } = textDispatch(t)
    const page = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    await dispatch('fillInput', [page.nodes[0]!.ref, ''])
    expect(t.field.value).toBe('')
    expect(textInputs(t.peer)).toEqual([['rawKeyDown', 'Delete'], ['keyUp', 'Delete']])
    const typed = textPeer({ value: 'abc' })
    const append = textDispatch(typed)
    const appendPage = await append.dispatch('snapshot', []) as { nodes: { ref: string }[] }
    await append.dispatch('typeText', [appendPage.nodes[0]!.ref, ''])
    expect(textInputs(typed.peer)).toEqual([])
  })

  it('text that never reached the field is not-dispatched; a read-only field is refused before typing', async () => {
    const t = textPeer({ value: 'kept', deaf: true })
    const { dispatch } = textDispatch(t)
    const page = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    const failure = await dispatch('fillInput', [page.nodes[0]!.ref, 'lost']).catch((error: unknown) => error) as BrowserLocalRecoveryFailure
    expect(failure.fact).toEqual({ kind: 'locator-changed', effects: 'not-dispatched' })
    expect(failure.message).toMatch(/did not reach .* value is unchanged/)
    expect(t.field.restored, 'focus was not returned after a failed insert').toBe(1)

    const r = textPeer({ readOnly: true })
    const readOnly = textDispatch(r)
    const readOnlyPage = await readOnly.dispatch('snapshot', []) as { nodes: { ref: string }[] }
    const refused = await readOnly.dispatch('fillInput', [readOnlyPage.nodes[0]!.ref, 'x']).catch((error: unknown) => error) as BrowserLocalRecoveryFailure
    expect(refused.fact?.effects).toBe('not-dispatched')
    expect(refused.message).toContain('is read-only')
    expect(textInputs(r.peer)).toEqual([])
    expect(readOnly.nativeInput).not.toHaveBeenCalled()
  })

  it('a page that reformats what was typed keeps the action and says the field holds a different value', async () => {
    const t = textPeer({ value: '', format: value => value.toUpperCase() })
    const { dispatch } = textDispatch(t)
    const page = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    await expect(dispatch('fillInput', [page.nodes[0]!.ref, 'abc'])).resolves.toBeUndefined()
    expect(t.field.value).toBe('ABC')
    expect(t.notes).toEqual([expect.stringContaining('holds a different value than was typed')])
  })
})

describe('Main’s receipt is the only judge of who sent an input', () => {
  const managers: InstanceType<typeof BrowserViewManager>[] = []
  afterEach(() => { for (const manager of managers.splice(0)) manager.dispose() })

  async function managed() {
    const views: any[] = []
    const window = { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      contentView: { addChildView(view: any) { views.push(view) }, removeChildView() {} },
      webContents: { isDestroyed: () => false, send() {} } }
    const manager = new BrowserViewManager(window as any, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:own-dispatch' },
      new BrowserRefLedgerStore('unused-own-dispatch-ledger'), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
    managers.push(manager)
    const pointer = vi.fn(() => true); manager.onNativeInput = pointer
    await manager.create('page', 'https://page.invalid/')
    manager.setBounds('page', { x: 10, y: 20, width: 400, height: 300 })
    const contents = views.find(view => view.webContents?.getURL() === 'https://page.invalid/')!.webContents as WebContents & EventEmitter
    const entry = (Reflect.get(manager, 'entries') as Map<string, { resourceRisk: Set<string> }>).get('page')!
    entry.resourceRisk.clear()
    return { manager, contents, entry, pointer }
  }

  it('Agent native input forwards nothing to native chrome and marks no document use; a person’s does', async () => {
    const m = await managed()
    const agent = beginOwnDispatch(m.contents)
    await agent.input(async () => { m.contents.emit('input-event', {}, { type: 'mouseMove', x: 5, y: 7 }); m.contents.emit('input-event', {}, { type: 'mouseDown', x: 5, y: 7, button: 'left' }) })
    agent.end()
    expect(m.pointer, 'Agent input was forwarded to native chrome as a person’s pointer').not.toHaveBeenCalled()
    expect([...m.entry.resourceRisk], 'Agent input counted as a person using the document').toEqual([])

    m.contents.emit('input-event', {}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(m.pointer).toHaveBeenCalledTimes(1)
    expect([...m.entry.resourceRisk]).toEqual(['document-used'])
  })

  it('Agent native input retires a pending person’s element picker instead of completing it', async () => {
    const m = await managed()
    // The picker script resolves only when the page delivers a trusted click; here that click is the Agent's.
    let pick!: (value: unknown) => void
    const scripts: string[] = []
    Reflect.set(m.contents, 'executeJavaScriptInIsolatedWorld', async (_world: number, code: { code: string }[]) => {
      scripts.push(code[0]!.code)
      return code[0]!.code.includes('Select an element') ? await new Promise(resolve => { pick = resolve }) : true
    })
    const selecting = m.manager.selectElement('page')
    await vi.waitFor(() => expect(scripts.some(code => code.includes('Select an element'))).toBe(true))
    const begin = Reflect.get(m.manager, 'beginAgentInput').bind(m.manager) as (entry: unknown, view: unknown) => Promise<{ end(): void }>
    const entries = Reflect.get(m.manager, 'entries') as Map<string, { view: unknown }>
    const agent = await begin(entries.get('page'), entries.get('page')!.view)
    expect(scripts.at(-1), 'the picker was not cancelled before Agent input').toContain('previous.cancel()')
    // The page answers the picker with the element the Agent's click landed on.
    pick({ pageTitle: 'Page', pageUrl: 'https://page.invalid/', tagName: 'button', role: 'button', accessibleName: 'Continue', selector: 'button',
      text: 'Continue', nearbyText: [], attributes: {}, html: '<button>Continue</button>',
      rectViewport: { x: 0, y: 0, width: 1, height: 1 }, rectPage: { x: 0, y: 0, width: 1, height: 1 }, isFixed: false })
    agent.end()
    await expect(selecting, 'the Agent click completed a person’s element selection').rejects.toThrow(/changed while an element was being selected/)
  })

  it('a person’s input while an Agent action is open but no Agent command is in flight is still the person’s', async () => {
    const m = await managed()
    const agent = beginOwnDispatch(m.contents)
    m.contents.emit('input-event', {}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    agent.end()
    expect(m.pointer).toHaveBeenCalledTimes(1)
    expect([...m.entry.resourceRisk]).toEqual(['document-used'])
  })
})

describe('Agent native input is never recorded as a human demonstration', () => {
  class Element { constructor(readonly ownerDocument: unknown, readonly backendNodeId: number) {} }
  class Page extends EventEmitter {
    attached = false
    listeners = new Map<string, (event: unknown) => void>()
    document = { addEventListener: (type: string, listener: (event: unknown) => void) => this.listeners.set(type, listener), removeEventListener: (type: string) => this.listeners.delete(type) }
    world = vm.createContext({ document: this.document, Element })
    debugger = Object.assign(new EventEmitter(), {
      attach: () => { this.attached = true }, detach: () => { this.attached = false }, isAttached: () => this.attached,
      sendCommand: async (method: string) => {
        if (method === 'Runtime.enable') this.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 7 } })
        return {}
      }
    })
    throttling = true
    isDestroyed() { return false }
    getBackgroundThrottling() { return this.throttling }
    setBackgroundThrottling(value: boolean) { this.throttling = value }
    async capturePage() {}
    async executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) { return vm.runInContext(scripts[0]!.code, this.world) as unknown }
    trusted(type: 'click' | 'input') { this.listeners.get(type)?.({ type, isTrusted: true, composedPath: () => [new Element(this.document, 11)] }) }
  }

  async function recording() {
    const page = new Page()
    let document: BrowserDemonstrationDocument | null = null
    const recorder = new BrowserDemonstrationRecorder({ load: async () => document, save: async next => { document = structuredClone(next) } })
    const warnings: string[] = []
    const capture = new BrowserDemonstrationCapture({ contents: page as unknown as WebContents, browserId: 'page', recorder,
      getIdentity: () => ({ navigationId: 'nav-1', url: 'https://page.invalid/', title: 'Page' }),
      onDraft: (_draft, warning) => { if (warning) warnings.push(warning) } })
    await capture.start()
    return { page, recorder, capture, warnings }
  }

  it('trusted clicks produced by Main’s own input leave the draft empty and say why', async () => {
    const r = await recording()
    const agent = beginOwnDispatch(r.page as unknown as WebContents)
    await agent.input(async () => { r.page.emit('input-event', {}, { type: 'mouseDown' }); r.page.emit('input-event', {}, { type: 'mouseUp' }); r.page.trusted('click') })
    agent.end()
    // A person's gesture arrives later and triggers the read of the queue that holds the Agent's click.
    r.page.emit('input-event', {}, { type: 'mouseUp' })
    await r.capture.flush()
    expect((await r.recorder.get('page'))?.steps, 'Agent click was recorded as a human demonstration').toEqual([])
    expect(r.warnings.at(-1)).toMatch(/Agent input reached this page while recording/)
    await r.capture.dispose()
  })

  it('a person’s trusted click with no Agent input since the last read is still recorded', async () => {
    const r = await recording()
    r.page.emit('input-event', {}, { type: 'mouseUp' }); r.page.trusted('click')
    await r.capture.flush()
    expect((await r.recorder.get('page'))?.steps).toEqual([expect.objectContaining({ method: 'click', source: 'native-human' })])
    await r.capture.dispose()
  })
})
