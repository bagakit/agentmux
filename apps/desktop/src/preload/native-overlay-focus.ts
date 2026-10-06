import { ipcRenderer } from 'electron'
import { NATIVE_OVERLAY_FOCUS_CHANNEL } from '../shared/native-overlay.js'

/** A display-only sibling WebContents is not a departure from the App window. */
export function installNativeOverlayBlurGuard(target: Window): void {
  target.addEventListener('blur', event => {
    // Capture also sees element blur. Preserve that element's own editing lifecycle.
    if (event.target !== target || !event.isTrusted) return
    try {
      // Read the exact native owner now, before menu libraries consume this event.
      // An async answer would arrive after they had already discarded the menu.
      if (ipcRenderer.sendSync(NATIVE_OVERLAY_FOCUS_CHANNEL) === true) event.stopImmediatePropagation()
    } catch { /* An unconfirmed handoff retains ordinary window dismissal. */ }
  }, true)
}
