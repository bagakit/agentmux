import { startCaptureRequestTiming, type CaptureRequestTiming } from '../shared/capture-surface.js'
import { SCREENSHOT_SHORTCUTS, screenshotShortcutAccelerator, type ScreenshotShortcutStatus, type ScreenshotShortcutStatuses } from '../shared/screenshot-shortcut.js'

/** App-ready Main owner. A failed OS registration affects only that shortcut. */
export function registerScreenshotShortcut({ platform, shortcuts, request }: {
  platform: string
  shortcuts: { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void }
  request(background: (typeof SCREENSHOT_SHORTCUTS)[number]['background'], timing: CaptureRequestTiming): void
}): { status: ScreenshotShortcutStatuses; dispose(): void } {
  const owned = new Set<string>()
  const statuses = SCREENSHOT_SHORTCUTS.map(binding => {
    const accelerator = screenshotShortcutAccelerator(binding.chord)
    if (platform !== 'darwin') return { state: 'unsupported', accelerator, message: 'System screen capture is available on macOS.' } satisfies ScreenshotShortcutStatus
    try {
      if (shortcuts.register(accelerator, () => request(binding.background, startCaptureRequestTiming()))) {
        owned.add(accelerator)
        return { state: 'registered', accelerator } satisfies ScreenshotShortcutStatus
      }
      return { state: 'unavailable', accelerator, message: 'The system did not register this shortcut. Check other apps using the same keys, then reopen AgentMux. The Capture button remains available.' } satisfies ScreenshotShortcutStatus
    } catch (error) {
      return { state: 'unavailable', accelerator, message: `System shortcut registration failed: ${String(error)}. The Capture button remains available.` } satisfies ScreenshotShortcutStatus
    }
  })
  return { status: { ...statuses[0]!, alternate: statuses[1]! }, dispose() {
    for (const accelerator of owned) { owned.delete(accelerator); shortcuts.unregister(accelerator) }
  } }
}
