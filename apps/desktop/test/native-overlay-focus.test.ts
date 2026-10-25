// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { guardNativeOverlayBlur, NATIVE_OVERLAY_FOCUS_CHANNEL } from '../src/shared/native-overlay'
import { installNativeOverlayFocus } from '../src/main/native-overlay-focus'

const native = await vi.hoisted(async () => ({ main: new (await import('node:events')).EventEmitter(), query: vi.fn(),
  api: undefined as import('../src/shared/contracts').AgentMuxPreloadApi | undefined }))
vi.mock('electron', () => ({ ipcMain: native.main, ipcRenderer: { sendSync: native.query },
  contextBridge: { exposeInMainWorld: (_name: string, api: typeof native.api) => { native.api = api } }, webFrame: { getZoomFactor: () => 1 } }))

describe('native Chrome focus observation', () => {
  it('loads the original main-frame preload without a permanent synchronous blur query', async () => {
    const mainFrame = Object.getOwnPropertyDescriptor(process, 'isMainFrame')
    const listeners = vi.spyOn(window, 'addEventListener')
    Object.defineProperty(process, 'isMainFrame', { configurable: true, value: true })
    native.query.mockReset().mockReturnValue({ status: 'unavailable', message: 'No appearance fixture' })
    try {
      await import('../src/preload/index')
      expect(native.api?.ui.nativeOverlayFocus, 'The actual preload must expose its original API').toBeTypeOf('function')
      native.query.mockClear()
      for (const [type, listener] of listeners.mock.calls) if (type === 'blur' && typeof listener === 'function')
        listener({ target: window, isTrusted: true, stopImmediatePropagation: vi.fn() } as unknown as Event)
      expect(native.query, 'Preload alone cannot impose a synchronous query on ordinary window blur').not.toHaveBeenCalled()
      native.query.mockReturnValue(true)
      expect(native.api!.ui.nativeOverlayFocus()).toBe(true)
      expect(native.query).toHaveBeenLastCalledWith(NATIVE_OVERLAY_FOCUS_CHANNEL)
    } finally {
      for (const [type, listener, options] of listeners.mock.calls) window.removeEventListener(type, listener, options)
      listeners.mockRestore()
      if (mainFrame) Object.defineProperty(process, 'isMainFrame', mainFrame)
      else Reflect.deleteProperty(process, 'isMainFrame')
    }
  })

  it('answers only the original main document and releases its listener', () => {
    const contents = { mainFrame: {} }, window = { webContents: contents, isDestroyed: vi.fn(() => false) }
    const overlays = { hasProjectionInFocusedWindow: vi.fn(() => true) }
    const dispose = installNativeOverlayFocus(window as any, overlays as any)
    const read = (sender: unknown, senderFrame: unknown) => {
      const replies: unknown[] = []
      // Electron sends the synchronous reply on assignment; a later assignment cannot revise it.
      const event = { sender, senderFrame, set returnValue(value: unknown) { replies.push(value) } }
      native.main.emit(NATIVE_OVERLAY_FOCUS_CHANNEL, event)
      expect(replies).toHaveLength(1)
      return replies[0]
    }
    expect(read(contents, contents.mainFrame)).toBe(true)
    expect(read({}, contents.mainFrame)).toBe(false)
    expect(read(contents, {})).toBe(false)
    expect(overlays.hasProjectionInFocusedWindow).toHaveBeenCalledTimes(1)
    overlays.hasProjectionInFocusedWindow.mockReturnValue(false)
    expect(read(contents, contents.mainFrame)).toBe(false)
    overlays.hasProjectionInFocusedWindow.mockImplementationOnce(() => { throw new Error('Original projection owner unavailable') })
    expect(read(contents, contents.mainFrame)).toBe(false)
    window.isDestroyed.mockReturnValue(true)
    expect(read(contents, contents.mainFrame)).toBe(false)
    dispose()
    expect(native.main.listenerCount(NATIVE_OVERLAY_FOCUS_CHANNEL)).toBe(0)
  })

  it('preserves real window departure, element blur, synthetic blur and unavailable observations', () => {
    let observe!: (event: any) => void
    const target = { addEventListener: vi.fn((_type, handler) => { observe = handler }) }
    guardNativeOverlayBlur(target as any, () => native.query(NATIVE_OVERLAY_FOCUS_CHANNEL) === true)
    expect(target.addEventListener).toHaveBeenCalledWith('blur', expect.any(Function), true)
    const blur = (eventTarget: unknown = target, trusted = true) => {
      const event = { target: eventTarget, isTrusted: trusted, stopImmediatePropagation: vi.fn() }
      observe(event)
      return event.stopImmediatePropagation
    }
    let nativeWindowActive = true
    native.query.mockReset().mockImplementation(() => nativeWindowActive)
    expect(blur()).toHaveBeenCalledTimes(1)
    expect(native.query).toHaveBeenCalledWith(NATIVE_OVERLAY_FOCUS_CHANNEL)
    expect(blur({})).not.toHaveBeenCalled()
    expect(blur(target, false)).not.toHaveBeenCalled()
    expect(native.query).toHaveBeenCalledTimes(1)
    nativeWindowActive = false
    expect(blur()).not.toHaveBeenCalled()
    expect(native.query).toHaveBeenCalledTimes(2)
    for (const unknown of [undefined, 'true']) {
      native.query.mockReturnValue(unknown)
      expect(blur()).not.toHaveBeenCalled()
    }
    native.query.mockImplementation(() => { throw new Error('Native owner unavailable') })
    expect(blur()).not.toHaveBeenCalled()
  })
})
