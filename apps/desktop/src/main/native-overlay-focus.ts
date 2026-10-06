import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { NATIVE_OVERLAY_FOCUS_CHANNEL } from '../shared/native-overlay.js'
import type { NativeOverlaySurfaces } from './native-overlay-surfaces.js'

/** Only the original Chrome document can observe its own native projection's focus. */
export function installNativeOverlayFocus(window: BrowserWindow, overlays: NativeOverlaySurfaces): () => void {
  const observe = (event: IpcMainEvent): void => {
    event.returnValue = !window.isDestroyed() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame && overlays.hasFocusedProjection()
  }
  ipcMain.on(NATIVE_OVERLAY_FOCUS_CHANNEL, observe)
  return () => ipcMain.off(NATIVE_OVERLAY_FOCUS_CHANNEL, observe)
}
