import type { BrowserWindow } from 'electron'
import { geometryFromWindowState } from './window-geometry.js'
import type { WindowGeometryStore } from './window-geometry-store.js'

/**
 * Persist window-owned durable state as the window changes and before it goes away. Two jobs, both of
 * which only the main process can do, and both of which the fixed-1480×940 / no-flush code skipped:
 *
 * 1. Capture the window's geometry (size / position / maximized) into the durable store, so the next
 *    launch reopens where the user left it instead of at the literal default.
 * 2. On close, force the renderer's localStorage to disk via `session.flushStorageData()`. Zustand
 *    writes the layout to localStorage synchronously on every change, so the last drag is already in
 *    memory; what a hard shutdown loses is Chromium's *async* buffer-to-disk flush, and forcing that
 *    flush is a main-process capability a renderer `beforeunload` cannot substitute for.
 *
 * Returns a disposer that removes every listener, mirroring registerWindowResizeEvents so the two
 * window-owner registrations tear down the same way.
 */
export function registerWindowStatePersistence(
  window: BrowserWindow,
  geometryStore: WindowGeometryStore
): () => void {
  let disposed = false

  const captureGeometry = (): void => {
    if (disposed || window.isDestroyed()) return
    const geometry = geometryFromWindowState({
      bounds: window.getBounds(),
      normalBounds: window.getNormalBounds(),
      maximized: window.isMaximized()
    })
    // Fire-and-forget: a failed geometry write is a nicety lost, never a reason to block teardown or
    // surface an error to the user.
    void geometryStore.save(geometry).catch(() => {})
  }

  const flushRendererStorage = (): void => {
    if (window.webContents.isDestroyed()) return
    // Force Chromium to land the renderer's in-memory localStorage (the persisted layout) on disk
    // now, so a hard shutdown right after a drag does not lose that last write.
    window.webContents.session.flushStorageData()
  }

  const onClose = (): void => {
    captureGeometry()
    flushRendererStorage()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    window.removeListener('resized', captureGeometry)
    window.removeListener('moved', captureGeometry)
    window.removeListener('maximize', captureGeometry)
    window.removeListener('unmaximize', captureGeometry)
    window.removeListener('enter-full-screen', captureGeometry)
    window.removeListener('leave-full-screen', captureGeometry)
    window.removeListener('close', onClose)
    window.removeListener('closed', dispose)
  }

  // 'resized' / 'moved' are the settled end-of-gesture events (not the continuous 'resize' / 'move'),
  // so a normal drag records geometry once. 'close' is the definitive capture for the graceful path.
  window.on('resized', captureGeometry)
  window.on('moved', captureGeometry)
  window.on('maximize', captureGeometry)
  window.on('unmaximize', captureGeometry)
  window.on('enter-full-screen', captureGeometry)
  window.on('leave-full-screen', captureGeometry)
  window.on('close', onClose)
  window.once('closed', dispose)

  return dispose
}
