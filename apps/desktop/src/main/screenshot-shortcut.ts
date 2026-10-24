import { SCREENSHOT_SHORTCUT_ACCELERATOR, type ScreenshotShortcutStatus } from '../shared/screenshot-shortcut.js'

/** App-ready Main owner. A failed OS registration affects only this shortcut. */
export function registerScreenshotShortcut({ platform, shortcuts, request }: {
  platform: string
  shortcuts: { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void }
  request(): void
}): { status: ScreenshotShortcutStatus; dispose(): void } {
  const accelerator = SCREENSHOT_SHORTCUT_ACCELERATOR
  let owned = false
  let status: ScreenshotShortcutStatus = { state: 'unsupported', accelerator, message: 'System screen capture is available on macOS.' }
  if (platform === 'darwin') {
    try {
      owned = shortcuts.register(accelerator, request)
      status = owned ? { state: 'registered', accelerator }
        : { state: 'unavailable', accelerator, message: 'The system did not register this shortcut. Check other apps using the same keys, then reopen AgentMux. The Capture button remains available.' }
    } catch (error) {
      status = { state: 'unavailable', accelerator, message: `System shortcut registration failed: ${String(error)}. The Capture button remains available.` }
    }
  }
  return { status, dispose() { if (owned) { owned = false; shortcuts.unregister(accelerator) } } }
}
