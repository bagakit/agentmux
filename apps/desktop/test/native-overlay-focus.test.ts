import { describe, expect, it, vi } from 'vitest'
import { NATIVE_OVERLAY_FOCUS_CHANNEL } from '../src/shared/native-overlay'
import { installNativeOverlayFocus } from '../src/main/native-overlay-focus'
import { installNativeOverlayBlurGuard } from '../src/preload/native-overlay-focus'

const native = await vi.hoisted(async () => ({ main: new (await import('node:events')).EventEmitter(), query: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: native.main, ipcRenderer: { sendSync: native.query } }))

describe('native Chrome focus observation', () => {
  it('answers only the original main document and releases its listener', () => {
    const contents = { mainFrame: {} }, window = { webContents: contents, isDestroyed: vi.fn(() => false) }
    const overlays = { hasFocusedProjection: vi.fn(() => true) }
    const dispose = installNativeOverlayFocus(window as any, overlays as any)
    const read = (sender: unknown, senderFrame: unknown) => {
      const event = { sender, senderFrame, returnValue: undefined }
      native.main.emit(NATIVE_OVERLAY_FOCUS_CHANNEL, event)
      return event.returnValue
    }
    expect(read(contents, contents.mainFrame)).toBe(true)
    expect(read({}, contents.mainFrame)).toBe(false)
    expect(read(contents, {})).toBe(false)
    expect(overlays.hasFocusedProjection).toHaveBeenCalledTimes(1)
    overlays.hasFocusedProjection.mockReturnValue(false)
    expect(read(contents, contents.mainFrame)).toBe(false)
    window.isDestroyed.mockReturnValue(true)
    expect(read(contents, contents.mainFrame)).toBe(false)
    dispose()
    expect(native.main.listenerCount(NATIVE_OVERLAY_FOCUS_CHANNEL)).toBe(0)
  })

  it('preserves real window departure, element blur, synthetic blur and unavailable observations', () => {
    let observe!: (event: any) => void
    const target = { addEventListener: vi.fn((_type, handler) => { observe = handler }) }
    installNativeOverlayBlurGuard(target as any)
    expect(target.addEventListener).toHaveBeenCalledWith('blur', expect.any(Function), true)
    const blur = (eventTarget: unknown = target, trusted = true) => {
      const event = { target: eventTarget, isTrusted: trusted, stopImmediatePropagation: vi.fn() }
      observe(event)
      return event.stopImmediatePropagation
    }
    native.query.mockReset().mockReturnValue(true)
    expect(blur()).toHaveBeenCalledTimes(1)
    expect(native.query).toHaveBeenCalledWith(NATIVE_OVERLAY_FOCUS_CHANNEL)
    expect(blur({})).not.toHaveBeenCalled()
    expect(blur(target, false)).not.toHaveBeenCalled()
    expect(native.query).toHaveBeenCalledTimes(1)
    for (const unknown of [false, undefined, 'true']) {
      native.query.mockReturnValue(unknown)
      expect(blur()).not.toHaveBeenCalled()
    }
    native.query.mockImplementation(() => { throw new Error('Native owner unavailable') })
    expect(blur()).not.toHaveBeenCalled()
  })
})
