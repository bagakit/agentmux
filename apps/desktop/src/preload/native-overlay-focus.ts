import { ipcRenderer } from 'electron'
import { guardNativeOverlayBlur, NATIVE_OVERLAY_FOCUS_CHANNEL } from '../shared/native-overlay.js'

/** A display-only sibling WebContents is not a departure from the App window. */
export function installNativeOverlayBlurGuard(target: Window): void {
  guardNativeOverlayBlur(target, () => ipcRenderer.sendSync(NATIVE_OVERLAY_FOCUS_CHANNEL) === true)
}
