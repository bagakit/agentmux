import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { NATIVE_OVERLAY_FOCUS_CHANNEL } from '../shared/native-overlay.js'
import type { NativeOverlaySurfaces } from './native-overlay-surfaces.js'
import type { WorkbenchWindowDocument } from '../shared/workbench-windows.js'

/** Only the original Chrome document can observe its own native projection's focus. */
export function installNativeOverlayFocus(window: BrowserWindow, overlays: Pick<NativeOverlaySurfaces, 'hasProjectionInFocusedWindow'>,
  scoped?: (document: WorkbenchWindowDocument) => Pick<NativeOverlaySurfaces, 'hasProjectionInFocusedWindow'>): () => void {
  const observe = (event: IpcMainEvent, document?: WorkbenchWindowDocument): void => {
    event.returnValue = false
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return
    try {
      event.returnValue = (document === undefined ? overlays : scoped?.(document))?.hasProjectionInFocusedWindow() === true
    } catch { /* Stale or unknown native documents do not certify focus. */ }
  }
  ipcMain.on(NATIVE_OVERLAY_FOCUS_CHANNEL, observe)
  return () => ipcMain.off(NATIVE_OVERLAY_FOCUS_CHANNEL, observe)
}
