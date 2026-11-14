import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { installNativeBrowserWindows } from '../src/main/browser-native-windows'

describe('original native new-page intent', () => {
  it.each(['foreground-tab', 'background-tab', 'new-window'] as const)('preserves %s alongside the exact Chromium Guest', disposition => {
    let handler: Parameters<WebContents['setWindowOpenHandler']>[0]
    const session = { original: true }
    const source = Object.assign(new EventEmitter(), { session, setWindowOpenHandler(value: typeof handler) { handler = value } })
    const guest = { originalGuest: true }, create = vi.fn(() => guest as unknown as WebContents)
    installNativeBrowserWindows(source as unknown as WebContents, { create, handOff: vi.fn(), report: vi.fn() })
    const outcome = handler!({ url: 'https://native.example.test/form', frameName: 'original-name', features: '',
      disposition, referrer: { url: 'https://native.example.test/source', policy: 'strict-origin-when-cross-origin' } })
    expect(outcome.action).toBe('allow')
    if (outcome.action !== 'allow') throw Error('Actual native request unexpectedly refused')
    const options = { webContents: guest, webPreferences: { session, javascript: false }, width: 420 }
    expect(outcome.createWindow!(options as unknown as Electron.BrowserWindowConstructorOptions)).toBe(guest)
    expect(create).toHaveBeenCalledExactlyOnceWith(options, { disposition })
    expect(source.listenerCount('-new-window')).toBeGreaterThan(0)
  })
  it('continues the original guestless form request once and never recreates a URL request', () => {
    let handler: Parameters<WebContents['setWindowOpenHandler']>[0]
    const session = { original: true }, nativeOptions = { javascript: false, sandbox: true }
    const source = Object.assign(new EventEmitter(), { session, setWindowOpenHandler(value: typeof handler) { handler = value },
      getLastWebPreferences: () => nativeOptions })
    const page = Object.assign(new EventEmitter(), { isDestroyed: () => false, close: vi.fn() }), navigate = vi.fn()
    const create = vi.fn(() => page as unknown as WebContents), report = vi.fn()
    let outcome!: ReturnType<typeof handler>
    // Electron's original listener invokes the handler inside this same dispatch.
    source.on('-new-window', () => { outcome = handler!({ url: 'https://native.example.test/post', frameName: 'named-form', features: '', disposition: 'foreground-tab', referrer: {url:'',policy:'default'} }) })
    installNativeBrowserWindows(source as unknown as WebContents, { create, handOff: vi.fn(), report })
    const envelope = { originalNativeDispatch: true }, form = { body: 'unsubmitted-native-body' }
    source.emit('-new-window', envelope, 'https://native.example.test/post', 'named-form', 'foreground-tab', '', {}, form, false, navigate)
    if (outcome!.action !== 'allow') throw Error('Actual native form request unexpectedly refused')
    expect(outcome!.action === 'allow' && outcome.createWindow!({ width: 500 })).toBe(page)
    expect(navigate).toHaveBeenCalledExactlyOnceWith(page)
    expect(create).toHaveBeenCalledExactlyOnceWith({width:500,webPreferences:{...nativeOptions,session}}, {disposition:'foreground-tab'})
    expect(report).not.toHaveBeenCalled()
  })
})
