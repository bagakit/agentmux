import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { prepareWindowWorkbenchForQuit, registerWindowStatePersistence } from '../src/main/window-state-persistence.js'
import type { WindowGeometryStore } from '../src/main/window-geometry-store.js'
import type { WindowGeometry } from '../src/main/window-geometry.js'

/**
 * The window-owner registration that (1) captures geometry as the window changes and on close, and
 * (2) forces the renderer's localStorage to disk on close — the hard-shutdown flush path. Both are
 * main-process capabilities the old fixed-size / no-flush window skipped.
 *
 * Mutation intent:
 *  - deleting the flushStorageData() call must fail 'forces a renderer storage flush on close'.
 *  - dropping the 'close' geometry capture must fail 'captures geometry on close'.
 */

function fakeWindow() {
  const emitter = new EventEmitter()
  const flushStorageData = vi.fn()
  const bounds = { width: 1300, height: 900, x: 5, y: 7 }
  const window = Object.assign(emitter, {
    isDestroyed: () => false,
    isMaximized: () => false,
    getBounds: () => bounds,
    getNormalBounds: () => bounds,
    webContents: {
      isDestroyed: () => false,
      session: { flushStorageData }
    }
  }) as unknown as BrowserWindow
  return { emitter, flushStorageData, window, bounds }
}

function fakeStore() {
  const saved: WindowGeometry[] = []
  const store = {
    save: vi.fn(async (geometry: WindowGeometry) => { saved.push(geometry) })
  } as unknown as WindowGeometryStore
  return { store, saved }
}

describe('window state persistence owner', () => {
  it('forces a renderer storage flush on close so a hard shutdown keeps the last write', () => {
    const { emitter, flushStorageData, window } = fakeWindow()
    const { store } = fakeStore()
    registerWindowStatePersistence(window, store)

    emitter.emit('close')

    // This is the flush path criterion 3 asserts EXISTS: the renderer's localStorage is forced to
    // disk on unload. Deleting the flushStorageData() call makes this zero.
    expect(flushStorageData).toHaveBeenCalledTimes(1)
  })

  it('captures geometry on close', async () => {
    const { emitter, window } = fakeWindow()
    const { store, saved } = fakeStore()
    registerWindowStatePersistence(window, store)

    emitter.emit('close')
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(saved.at(-1)).toEqual({ width: 1300, height: 900, x: 5, y: 7, maximized: false })
  })

  it('captures geometry on settled resize and move gestures', async () => {
    const { emitter, window } = fakeWindow()
    const { store, saved } = fakeStore()
    registerWindowStatePersistence(window, store)

    emitter.emit('resized')
    emitter.emit('moved')
    await vi.waitFor(() => expect(saved.length).toBeGreaterThanOrEqual(2))
  })

  it('removes every owned listener when the window closes', () => {
    const { emitter, flushStorageData, window } = fakeWindow()
    const { store } = fakeStore()
    registerWindowStatePersistence(window, store)

    emitter.emit('closed')
    for (const event of ['resized', 'moved', 'maximize', 'unmaximize', 'close']) {
      expect(emitter.listenerCount(event)).toBe(0)
    }

    emitter.emit('close')
    expect(flushStorageData).not.toHaveBeenCalled()
  })
})

describe('window workbench quit preparation', () => {
  function quitWindow() {
    const contentsEvents = new EventEmitter()
    let crashed = false
    const executeJavaScript = vi.fn(async () => {})
    const window = {
      isDestroyed: () => false,
      webContents: Object.assign(contentsEvents, {
        isDestroyed: () => false,
        isCrashed: () => crashed,
        executeJavaScript
      })
    } as unknown as BrowserWindow
    return { window, contentsEvents, executeJavaScript, crash: () => { crashed = true; contentsEvents.emit('render-process-gone') } }
  }

  it('does not demand impossible JavaScript persistence from a crashed Renderer', async () => {
    const f = quitWindow()
    f.crash()
    await expect(prepareWindowWorkbenchForQuit(f.window)).resolves.toBeUndefined()
    expect(f.executeJavaScript).not.toHaveBeenCalled()
  })

  it('completes ordinary persistence while the Renderer is alive', async () => {
    const f = quitWindow()
    await prepareWindowWorkbenchForQuit(f.window)
    expect(f.executeJavaScript).toHaveBeenCalledWith('window.agentmuxPrepareRendererUpdate("quit")')
    expect(f.contentsEvents.listenerCount('render-process-gone')).toBe(0)
  })

  it('keeps a live Renderer save failure visible rather than pretending it died', async () => {
    const f = quitWindow()
    f.executeJavaScript.mockRejectedValueOnce(new Error('Storage is unavailable'))
    await expect(prepareWindowWorkbenchForQuit(f.window)).rejects.toThrow('Storage is unavailable')
    expect(f.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(f.contentsEvents.listenerCount('render-process-gone')).toBe(0)
  })

  it('releases a pending impossible save immediately when the Renderer actually goes away', async () => {
    const f = quitWindow()
    f.executeJavaScript.mockImplementationOnce(() => new Promise(() => {}))
    const preparing = prepareWindowWorkbenchForQuit(f.window)
    expect(f.executeJavaScript).toHaveBeenCalledTimes(1)
    f.crash()
    await preparing
    expect(f.contentsEvents.listenerCount('render-process-gone')).toBe(0)
  })
})
