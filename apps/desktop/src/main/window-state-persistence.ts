import type { BrowserWindow } from 'electron'
import { geometryFromWindowState } from './window-geometry.js'
import type { WindowGeometryStore } from './window-geometry-store.js'

/**
 * Persist window-owned durable state as the window changes and before it goes away. Two jobs, both of
 * which only the main process can do, and both of which the fixed-1480×940 / no-flush code skipped:
 *
 * 1. Capture the window's geometry (size / position / maximized) into the durable store, so the next
 *    launch reopens where the user left it instead of at the literal default.
 * 2. On close, ask Chromium to flush storage. This void API is a request, not a disk-write receipt.
 *    Ordinary application quit separately awaits the renderer's pending batch before owner disposal.
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
    // Chromium exposes no disk ACK for this request. Restart evidence reads the closed database.
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

/** One bounded preparation for this actual workbench window, before IPC or Runtime disposal. */
export async function prepareWindowWorkbenchForQuit(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      window.webContents.executeJavaScript('window.agentmuxPrepareRendererUpdate("quit")'),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The workbench save request did not respond within five seconds.')), 5_000)
      })
    ])
  } finally { clearTimeout(timer) }
}

/** Keep the original window and healthy Runs when the presentation save step is unconfirmed. */
export function reportWorkbenchQuitFailure(window: BrowserWindow, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  const message = `Quitting was paused because saving the workbench is unconfirmed. Your original window was kept; Agent input was not disabled by this save request. Restore storage access or wait for the current save, retry saving, then try Quit again. ${detail}`
  process.stderr.write(`${message}\n`)
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    void window.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('agentmux-workbench-save-error', { detail: ${JSON.stringify(message)} }))`
    ).catch(() => {})
  }
}
